import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { isDeniedPath } from "./fsGuard.js";

/** Pure Node repo search, no ripgrep dependency. Never reads denied paths (see fsGuard). */

const SKIP_DIRS = new Set(["node_modules", ".git", ".lander", "dist", "build", "coverage", ".next", ".turbo", ".vite"]);
const CODE_EXT = /\.(?:[cm]?[jt]sx?)$/;
const TEXT_EXT = /\.(?:[cm]?[jt]sx?|json|html?|css|scss|ya?ml|toml|txt|svg)$/;
const SKIP_FILES = new Set(["pnpm-lock.yaml", "package-lock.json", "yarn.lock"]);
const MAX_BYTES = 512 * 1024;

export interface RepoFile {
  /** Repo relative, forward slashes. */
  path: string;
}

function walk(root: string, dir: string, out: string[]): void {
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = dir === "" ? entry.name : `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(root, rel, out);
    } else if (entry.isFile() && !isDeniedPath(rel)) {
      out.push(rel);
    }
  }
}

/** Source files (ts, tsx, js, jsx, ...) in the repo, sorted. */
export function listCodeFiles(repoRoot: string): string[] {
  const all: string[] = [];
  walk(resolve(repoRoot), "", all);
  return all.filter((p) => CODE_EXT.test(p) && !p.endsWith(".d.ts"));
}

/** Text files worth scanning for leftovers: code plus json, html, css, yaml. Lock files and markdown are skipped. */
export function listTextFiles(repoRoot: string): string[] {
  const all: string[] = [];
  walk(resolve(repoRoot), "", all);
  return all.filter((p) => TEXT_EXT.test(p) && !SKIP_FILES.has(p.split("/").pop() ?? ""));
}

/** Read as text with LF line endings. Returns the original line ending style too. Null when too large or unreadable. */
export function readText(repoRoot: string, rel: string): { text: string; crlf: boolean } | null {
  const abs = join(resolve(repoRoot), rel);
  try {
    if (statSync(abs).size > MAX_BYTES) return null;
    const raw = readFileSync(abs, "utf8");
    const crlf = raw.includes("\r\n");
    return { text: crlf ? raw.replace(/\r\n/g, "\n") : raw, crlf };
  } catch {
    return null;
  }
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Regex for a flag or variant key as a whole token: not glued to word characters or hyphens. */
export const keyRegex = (key: string, flags = "g"): RegExp => new RegExp(`(?<![\\w-])${escapeRe(key)}(?![\\w-])`, flags);

export interface Hit {
  path: string;
  line: number;
  term: string;
  text: string;
}

/** Every line in the repo's text files that still mentions one of `terms` (whole token), or `.prop` member access for `props`. */
export function findHits(repoRoot: string, terms: string[], props: string[] = [], onlyFiles?: string[]): Hit[] {
  const regs: { term: string; re: RegExp }[] = [
    ...terms.filter(Boolean).map((t) => ({ term: t, re: keyRegex(t, "") })),
    ...props.filter(Boolean).map((p) => ({ term: `.${p}`, re: new RegExp(`\\.${escapeRe(p)}(?![\\w$])`) })),
  ];
  const hits: Hit[] = [];
  for (const path of onlyFiles ?? listTextFiles(repoRoot)) {
    const file = readText(repoRoot, path);
    if (!file) continue;
    file.text.split("\n").forEach((line, i) => {
      for (const { term, re } of regs) if (re.test(line)) hits.push({ path, line: i + 1, term, text: line.trim().slice(0, 160) });
    });
  }
  return hits;
}

/** The residue check of plan B6 step 3. Empty array means clean. */
export const residueCheck = (repoRoot: string, terms: string[], props: string[] = []): Hit[] => findHits(repoRoot, terms, props);
