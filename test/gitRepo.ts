import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { realRunner, type Runner, type RunResult } from "../src/executor/runner.js";

/** The sibling demo shop. Tests only READ it (copy its src). They never run git, gh or anything else inside it. */
export const SHOP = resolve(import.meta.dirname, "..", "..", "lander-demo-shop");
export const SHOP_PRESENT = existsSync(join(SHOP, "src", "components", "CheckoutButton.tsx"));

/** Every git command in tests runs in a folder under the OS temp dir. This is the guard. */
export function assertTemp(dir: string): string {
  const abs = resolve(dir).toLowerCase();
  const tmp = resolve(tmpdir()).toLowerCase();
  if (!abs.startsWith(tmp.endsWith(sep) ? tmp : tmp + sep)) throw new Error(`test safety: ${dir} is not a throwaway folder under ${tmpdir()}`);
  return dir;
}

export const git = (dir: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd: assertTemp(dir), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/** Copy the demo shop's source into a new temp folder (no git yet). */
export function copyShop(extra: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "lander-shop-"));
  cpSync(join(SHOP, "src"), join(dir, "src"), { recursive: true });
  for (const f of ["package.json", ".gitignore"]) if (existsSync(join(SHOP, f))) cpSync(join(SHOP, f), join(dir, f));
  for (const [rel, text] of Object.entries(extra)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text, "utf8");
  }
  return dir;
}

/** A throwaway git repo on `main` holding a copy of the demo shop. Local identity only; nothing global is touched. */
export function makeShopRepo(extra: Record<string, string> = {}): string {
  const dir = copyShop(extra);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "test@example.invalid");
  git(dir, "config", "user.name", "Test User");
  git(dir, "config", "commit.gpgsign", "false");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "initial");
  return dir;
}

export interface StubOptions {
  testsPass?: boolean;
  remote?: boolean;
  prUrl?: string;
  prState?: string;
  behind?: number;
  pushFails?: boolean;
  ghFails?: boolean;
}

export type Call = { cmd: string; args: string[]; cwd?: string };
export type StubRunner = Runner & { calls: Call[] };

const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "" });

/**
 * Injected runner: local git commands run for real (in the temp repo only), while `git push`, `git fetch`, the remote lookup,
 * `gh` and `pnpm test` are stubbed. Nothing here can reach a network or the real GitHub.
 */
export function stubRunner(o: StubOptions = {}): StubRunner {
  const calls: Call[] = [];
  const runner = (async (cmd, args, opts) => {
    calls.push({ cmd, args, ...(opts?.cwd ? { cwd: opts.cwd } : {}) });
    if (cmd === "pnpm") return o.testsPass === false ? { code: 1, stdout: " FAIL  src/x.test.tsx\n1 failed", stderr: "" } : ok(" Test Files  3 passed (3)\n      Tests  9 passed (9)");
    if (cmd === "gh") {
      if (args[0] === "pr" && args[1] === "view") return ok(JSON.stringify({ state: o.prState ?? "MERGED" }));
      return o.ghFails ? { code: 1, stdout: "", stderr: "gh: not logged in" } : ok(`${o.prUrl ?? "https://github.com/example/shop/pull/7"}\n`);
    }
    if (cmd === "git") {
      if (args[0] === "push") return o.pushFails ? { code: 1, stdout: "", stderr: "remote rejected" } : ok();
      if (args[0] === "fetch") return ok();
      if (args[0] === "remote") return o.remote === false ? { code: 2, stdout: "", stderr: "error: No such remote 'origin'" } : ok("https://example.invalid/shop.git\n");
      if (args[0] === "rev-list") return ok(`${o.behind ?? 0}\n`);
      assertTemp(opts?.cwd ?? "");
      return realRunner(cmd, args, opts);
    }
    throw new Error(`test: unexpected command ${cmd}`);
  }) as StubRunner;
  runner.calls = calls;
  return runner;
}
