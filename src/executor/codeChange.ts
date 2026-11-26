// NEVER imported by agent/. Plan B6: branch, apply the approved edits, test, residue check, commit, push, draft PR.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { prTitle, renderPrBody } from "../plan/prBody.js";
import type { LandPlan } from "../plan/types.js";
import { verifyEdits, writeChanges } from "../repo/edits.js";
import { redactSecrets, stripAnsi } from "../repo/fsGuard.js";
import { residueCheck } from "../repo/search.js";
import { createDraftPr } from "./github.js";
import { Git, landBranchName } from "./git.js";
import type { Runner } from "./runner.js";

export interface CodeChangeDeps {
  repoPath: string;
  runner: Runner;
  log: (line: string) => void;
  /** Where pr.md is written (`.lander/plans/<id>/pr.md`). */
  prBodyFile: string;
  /** Journal id of the approval entry, quoted in the PR body. */
  journalId: string;
  planId: string;
  hash: string;
  /** Literals never to print (the environment key). */
  redact?: string[];
  testCommand?: { cmd: string; args: string[] };
}

export type CodeChangeResult =
  | { status: "pr_opened"; branch: string; commit: string; prUrl: string }
  | { status: "local_only"; branch: string; commit: string; reason: string };

/** A step of the code change failed. The branch (when one was made) is left in place for a human to look at. */
export class CodeChangeFailed extends Error {
  constructor(
    message: string,
    readonly stage: "preflight" | "edits" | "residue" | "tests" | "tree" | "commit" | "push" | "pr",
    readonly branch: string | null,
  ) {
    super(message);
    this.name = "CodeChangeFailed";
  }
}

export const DEFAULT_TEST_COMMAND: { cmd: string; args: string[] } = { cmd: "pnpm", args: ["test"] };

const tailOf = (text: string, n = 25): string => stripAnsi(text).trim().split("\n").slice(-n).join("\n");

export async function runCodeChange(plan: LandPlan, deps: CodeChangeDeps): Promise<CodeChangeResult> {
  const { runner, log } = deps;
  if (!plan.code || plan.codeEdits.length === 0) throw new CodeChangeFailed("the plan has no code edits", "preflight", null);
  const repo = resolve(deps.repoPath);
  const git = new Git(runner, repo);
  const base = plan.code.baseBranch;
  const branch = landBranchName(plan.flag.name, deps.planId);
  const test = deps.testCommand ?? DEFAULT_TEST_COMMAND;
  const testLine = [test.cmd, ...test.args].join(" ");
  const fail = (stage: CodeChangeFailed["stage"], msg: string, b: string | null): never => {
    throw new CodeChangeFailed(redactSecrets(msg, deps.redact ?? []), stage, b);
  };

  // 1. Preflight: nothing is written until every one of these holds.
  let changes;
  try {
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(base) || base.includes("..")) fail("preflight", `Unsafe base branch name: ${JSON.stringify(base)}`, null);
    await git.assertIsRoot();
    await git.assertClean();
    const here = await git.currentBranch();
    if (here !== base) fail("preflight", `The repo is on "${here}", not on the base branch "${base}". Switch to ${base} first (Lander branches from it and never from another branch).`, null);
    if (branch === base) fail("preflight", "The landing branch would be the base branch. Refusing.", null);
    if (await git.branchExists(branch)) {
      fail("preflight", `Branch ${branch} already exists (an earlier attempt of this plan). Look at it, then delete it with: git -C "${repo}" branch -D ${branch}`, null);
    }
    const behind = await git.commitsBehind(base);
    if (behind > 0) fail("preflight", `${base} is ${behind} commit(s) behind origin/${base}. Pull first so the PR is made on the current code.`, null);
    changes = verifyEdits(repo, plan.codeEdits);
  } catch (err) {
    if (err instanceof CodeChangeFailed) throw err;
    throw new CodeChangeFailed(redactSecrets(err instanceof Error ? err.message : String(err), deps.redact ?? []), "preflight", null);
  }

  // 2. Branch and edits.
  log(`code: creating branch ${branch} from ${base} and applying ${plan.codeEdits.length} edit(s) in ${changes.length} file(s)`);
  try {
    await git.createBranch(branch);
    writeChanges(repo, changes);
  } catch (err) {
    return fail("edits", err instanceof Error ? err.message : String(err), branch);
  }

  // 3. Residue check, then the repo's own tests. Either failing: stop, leave the branch, no PR.
  const hits = residueCheck(repo, [plan.flag.name, ...plan.code.losingKeys], plan.code.props);
  if (hits.length > 0) {
    const shown = hits.slice(0, 8).map((h) => `  ${h.path}:${h.line} ${h.term}  ${h.text}`);
    fail("residue", `The residue check failed: ${hits.length} mention(s) of the flag or a losing variant are still in the repo:\n${shown.join("\n")}\nBranch ${branch} was left as it is. No PR was opened and the experiment was not completed.`, branch);
  }
  log(`code: residue check clean; running ${testLine}`);
  const t = await runner(test.cmd, test.args, { cwd: repo });
  const testOutput = `${t.stdout}\n${t.stderr}`;
  if (t.code !== 0) {
    fail("tests", `${testLine} failed (exit ${t.code}). Last output:\n${redactSecrets(tailOf(testOutput), deps.redact ?? [])}\nBranch ${branch} was left as it is. No PR was opened and the experiment was not completed.`, branch);
  }
  const planned = new Set(plan.codeEdits.map((e) => e.path));
  const stray = (await git.changedPaths()).filter((p) => !planned.has(p));
  if (stray.length > 0) {
    fail("tree", `${testLine} changed files the plan did not list: ${stray.slice(0, 5).join(", ")}. Refusing to commit them. Branch ${branch} was left as it is.`, branch);
  }

  // 4. Commit with a plain message.
  let commit: string;
  try {
    commit = await git.commit(
      [...planned].sort(),
      prTitle(plan),
      `Hard-code the winning branch and delete the losing branches and the flag read for ${plan.flag.name}.\n\nPlan ${deps.hash.slice(0, 8)}.`,
    );
  } catch (err) {
    return fail("commit", err instanceof Error ? err.message : String(err), branch);
  }
  log(`code: committed ${commit.slice(0, 10)} on ${branch}`);

  // 5. No remote: stop here, on purpose. The experiment is not completed without a PR (S6).
  if (!(await git.hasRemote("origin"))) {
    return {
      status: "local_only",
      branch,
      commit,
      reason: `There is no git remote "origin" in ${repo}, so no PR can be opened. The change is committed locally on ${branch}. The experiment was NOT completed (a PR must exist first). Add a remote, delete that local branch (git branch -D ${branch}) and run lander land again, or land with --no-code.`,
    };
  }

  // 6. Push and open the draft PR; its URL goes to the journal.
  try {
    await git.push(branch);
  } catch (err) {
    return fail("push", `${err instanceof Error ? err.message : String(err)}\nThe commit is on local branch ${branch}. The experiment was not completed.`, branch);
  }
  mkdirSync(dirname(deps.prBodyFile), { recursive: true });
  writeFileSync(
    deps.prBodyFile,
    renderPrBody({ plan, hash: deps.hash, planId: deps.planId, journalId: deps.journalId, testCommand: testLine, testTail: tailOf(testOutput), ...(deps.redact ? { redact: deps.redact } : {}) }),
    "utf8",
  );
  let prUrl: string;
  try {
    prUrl = await createDraftPr(runner, { repo, base, head: branch, title: prTitle(plan), bodyFile: deps.prBodyFile });
  } catch (err) {
    return fail("pr", `${err instanceof Error ? err.message : String(err)}\nThe branch ${branch} was pushed. The experiment was not completed.`, branch);
  }
  log(`code: draft PR opened: ${prUrl}`);
  return { status: "pr_opened", branch, commit, prUrl };
}
