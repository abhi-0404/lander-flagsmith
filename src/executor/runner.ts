import { execFile } from "node:child_process";

/**
 * How Lander runs `git`, `gh` and the repo's test command. One injectable function, so tests can stub `git push` and `gh`
 * and never touch a network or a real repository. Always an argument array, never a shell string (S8).
 */
export interface RunResult {
  /** Exit code; -1 when the program could not be started at all. */
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  cwd?: string;
  timeoutMs?: number;
}

export type Runner = (cmd: string, args: string[], opts?: RunOptions) => Promise<RunResult>;

const SHELL_SHIMS = new Set(["pnpm", "npm", "npx", "yarn"]);
const SAFE_ARG = /^[A-Za-z0-9_.:=@/-]+$/;

/** Real runner. Never rejects: a failure to start comes back as code -1 with the reason in stderr. */
export const realRunner: Runner = (cmd, args, opts = {}) =>
  new Promise((resolvePromise) => {
    let file = cmd;
    let argv = args;
    // On Windows pnpm is a .cmd shim, which only runs through cmd.exe. The arguments are fixed by Lander, and checked here.
    if (process.platform === "win32" && SHELL_SHIMS.has(cmd)) {
      if (![cmd, ...args].every((a) => SAFE_ARG.test(a))) {
        resolvePromise({ code: -1, stdout: "", stderr: `refusing to run ${cmd}: unsafe argument` });
        return;
      }
      file = process.env["ComSpec"] ?? "cmd.exe";
      argv = ["/d", "/s", "/c", [cmd, ...args].join(" ")];
    }
    const child = execFile(
      file,
      argv,
      { cwd: opts.cwd, timeout: opts.timeoutMs ?? 10 * 60_000, maxBuffer: 32 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (!err) return resolvePromise({ code: 0, stdout, stderr });
        const code = typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : -1;
        resolvePromise({ code, stdout: stdout ?? "", stderr: `${stderr ?? ""}${code === -1 ? `\n${err.message}` : ""}`.trim() });
      },
    );
    child.stdin?.end();
  });
