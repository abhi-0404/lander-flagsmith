import { isAbsolute, relative, resolve, sep } from "node:path";

/**
 * Repo-root jail, deny list and secret redaction (safety finding S2). Everything that touches the target repo goes through
 * `resolveInRepo`; everything that can reach a PR body goes through `redactSecrets`.
 */

export class FsGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FsGuardError";
  }
}

const DENIED_SEGMENTS = new Set([".git", ".lander", "node_modules"]);
const DENIED_FILE = /^\.env(\..*)?$/i;
const DENIED_EXT = /\.(pem|key|p12|pfx|crt)$/i;

/** True for paths Lander must never read, edit or list: `.env*`, `.git/`, `.lander/`, `node_modules/`, key files. */
export function isDeniedPath(rel: string): boolean {
  const parts = rel.split(/[\\/]+/).filter(Boolean);
  if (parts.some((p) => DENIED_SEGMENTS.has(p))) return true;
  const base = parts[parts.length - 1] ?? "";
  if (base === ".env.example") return false;
  return DENIED_FILE.test(base) || DENIED_EXT.test(base);
}

/** A repo-relative path with forward slashes: no absolute path, no `..`, no NUL, not denied. Returns the normalized form. */
export function assertSafeRelPath(rel: string): string {
  if (typeof rel !== "string" || rel === "" || rel.includes("\0")) throw new FsGuardError(`Unsafe path: ${JSON.stringify(rel)}`);
  if (isAbsolute(rel) || /^[A-Za-z]:/.test(rel) || rel.startsWith("/") || rel.startsWith("\\")) {
    throw new FsGuardError(`Path must be relative to the repo: ${JSON.stringify(rel)}`);
  }
  const parts = rel.split(/[\\/]/);
  if (parts.some((p) => p === ".." || p === "." || p === "")) throw new FsGuardError(`Path must not contain "..", "." or empty segments: ${JSON.stringify(rel)}`);
  if (isDeniedPath(rel)) throw new FsGuardError(`Path is on the deny list (.env, .git, .lander, node_modules, key files): ${JSON.stringify(rel)}`);
  return parts.join("/");
}

/** Absolute path of `rel` inside `repoRoot`; throws when it would leave the root. */
export function resolveInRepo(repoRoot: string, rel: string): string {
  const safe = assertSafeRelPath(rel);
  const root = resolve(repoRoot);
  const abs = resolve(root, safe);
  const back = relative(root, abs);
  if (back === "" || back.startsWith("..") || isAbsolute(back) || back.split(sep).includes("..")) {
    throw new FsGuardError(`Path leaves the repo: ${JSON.stringify(rel)}`);
  }
  return abs;
}

const SECRET_PATTERNS: RegExp[] = [
  /\bser\.[A-Za-z0-9]{16,}\b/g, // Flagsmith server-side keys
  /\bsk-ant-[A-Za-z0-9_-]{8,}/g, // Anthropic keys
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
];

/** Replace anything that looks like a key or token, and any literal in `extra`, before text goes into a PR body or a log. */
export function redactSecrets(text: string, extra: string[] = []): string {
  let out = text;
  for (const s of extra) if (s.length >= 6) out = out.split(s).join("[redacted]");
  for (const re of SECRET_PATTERNS) out = out.replace(re, "[redacted]");
  return out;
}

/** Strip terminal escape sequences (test output goes into a PR body). */
export const stripAnsi = (s: string): string => s.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\u001b\][^\u0007]*\u0007/g, "");
