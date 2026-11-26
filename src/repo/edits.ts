import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, posix, resolve } from "node:path";
import type { CodeEdit } from "../plan/types.js";
import { resolveInRepo } from "./fsGuard.js";
import { keyRegex, listCodeFiles, readText } from "./search.js";

/**
 * Code edits for a landed flag (plan B6, cut list item 8): a deterministic codemod, no model. It understands the demo pattern
 *
 *     const variant = useVariant(FLAG_KEYS.someFlag);      // the flag read
 *     if (variant === "<key>") { ...; return A; }          // one or more variant branches
 *     return B;                                            // the control branch (fall through)
 *
 * and keeps the winning branch, deletes the losing ones and the flag read, then cleans up what that leaves behind: imports that
 * became unused, the flag key constant, tests of the deleted branches, and components nothing imports any more. Anything it does
 * not recognise is a refusal (CodemodError), never a guess. The output is exact-match edits: each `oldString` occurs once in the
 * file, and the plan carries the sha256 of every file before and after, so the edits sit inside the approved plan hash.
 */

export interface CodeEditContext {
  repoPath: string;
  flag: string;
  /** Variant key to keep, or null to keep control. */
  winnerKey: string | null;
  /** The value the control branch is tested with in code (the flag's initial value), when known. */
  controlKey?: string | null;
  /** Keys of every other arm: their branches are removed. */
  losingKeys: string[];
}

export interface CodeEditProvider {
  propose(ctx: CodeEditContext): Promise<CodeEdit[]>;
}

/** Default when no repo is configured: no code edits. */
export const noCodeEdits: CodeEditProvider = { propose: async () => [] };

export class CodemodError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodemodError";
  }
}

/** The plan's edits do not apply to the repo as it is now (file changed, text not unique, hash differs). Nothing was written. */
export class EditMismatch extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EditMismatch";
  }
}

export const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ---------------------------------------------------------------------------------------------------------------------
// Tiny scanner helpers (brace matching that skips strings and comments)

/** If a string literal or comment starts at i, the index after it; otherwise i. A quote with no closing quote on its line is plain text. */
function skipNonCode(t: string, i: number): number {
  const c = t[i];
  if (c === '"' || c === "'") {
    for (let k = i + 1; k < t.length; k++) {
      if (t[k] === "\\") k++;
      else if (t[k] === c) return k + 1;
      else if (t[k] === "\n") return i;
    }
    return i;
  }
  if (c === "`") {
    for (let k = i + 1; k < t.length; k++) {
      if (t[k] === "\\") k++;
      else if (t[k] === "`") return k + 1;
    }
    return i;
  }
  if (c === "/" && t[i + 1] === "/") {
    const e = t.indexOf("\n", i);
    return e < 0 ? t.length : e;
  }
  if (c === "/" && t[i + 1] === "*") {
    const e = t.indexOf("*/", i + 2);
    return e < 0 ? t.length : e + 2;
  }
  return i;
}

const OPEN = "{([";
const CLOSE = "})]";

/** Index of the bracket that closes the one at `open`, or -1. */
function matchClose(t: string, open: number): number {
  let depth = 0;
  for (let i = open; i < t.length; i++) {
    const j = skipNonCode(t, i);
    if (j !== i) {
      i = j - 1;
      continue;
    }
    if (OPEN.includes(t[i] as string)) depth++;
    else if (CLOSE.includes(t[i] as string) && --depth === 0) return i;
  }
  return -1;
}

/** Index of the first `}` at depth 0 at or after `from` (the end of the enclosing block), or -1. */
function enclosingClose(t: string, from: number): number {
  let depth = 0;
  for (let i = from; i < t.length; i++) {
    const j = skipNonCode(t, i);
    if (j !== i) {
      i = j - 1;
      continue;
    }
    const c = t[i] as string;
    if (OPEN.includes(c)) depth++;
    else if (CLOSE.includes(c)) {
      if (depth === 0) return c === "}" ? i : -1;
      depth--;
    }
  }
  return -1;
}

// ---------------------------------------------------------------------------------------------------------------------
// Aliases: how the flag key is spelled in code

export interface FlagAliases {
  /** Property names that hold the flag key, e.g. `checkoutCta` for `checkoutCta: "checkout_cta"`. */
  props: string[];
  /** Files that define them (flagKeys.ts). */
  defFiles: string[];
}

export function discoverAliases(repoRoot: string, flag: string, files = listCodeFiles(repoRoot)): FlagAliases {
  const props = new Set<string>();
  const defFiles: string[] = [];
  const re = new RegExp(`^[ \\t]*([A-Za-z_$][\\w$]*)\\s*:\\s*(["'])${esc(flag)}\\2\\s*,?[ \\t]*$`, "gm");
  for (const f of files) {
    const t = readText(repoRoot, f);
    if (!t) continue;
    let found = false;
    for (const m of t.text.matchAll(re)) {
      props.add(m[1] as string);
      found = true;
    }
    if (found) defFiles.push(f);
  }
  return { props: [...props].sort(), defFiles };
}

// ---------------------------------------------------------------------------------------------------------------------
// Applying steps to text (shared by the codemod and by the executor)

interface Step {
  oldString: string;
  newString: string;
  reason: string;
  del?: true;
}

function countOccurrences(text: string, needle: string): number {
  if (needle === "") return 0;
  let n = 0;
  for (let i = text.indexOf(needle); i >= 0; i = text.indexOf(needle, i + needle.length)) n++;
  return n;
}

/** Replace the single occurrence of `oldString`. Plain slicing, so `$` in the text is never special. */
function replaceOnce(path: string, text: string, oldString: string, newString: string): string {
  const n = countOccurrences(text, oldString);
  if (n !== 1) throw new EditMismatch(`${path}: the text to replace occurs ${n} times (expected exactly once). The file changed or the plan was edited.`);
  const at = text.indexOf(oldString);
  return text.slice(0, at) + newString + text.slice(at + oldString.length);
}

// ---------------------------------------------------------------------------------------------------------------------
// The codemod

interface Decision {
  winnerKey: string | null;
  controlKey: string | null;
  losingKeys: string[];
  keptKey: string | null;
}

interface Region {
  start: number;
  end: number;
  replacement: string;
}

function dedent(body: string, baseIndent: string): string {
  const lines = body.replace(/^[ \t]*\n/, "").replace(/\s+$/, "").split("\n");
  const indents = lines.filter((l) => l.trim() !== "").map((l) => (/^[ \t]*/.exec(l) as RegExpExecArray)[0].length);
  const delta = Math.max(0, (indents.length ? Math.min(...indents) : 0) - baseIndent.length);
  return lines.map((l) => (/^[ \t]*$/.test(l.slice(0, delta)) ? l.slice(delta) : l)).join("\n");
}

/**
 * True when the LAST top-level statement of a block body is a `return`, so the branch always leaves the function. A `return`
 * nested in an inner `if` does not count: `if (x) { return A; } log();` falls through, and deleting what follows it would
 * change behaviour. Statement boundaries are a `;` or a `}` closing back to depth 0 at the end of a line; strings and comments are skipped.
 */
function endsInReturn(body: string): boolean {
  const lead = (s: string): string => s.replace(/^(?:\s|\/\/[^\n]*|\/\*[\s\S]*?\*\/)+/, "").trim();
  let depth = 0;
  let start = 0;
  let last = "";
  const cut = (k: number): void => {
    // Only at the end of a line: a `;` inside JSX text (`&apos;`) is not a statement end. Two statements on one line then
    // read as one that starts with the first, which fails closed.
    const eol = body.indexOf("\n", k);
    if (!/^[ \t]*(?:\/\/.*)?$/.test(body.slice(k, eol < 0 ? body.length : eol))) return;
    const seg = lead(body.slice(start, k));
    if (seg !== "" && seg !== ";") last = seg;
    start = k;
  };
  for (let i = 0; i < body.length; i++) {
    const j = skipNonCode(body, i);
    if (j !== i) {
      i = j - 1;
      continue;
    }
    const c = body[i] as string;
    if (OPEN.includes(c)) depth++;
    else if (CLOSE.includes(c)) {
      depth--;
      if (depth < 0) return false;
      if (depth === 0 && c === "}") cut(i + 1);
    } else if (c === ";" && depth === 0) cut(i + 1);
  }
  cut(body.length);
  return /^return\b/.test(last);
}

/** Find the flag reads in a component and decide, per read, what replaces it. */
function componentRegions(path: string, src: string, readRe: RegExp, d: Decision): Region[] {
  const regions: Region[] = [];
  for (const m of src.matchAll(readRe)) {
    const indent = m[1] as string;
    const varName = m[2] as string;
    let pos = (m.index as number) + m[0].length;
    const ifs: { key: string; body: string }[] = [];
    const ifRe = new RegExp(`^if\\s*\\(\\s*${esc(varName)}\\s*===\\s*(["'])(.*?)\\1\\s*\\)\\s*\\{`);
    for (;;) {
      const ws = (/^\s*/.exec(src.slice(pos)) as RegExpExecArray)[0].length;
      const im = ifRe.exec(src.slice(pos + ws));
      if (!im) break;
      const open = pos + ws + im[0].length - 1;
      const close = matchClose(src, open);
      if (close < 0) throw new CodemodError(`${path}: unbalanced braces after the flag read`);
      ifs.push({ key: im[2] as string, body: src.slice(open + 1, close) });
      pos = close + 1;
    }
    if (ifs.length === 0) throw new CodemodError(`${path}: the flag is read but not followed by \`if (${varName} === "<variant>") { ... }\`; not a pattern the codemod knows`);
    const fnEnd = enclosingClose(src, pos);
    if (fnEnd < 0) throw new CodemodError(`${path}: cannot find the end of the function that reads the flag`);
    const tail = src.slice(pos, fnEnd);
    if (/^\s*else\b/.test(tail)) throw new CodemodError(`${path}: \`else\` after the variant branch is not supported`);
    const lineStart = src.lastIndexOf("\n", fnEnd - 1) + 1;
    if (src.slice(lineStart, fnEnd).trim() !== "") throw new CodemodError(`${path}: the function's closing brace shares a line with code`);

    const known = new Set<string>([...d.losingKeys, ...(d.keptKey ? [d.keptKey] : [])]);
    for (const i of ifs) {
      if (!known.has(i.key)) throw new CodemodError(`${path}: branch for "${i.key}" is not one of this experiment's arms (${[...known].join(", ")}); refusing to guess`);
      if (!endsInReturn(i.body)) throw new CodemodError(`${path}: the branch for "${i.key}" does not return, so deleting what follows it would change behaviour`);
    }
    const keepIf = d.keptKey !== null ? ifs.find((i) => i.key === d.keptKey) : undefined;
    let kept: string;
    if (keepIf) {
      kept = dedent(keepIf.body, indent);
    } else if (d.winnerKey === null) {
      kept = tail.replace(/^\s*\n/, "").replace(/\s+$/, "");
      if (kept.trim() === "") throw new CodemodError(`${path}: control wins but nothing follows the variant branches to keep`);
    } else {
      throw new CodemodError(`${path}: the winner "${d.winnerKey}" is not tested here, and only a control winner can be the fall-through branch`);
    }
    if (new RegExp(`(?<![\\w$.])${esc(varName)}(?![\\w$])`).test(kept)) {
      throw new CodemodError(`${path}: the kept branch still uses the variable "${varName}"`);
    }
    regions.push({ start: m.index as number, end: lineStart, replacement: `${kept}\n` });
  }
  return regions;
}

function applyRegions(src: string, regions: Region[]): string {
  let out = "";
  let at = 0;
  for (const r of [...regions].sort((a, b) => a.start - b.start)) {
    if (r.start < at) throw new CodemodError("overlapping flag reads in one file");
    out += src.slice(at, r.start) + r.replacement;
    at = r.end;
  }
  return out + src.slice(at);
}

const IMPORT_RE = /^import\s+(type\s+)?\{([^}]*)\}\s*from\s*(["'])([^"']+)\3\s*;?[ \t]*\n?/gm;

/** Imports whose names we just made unused: the edits to drop or shrink them, and the relative modules fully dropped. */
function importCleanup(before: string, after: string): { steps: Step[]; droppedModules: string[] } {
  const strip = (t: string): string => t.replace(IMPORT_RE, "");
  const bodyBefore = strip(before);
  const bodyAfter = strip(after);
  const used = (body: string, name: string): boolean => new RegExp(`(?<![\\w$.])${esc(name)}(?![\\w$])`).test(body);
  const steps: Step[] = [];
  const droppedModules: string[] = [];
  for (const m of after.matchAll(IMPORT_RE)) {
    const names = (m[2] as string)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const keep = names.filter((n) => {
      const local = (/\bas\s+([\w$]+)$/.exec(n)?.[1] ?? n.replace(/^type\s+/, "")).trim();
      return !(used(bodyBefore, local) && !used(bodyAfter, local));
    });
    if (keep.length === names.length) continue;
    const spec = `${m[3]}${m[4]}${m[3]}`;
    const text = m[0];
    if (keep.length === 0) {
      steps.push({ oldString: text, newString: "", reason: "remove an import that is no longer used" });
      if ((m[4] as string).startsWith(".")) droppedModules.push(m[4] as string);
    } else {
      const next = `import ${m[1] ?? ""}{ ${keep.join(", ")} } from ${spec};${text.endsWith("\n") ? "\n" : ""}`;
      steps.push({ oldString: text, newString: next, reason: "drop unused names from an import" });
    }
  }
  return { steps, droppedModules };
}

interface TestBlock {
  start: number;
  end: number;
  text: string;
}

function testBlocks(src: string): TestBlock[] {
  const out: TestBlock[] = [];
  for (const m of src.matchAll(/^[ \t]*(?:it|test)\(/gm)) {
    const open = (m.index as number) + m[0].length - 1;
    const close = matchClose(src, open);
    if (close < 0) continue;
    const eol = src.indexOf("\n", close);
    const rest = src.slice(close + 1, eol < 0 ? src.length : eol);
    if (!/^\s*;?\s*$/.test(rest)) continue;
    out.push({ start: m.index as number, end: eol < 0 ? src.length : eol + 1, text: src.slice(m.index as number, eol < 0 ? src.length : eol + 1) });
  }
  return out;
}

/** Test file edits: drop tests of deleted branches, take the flag out of the tests that stay. */
function testSteps(path: string, src: string, flag: string, d: Decision): { steps: Step[]; deleteFile: boolean } {
  const blocks = testBlocks(src);
  const keyEntry = `["']?(?<![\\w-])${esc(flag)}(?![\\w-])["']?\\s*:\\s*\\{[^{}]*\\}`;
  const valueRe = new RegExp(`(?<![\\w-])${esc(flag)}["']?\\s*:\\s*\\{[^{}]*?\\bvalue\\s*:\\s*(["'\`])(.*?)\\1`, "g");
  const steps: Step[] = [];
  let removed = 0;
  for (const b of blocks) {
    const mentions = keyRegex(flag, "").test(b.text);
    const values = [...b.text.matchAll(valueRe)].map((x) => x[2] as string);
    let drop: string | null = null;
    let rewritten: string | null = null;
    if (mentions) {
      if (values.length === 0) throw new CodemodError(`${path}: a test mentions the flag in a form the codemod does not know (expected \`${flag}: { value: "..." }\`)`);
      const losing = values.find((v) => d.losingKeys.includes(v));
      if (losing !== undefined) drop = `remove the test of the deleted branch "${losing}"`;
      else if (values.every((v) => v === d.keptKey)) {
        const whole = new RegExp(`\\{\\s*${keyEntry}\\s*,?\\s*\\}`);
        rewritten = whole.test(b.text)
          ? b.text.replace(whole, "{}")
          : b.text.replace(new RegExp(`[ \\t]*${keyEntry}\\s*,?[ \\t]*\\n?`), "");
      } else {
        throw new CodemodError(`${path}: a test sets the flag to ${values.map((v) => `"${v}"`).join(", ")}, which is not an arm of this experiment`);
      }
    } else if (d.winnerKey !== null && /,\s*\{\s*\}\s*\)/.test(b.text)) {
      drop = "remove the test of the flag-missing fallback (it asserted the control branch, which is deleted)";
    }
    if (drop !== null) {
      removed++;
      // take one neighbouring blank line with it so the file keeps its spacing
      let s = b.start;
      let e = b.end;
      if (src.slice(Math.max(0, s - 2), s) === "\n\n") s -= 1;
      else if (src[e] === "\n") e += 1;
      steps.push({ oldString: src.slice(s, e), newString: "", reason: drop });
    } else if (rewritten !== null && rewritten !== b.text) {
      steps.push({ oldString: b.text, newString: rewritten, reason: `the test no longer needs the flag: it always gets the "${d.keptKey ?? "control"}" behaviour` });
    }
  }
  return { steps, deleteFile: blocks.length > 0 && removed === blocks.length };
}

function finalize(path: string, orig: string, steps: Step[]): { edits: CodeEdit[]; result: string | null } {
  if (steps.length === 0) return { edits: [], result: orig };
  const base = sha256(orig);
  if (steps.length === 1 && steps[0]?.del) {
    const s = steps[0];
    return { edits: [{ path, oldString: orig, newString: "", reason: s.reason, baseSha256: base, resultSha256: sha256(""), delete: true }], result: null };
  }
  let cur = orig;
  for (const s of steps) cur = replaceOnce(path, cur, s.oldString, s.newString);
  const res = sha256(cur);
  return { edits: steps.map((s) => ({ path, oldString: s.oldString, newString: s.newString, reason: s.reason, baseSha256: base, resultSha256: res })), result: cur };
}

/** Resolve a relative import to the extensionless path it names, repo relative. */
const resolveSpec = (fromFile: string, spec: string): string => posix.normalize(posix.join(posix.dirname(fromFile), spec)).replace(/\.[cm]?[jt]sx?$/, "");
const stemOf = (p: string): string => p.replace(/\.[cm]?[jt]sx?$/, "");

function importersOf(texts: Map<string, string | null>, target: string): string[] {
  const out: string[] = [];
  const stem = stemOf(target);
  for (const [file, text] of texts) {
    if (text === null || file === target) continue;
    for (const m of text.matchAll(/(?:from\s*|import\s*\(\s*|import\s+)(["'])(\.[^"']*)\1/g)) {
      const r = resolveSpec(file, m[2] as string);
      if (r === stem || `${r}/index` === stem) out.push(file);
    }
  }
  return out;
}

const isTestFile = (p: string): boolean => /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(p);

/**
 * Compute the exact-match edits that land `flag` in the repo. Throws CodemodError for anything it does not understand; returns
 * an empty list when no code file references the flag.
 */
export function computeCodeEdits(ctx: CodeEditContext): CodeEdit[] {
  const root = resolve(ctx.repoPath);
  if (!existsSync(root)) throw new CodemodError(`LANDER_REPO_PATH does not exist: ${root}`);
  const files = listCodeFiles(root);
  const texts = new Map<string, string | null>();
  for (const f of files) texts.set(f, readText(root, f)?.text ?? null);

  const { props, defFiles } = discoverAliases(root, ctx.flag, files);
  const d: Decision = {
    winnerKey: ctx.winnerKey,
    controlKey: ctx.controlKey ?? null,
    losingKeys: ctx.losingKeys.filter((k) => k !== ctx.winnerKey),
    keptKey: ctx.winnerKey ?? ctx.controlKey ?? null,
  };
  const refs = [`"${ctx.flag}"`, `'${ctx.flag}'`, ...props.map((p) => `[A-Za-z_$][\\w$]*\\.${esc(p)}`)];
  const refAlt = refs.map((r) => (r.startsWith("[") ? r : esc(r))).join("|");
  const readRe = new RegExp(`^([ \\t]*)(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*[A-Za-z_$][\\w$.]*\\(\\s*(?:${refAlt})\\s*\\)\\s*;?[ \\t]*\\n`, "gm");
  const mentionRe = (): RegExp => new RegExp(`(?<![\\w-])${esc(ctx.flag)}(?![\\w-])${props.length ? `|\\.(?:${props.map(esc).join("|")})(?![\\w$])` : ""}`);

  const stepsByFile = new Map<string, Step[]>();
  const droppedModules: { file: string; spec: string }[] = [];
  const deletedFiles = new Set<string>();

  for (const f of files) {
    const orig = texts.get(f);
    if (orig == null || defFiles.includes(f) || !mentionRe().test(orig)) continue;
    if (isTestFile(f)) {
      const { steps, deleteFile } = testSteps(f, orig, ctx.flag, d);
      if (deleteFile) {
        stepsByFile.set(f, [{ oldString: orig, newString: "", reason: "every test in this file covered the deleted branches", del: true }]);
        deletedFiles.add(f);
        texts.set(f, null);
        continue;
      }
      let cur = orig;
      for (const s of steps) cur = replaceOnce(f, cur, s.oldString, s.newString);
      const imp = importCleanup(orig, cur);
      for (const s of imp.steps) cur = replaceOnce(f, cur, s.oldString, s.newString);
      if (mentionRe().test(cur)) throw new CodemodError(`${f}: still mentions the flag after the codemod`);
      stepsByFile.set(f, [...steps, ...imp.steps]);
      texts.set(f, cur);
      continue;
    }
    const regions = componentRegions(f, orig, readRe, d);
    if (regions.length === 0) throw new CodemodError(`${f}: mentions the flag but has no flag read the codemod knows (\`const x = useVariant(KEY)\`); refusing to guess`);
    const steps: Step[] = regions.map((r) => ({
      oldString: orig.slice(r.start, r.end),
      newString: r.replacement,
      reason: d.winnerKey === null
        ? `keep the control behaviour, delete the "${d.losingKeys.join('", "')}" branch(es) and the flag read`
        : `keep the "${d.winnerKey}" branch, delete the losing branch(es) and the flag read`,
    }));
    let cur = applyRegions(orig, regions);
    const imp = importCleanup(orig, cur);
    for (const s of imp.steps) cur = replaceOnce(f, cur, s.oldString, s.newString);
    for (const spec of imp.droppedModules) droppedModules.push({ file: f, spec });
    if (mentionRe().test(cur)) throw new CodemodError(`${f}: still mentions the flag after the codemod`);
    stepsByFile.set(f, [...steps, ...imp.steps]);
    texts.set(f, cur);
  }
  if (stepsByFile.size === 0) return [];

  // The flag key constant goes once nothing refers to it.
  for (const f of defFiles) {
    const orig = texts.get(f);
    if (orig == null) continue;
    const steps: Step[] = [];
    for (const prop of props) {
      const line = new RegExp(`^[ \\t]*${esc(prop)}\\s*:\\s*(["'])${esc(ctx.flag)}\\1\\s*,?[ \\t]*\\n`, "m").exec(orig);
      const stillUsed = [...texts].some(([p, t]) => t !== null && !defFiles.includes(p) && new RegExp(`\\.${esc(prop)}(?![\\w$])`).test(t));
      if (line && !stillUsed) steps.push({ oldString: line[0], newString: "", reason: "remove the flag key constant: nothing refers to it any more" });
    }
    if (steps.length > 0) stepsByFile.set(f, steps);
  }

  // Components that only the deleted branches imported.
  for (const { file, spec } of droppedModules) {
    const target = files.find((p) => stemOf(p) === resolveSpec(file, spec) || `${stemOf(p)}` === `${resolveSpec(file, spec)}/index`);
    if (!target || target === file || isTestFile(target) || defFiles.includes(target) || deletedFiles.has(target) || stepsByFile.has(target)) continue;
    const text = texts.get(target);
    if (text == null || importersOf(texts, target).length > 0) continue;
    stepsByFile.set(target, [{ oldString: text, newString: "", reason: "delete a component that only the removed branch imported", del: true }]);
    texts.set(target, null);
  }

  const edits: CodeEdit[] = [];
  for (const path of [...stepsByFile.keys()].sort()) {
    const orig = readText(root, path)?.text as string;
    edits.push(...finalize(path, orig, stepsByFile.get(path) as Step[]).edits);
  }
  return edits;
}

export const codemodEdits: CodeEditProvider = { propose: async (ctx) => computeCodeEdits(ctx) };

// ---------------------------------------------------------------------------------------------------------------------
// Applying plan edits to a repo (used by the executor)

export interface FileChange {
  path: string;
  before: string;
  /** Null: the file is deleted. */
  after: string | null;
  crlf: boolean;
}

/**
 * Check that the plan's edits apply to the repo exactly as they were planned, and compute the new files without writing
 * anything. Throws EditMismatch (or FsGuardError for a bad path) at the first problem.
 */
export function verifyEdits(repoRoot: string, edits: CodeEdit[]): FileChange[] {
  const byPath = new Map<string, CodeEdit[]>();
  for (const e of edits) byPath.set(e.path, [...(byPath.get(e.path) ?? []), e]);
  const changes: FileChange[] = [];
  for (const [path, list] of byPath) {
    resolveInRepo(repoRoot, path);
    const file = readText(repoRoot, path);
    if (!file) throw new EditMismatch(`${path}: cannot be read (missing, too large or not text). The repo changed since the plan.`);
    const first = list[0] as CodeEdit;
    if (list.some((e) => e.baseSha256 !== first.baseSha256 || e.resultSha256 !== first.resultSha256)) {
      throw new EditMismatch(`${path}: the plan's edits for this file disagree about its hashes`);
    }
    if (sha256(file.text) !== first.baseSha256) {
      throw new EditMismatch(`${path}: the file is not what it was when the plan was made (hash differs). Run lander land again.`);
    }
    if (list.some((e) => e.delete)) {
      if (list.length !== 1 || list[0]?.oldString !== file.text || list[0]?.newString !== "") throw new EditMismatch(`${path}: a delete edit must be the only edit and carry the whole file`);
      if (first.resultSha256 !== sha256("")) throw new EditMismatch(`${path}: delete edit has the wrong result hash`);
      changes.push({ path, before: file.text, after: null, crlf: file.crlf });
      continue;
    }
    let cur = file.text;
    for (const e of list) cur = replaceOnce(path, cur, e.oldString, e.newString);
    if (sha256(cur) !== first.resultSha256) throw new EditMismatch(`${path}: the edited file does not match the planned result hash`);
    changes.push({ path, before: file.text, after: cur, crlf: file.crlf });
  }
  return changes;
}

/** Write verified changes. Keeps each file's original line endings. */
export function writeChanges(repoRoot: string, changes: FileChange[]): void {
  for (const c of changes) {
    const abs = resolveInRepo(repoRoot, c.path);
    if (c.after === null) {
      rmSync(abs);
      continue;
    }
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, c.crlf ? c.after.replace(/\n/g, "\r\n") : c.after, "utf8");
  }
}
