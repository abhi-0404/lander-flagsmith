import { userInfo } from "node:os";
import { createInterface } from "node:readline/promises";
import { approvalPrefix } from "./hash.js";
import type { Approval } from "./types.js";

/** Why approval did not happen. Nothing was written to Flagsmith. */
export class ApprovalRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApprovalRefused";
  }
}

export interface ApprovalIO {
  /** True only when both stdin and stdout are a terminal. A pipe, a file or CI never counts (S4). */
  isTTY: boolean;
  ask(question: string): Promise<string>;
}

/** True when the environment says it is a CI runner. Approval is never possible there. */
export function runningInCI(env: NodeJS.ProcessEnv): boolean {
  const truthy = (v: string | undefined) => v !== undefined && v !== "" && v.toLowerCase() !== "false" && v !== "0";
  return ["CI", "GITHUB_ACTIONS", "GITLAB_CI", "BUILDKITE", "CIRCLECI", "TF_BUILD", "JENKINS_URL"].some((k) => truthy(env[k]));
}

export function defaultApprovalIO(): ApprovalIO {
  return {
    // A CI runner can fake a terminal (script, docker -t), so a CI marker refuses too.
    isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY) && !runningInCI(process.env),
    async ask(question) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return await rl.question(question);
      } finally {
        rl.close();
      }
    },
  };
}

export interface ApproveOptions {
  /** Short label of what is being approved, e.g. "landing" or "rollback". */
  action?: string;
  now?: () => number;
  user?: () => string;
}

/**
 * Human approval at the terminal (Gate 1). The human types the first 8 characters of the plan hash, and for a protected
 * environment also the environment name. One attempt: a wrong answer refuses. Non-TTY is refused before any prompt.
 */
export async function approve(
  plan: { environment: { name: string; protected: boolean } },
  hash: string,
  io: ApprovalIO,
  opts: ApproveOptions = {},
): Promise<Approval> {
  const action = opts.action ?? "landing";
  if (!io.isTTY) {
    throw new ApprovalRefused(
      `Refusing to approve ${action} without an interactive terminal: approval must be typed by a person (no piping, no CI).`,
    );
  }
  const expectedHash = approvalPrefix(hash);
  const typedHash = (await io.ask(`Type the hash prefix (${expectedHash}) to approve ${action}: `)).trim().toLowerCase();
  if (typedHash !== expectedHash) throw new ApprovalRefused("The typed hash prefix does not match. Not approved.");

  let typedEnv: string | undefined;
  if (plan.environment.protected) {
    const expectedEnv = plan.environment.name;
    typedEnv = (await io.ask(`${expectedEnv} is a protected environment. Type its name (${expectedEnv}) to confirm: `)).trim();
    if (typedEnv !== expectedEnv) throw new ApprovalRefused("The typed environment name does not match. Not approved.");
  }
  return {
    planHash: hash,
    environment: plan.environment.name,
    user: (opts.user ?? (() => userInfo().username))(),
    at: new Date((opts.now ?? Date.now)()).toISOString(),
    typed: { hashPrefix: typedHash, ...(typedEnv !== undefined ? { environment: typedEnv } : {}) },
  };
}
