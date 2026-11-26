// NEVER imported by agent/. Branch, commit and push through an injected runner (execFile git, argument arrays only).
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { Runner } from "./runner.js";

export class GitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitError";
  }
}

/** Branch name for a landing: `lander/land-<flag>-<planid>`. The flag key is validated by the caller. */
export const landBranchName = (flag: string, planId: string): string => `lander/land-${flag}-${planId}`;

const BRANCH_OK = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

/** A thin wrapper over one repo. Every method throws GitError with git's own message on failure. */
export class Git {
  constructor(
    private readonly run: Runner,
    readonly repo: string,
  ) {}

  private async ok(args: string[]): Promise<string> {
    const r = await this.run("git", args, { cwd: this.repo });
    if (r.code !== 0) throw new GitError(`git ${args.join(" ")} failed: ${(r.stderr || r.stdout).trim() || `exit ${r.code}`}`);
    return r.stdout;
  }

  /** Exit code only (for questions like "does this branch exist"). */
  private async code(args: string[]): Promise<number> {
    return (await this.run("git", args, { cwd: this.repo })).code;
  }

  /** The repo must BE the work tree root: never commit into a parent repository by accident. */
  async assertIsRoot(): Promise<void> {
    const top = (await this.ok(["rev-parse", "--show-toplevel"])).trim();
    const same = (a: string, b: string): boolean => {
      const norm = (p: string): string => {
        let r = resolve(p);
        try {
          r = realpathSync(r);
        } catch {
          /* keep resolved path */
        }
        return process.platform === "win32" ? r.toLowerCase() : r;
      };
      return norm(a) === norm(b);
    };
    if (!same(top, this.repo)) throw new GitError(`${this.repo} is not the root of a git repository (git says the root is ${top}). Refusing to commit into another repo.`);
  }

  /** Paths git lists as changed or untracked (ignored files are not listed). */
  async changedPaths(): Promise<string[]> {
    const out = await this.ok(["status", "--porcelain", "--untracked-files=all"]);
    return out
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => l.slice(3).replace(/^"|"$/g, "").replace(/^.* -> /, ""));
  }

  async assertClean(): Promise<void> {
    const dirty = await this.changedPaths();
    if (dirty.length > 0) {
      throw new GitError(`The working tree of ${this.repo} is not clean (${dirty.slice(0, 5).join(", ")}${dirty.length > 5 ? ", ..." : ""}). Commit or stash first; Lander never mixes its change with yours.`);
    }
  }

  async currentBranch(): Promise<string> {
    return (await this.ok(["rev-parse", "--abbrev-ref", "HEAD"])).trim();
  }

  async branchExists(name: string): Promise<boolean> {
    return (await this.code(["rev-parse", "--verify", "--quiet", `refs/heads/${name}`])) === 0;
  }

  async createBranch(name: string): Promise<void> {
    if (!BRANCH_OK.test(name) || name.includes("..")) throw new GitError(`Unsafe branch name: ${JSON.stringify(name)}`);
    await this.ok(["switch", "-c", name]);
  }

  async hasRemote(name = "origin"): Promise<boolean> {
    return (await this.code(["remote", "get-url", name])) === 0;
  }

  /** Best effort: fetch the base branch and say how many commits the local one is behind. 0 when it cannot be told. */
  async commitsBehind(base: string, remote = "origin"): Promise<number> {
    if ((await this.code(["fetch", "--quiet", remote, base])) !== 0) return 0;
    const r = await this.run("git", ["rev-list", "--count", `HEAD..${remote}/${base}`], { cwd: this.repo });
    const n = Number(r.stdout.trim());
    return r.code === 0 && Number.isFinite(n) ? n : 0;
  }

  /** Stage exactly these paths (deletions included) and commit. No `--no-verify`, no author override, no trailers. */
  async commit(paths: string[], subject: string, body: string): Promise<string> {
    await this.ok(["add", "-A", "--", ...paths]);
    await this.ok(["commit", "-m", subject, "-m", body]);
    return (await this.ok(["rev-parse", "HEAD"])).trim();
  }

  async push(branch: string, remote = "origin"): Promise<void> {
    await this.ok(["push", "-u", remote, branch]);
  }
}
