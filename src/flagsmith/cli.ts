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
 * Environment for the CLI child process. The CLI scopes credentials to a host: for a self-hosted URL it ignores
 * FLAGSMITH_API_KEY and wants FLAGSMITH_API_KEY_<host> (non alphanumerics become "_", port included), for example
 * http://localhost:8000 -> FLAGSMITH_API_KEY_localhost_8000 (verified on flagsmith v2.0.0, docs/cli-facts.md).
 * Flagsmith Cloud (the default URL) keeps plain FLAGSMITH_API_KEY. Pure: takes the env, returns the extra variables.
 */
export function credentialEnv(env: Record<string, string | undefined>): Record<string, string> {
  const url = env["FLAGSMITH_API_URL"];
  const key = env["FLAGSMITH_API_KEY"];
  if (!url || !key) return {};
  let host: string;
  try {
    host = new URL(url).host;
  } catch {
    return {};
  }
  if (host === "api.flagsmith.com") return {};
  return { [`FLAGSMITH_API_KEY_${host.replace(/[^A-Za-z0-9]/g, "_")}`]: key };
}

/**
 * Run the Flagsmith CLI with an argument array (execFile, never a shell string).
 * Optional stdin text. Resolves with stdout; rejects with stderr in the message.
 */
export function runFlagsmith(args: string[], opts: { stdin?: string; bin?: string } = {}): Promise<string> {
  const bin = opts.bin ?? process.env["FLAGSMITH_BIN"] ?? "flagsmith";
  return new Promise((resolve, reject) => {
    const env = { ...process.env, ...credentialEnv(process.env) };
    const child = execFile(bin, args, { maxBuffer: 16 * 1024 * 1024, env }, (err, stdout, stderr) => {
      if (err) {
        // On a non-2xx answer the CLI exits 1, prints the error line on stderr and the response BODY on stdout
        // (verified on v2.0.0), so both go into the message: callers read "Expected available in N seconds." from it.
        const detail = [stderr.trim(), stdout.trim()].filter(Boolean).join(" | ") || err.message;
        reject(new Error(`flagsmith ${maskArgs(args).join(" ")} failed: ${detail}`));
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
