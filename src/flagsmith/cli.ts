import { execFile } from "node:child_process";

/** Flag keys go into command lines. Validate them first (safety finding S8). */
// First character must not be "-" (option injection) or "." (path traversal such as "..").
const FLAG_KEY = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;
export function assertFlagKey(key: string): string {
  if (!FLAG_KEY.test(key)) throw new Error(`Unsafe flag key: ${JSON.stringify(key)}`);
  return key;
}

export type HttpMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

export interface FlagsmithCallOptions {
  /** Client-side environment key, passed as -e. */
  environment?: string;
  /** Project id or name, passed as -p. */
  project?: string;
  /** JSON body, sent on stdin via --input - (see docs/cli-facts.md). */
  body?: unknown;
  /** Binary name or path, overridable for tests (or set FLAGSMITH_BIN). */
  bin?: string;
}

/** Global flags (-p, -e, --json, --no-input) that go after the subcommand. Pure. */
export function globalArgs(opts: Pick<FlagsmithCallOptions, "environment" | "project">): string[] {
  const args = ["--json", "--no-input"];
  if (opts.project) args.push("-p", opts.project);
  if (opts.environment) args.push("-e", opts.environment);
  return args;
}

/** Build the argument array for `flagsmith api`. Pure, so it is unit-testable. */
export function buildApiArgs(method: HttpMethod, path: string, opts: FlagsmithCallOptions = {}): string[] {
  const args = ["api", path.replace(/^\//, ""), "-X", method, ...globalArgs(opts)];
  if (opts.body !== undefined) args.push("--input", "-");
  return args;
}

/** Command line for error messages: the environment key (after -e and inside environments/<key>/) is masked. */
export function maskArgs(args: string[]): string[] {
  return args.map((a, i) => (args[i - 1] === "-e" ? "{env}" : a.replace(/environments\/[^/]+\//, "environments/{env}/")));
}

/**
 * Run the Flagsmith CLI with an argument array (execFile, never a shell string).
 * Optional stdin text. Resolves with stdout; rejects with stderr in the message.
 */
export function runFlagsmith(args: string[], opts: { stdin?: string; bin?: string } = {}): Promise<string> {
  const bin = opts.bin ?? process.env["FLAGSMITH_BIN"] ?? "flagsmith";
  return new Promise((resolve, reject) => {
    const child = execFile(bin, args, { maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`flagsmith ${maskArgs(args).join(" ")} failed: ${stderr.trim() || err.message}`));
      } else {
        resolve(stdout);
      }
    });
    if (opts.stdin !== undefined) child.stdin?.end(opts.stdin);
    else child.stdin?.end();
  });
}

function parseJson(text: string): unknown {
  const t = text.trim();
  return t ? JSON.parse(t) : null;
}

/** `flagsmith api <path> -X <method> [--input -]`. Returns parsed JSON, or null on an empty body. */
export async function flagsmithApi(
  method: HttpMethod,
  path: string,
  opts: FlagsmithCallOptions = {},
): Promise<unknown> {
  const args = buildApiArgs(method, path, opts);
  const stdin = opts.body !== undefined ? JSON.stringify(opts.body) : undefined;
  return parseJson(await runFlagsmith(args, { ...(stdin !== undefined ? { stdin } : {}), ...(opts.bin ? { bin: opts.bin } : {}) }));
}

/** Any other subcommand with --json, e.g. flagsmithJson(["flag", "get", key], { environment }). */
export async function flagsmithJson(
  subcommand: string[],
  opts: Omit<FlagsmithCallOptions, "body"> = {},
): Promise<unknown> {
  const args = [...subcommand, ...globalArgs(opts)];
  return parseJson(await runFlagsmith(args, opts.bin ? { bin: opts.bin } : {}));
}
