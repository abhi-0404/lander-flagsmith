// NEVER imported by agent/. The only code that writes to Flagsmith, and only after approval.
import { resolve } from "node:path";
import { FlagsmithAdapter } from "../flagsmith/adapter.js";
import { sameFlagState } from "../flagsmith/flagState.js";
import type { LandPort } from "../flagsmith/landPort.js";
import {
  evaluateExperiment,
  keyFingerprint,
  refusalText,
  rolloutFor,
  sameVerdict,
  type Clock,
} from "../plan/builder.js";
import { ApprovalRefused } from "../plan/approve.js";
import { approvalPrefix, canonicalJson, planHash } from "../plan/hash.js";
import { assertPlanFresh, PlanTampered, type PlanStore } from "../plan/store.js";
import type { Approval, FlagState, LandPlan } from "../plan/types.js";
import type { VerdictConfig } from "../verdict/engine.js";
import type { Journal } from "./journal.js";
import { CodeChangeFailed, runCodeChange } from "./codeChange.js";
import { landBranchName } from "./git.js";
import type { Runner } from "./runner.js";
import { redactSecrets } from "../repo/fsGuard.js";

/** Error text for the journal, with the environment key replaced (CLI errors echo the command line). */
export function redactKey(err: unknown, envKey: string): string {
  const msg = err instanceof Error ? err.message : String(err);
  return envKey ? msg.split(envKey).join("{env}") : msg;
}

/** The world changed between plan and apply (verdict, winner, experiment or flag state). Nothing was written. */
export class DriftDetected extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DriftDetected";
  }
}

/** The code step stopped on purpose before the PR existed (no remote). Nothing was written to Flagsmith. */
export class CodeStageStopped extends Error {
  constructor(
    message: string,
    readonly branch: string,
    readonly commit: string,
  ) {
    super(message);
    this.name = "CodeStageStopped";
  }
}

/** What the code step needs: the target repo and a runner for git, gh and the tests (injected in tests). */
export interface CodeStageDeps {
  repoPath: string;
  runner: Runner;
  log: (line: string) => void;
  testCommand?: { cmd: string; args: string[] };
}

export interface ApplyDeps {
  port: LandPort;
  store: PlanStore;
  journal: Journal;
  /** Environment API key resolved from config by the plan's environment name. */
  envKey: string;
  clock: Clock;
  config?: Partial<VerdictConfig>;
  /** Required when the plan has code edits. */
  code?: CodeStageDeps;
}

export interface ApplyResult {
  planId: string;
  /** Journal id to hand to `lander rollback`. */
  journalId: string;
  before: FlagState;
  after: FlagState;
  experimentStatusAfter: string;
  warnings: string[];
  /** Set when the plan had code edits: the draft PR that was opened before the experiment was completed. */
  codeChange?: { branch: string; commit: string; prUrl: string };
}

/** The plan's step must be exactly what Lander would build from the rollout decision (no smuggled path or body). */
function assertStepsMatchRollout(plan: LandPlan): void {
  if (plan.steps.length !== 1) throw new PlanTampered("plan must have exactly one step");
  const step = plan.steps[0];
  if (!step) throw new PlanTampered("plan has no step");
  const expectedPath = FlagsmithAdapter.completePathTemplate(plan.experiment.id);
  if (
    step.kind !== "complete_experiment" ||
    step.path !== expectedPath ||
    canonicalJson(step.body) !== canonicalJson(FlagsmithAdapter.completeBody(plan.rollout))
  ) {
    throw new PlanTampered("plan step does not match its rollout decision. Refusing.");
  }
}

/**
 * Apply an approved plan. Order, each check refusing before any write:
 *  1. reload the plan from disk and recompute its hash (S4), TTL, source, environment key fingerprint, approval proof
 *  2. re-read results and recompute the verdict: it must equal the planned one (S5)
 *  3. re-read the flag: it must equal the planned before-state (drift)
 *  4. journal the approval and the before-state, THEN write
 *  5. read the state back and journal before and after
 * S6: when the plan has code edits, the branch, tests, push and draft PR happen after the approval is journaled and BEFORE the
 * first Flagsmith write; `complete` stays last and only runs once the PR exists. A failed or stopped code step throws and
 * nothing is written to Flagsmith.
 */
export async function applyPlan(planId: string, approval: Approval, deps: ApplyDeps): Promise<ApplyResult> {
  const { port, journal, envKey } = deps;
  const { id, hash, plan } = deps.store.load(planId);

  if (plan.source !== "live" || port.mode !== "live") {
    throw new Error("fixtures plans and fixtures mode can never be applied (dry-run only)");
  }
  if (approval.planHash !== hash) throw new PlanTampered("The approval was given for a different plan hash. Refusing.");
  if (approval.typed.hashPrefix !== approvalPrefix(hash)) throw new ApprovalRefused("The approval does not carry the typed hash prefix. Refusing.");
  if (planHash(plan) !== hash) throw new PlanTampered("Plan content no longer matches its hash. Refusing.");
  assertPlanFresh(plan, deps.clock.now());
  if (keyFingerprint(envKey) !== plan.environment.keyFingerprint) {
    throw new DriftDetected(`The key for environment ${plan.environment.name} is not the one the plan was made with. Refusing.`);
  }
  if (approval.environment !== plan.environment.name) throw new ApprovalRefused("The approval is for another environment.");
  if (plan.environment.protected && approval.typed.environment !== plan.environment.name) {
    throw new ApprovalRefused(`${plan.environment.name} is protected: the approval must include the typed environment name.`);
  }
  assertStepsMatchRollout(plan);
  // One approval, one apply: a plan that already reached the write step is never replayed, and a broken chain is not extended.
  const chain = journal.verify();
  if (!chain.ok) throw new PlanTampered(`The journal hash chain is broken at line ${chain.line}: ${chain.reason}. Refusing to apply.`);
  if (journal.readAll().some((e) => e.planId === id && e.type === "apply_started")) {
    throw new ApprovalRefused(`Plan ${id} was already applied (or attempted). Run lander land again for a fresh plan.`);
  }

  // 2. verdict re-check (refresh is throttled to once per 5 minutes inside the adapter).
  const current = await port.getExperiment(envKey, plan.experiment.id);
  const ev = await evaluateExperiment(port, envKey, current, { refresh: true, clock: deps.clock, ...(deps.config ? { config: deps.config } : {}) });
  if (!sameVerdict(plan.verdict, ev.verdict)) {
    throw new DriftDetected(
      `The verdict changed since the plan was made: planned ${plan.verdict.label}, now ${ev.verdict.label}.\n${refusalText(plan.flag.name, ev.verdict)}`,
    );
  }
  const rollout = rolloutFor(ev.verdict);
  if (!rollout || canonicalJson(rollout) !== canonicalJson(plan.rollout)) {
    throw new DriftDetected("The winning arm or its option id changed since the plan was made.");
  }

  // 3. flag drift.
  const before = await port.readFlagState(envKey, plan.flag.name);
  if (!sameFlagState(before.state, plan.flagBefore)) {
    throw new DriftDetected(
      `Flag ${plan.flag.name} changed since the plan was made (someone edited it). Planned before-state: ${JSON.stringify(plan.flagBefore)}; now: ${JSON.stringify(before.state)}.`,
    );
  }

  // 4. approval and before-state are on the record before the first write.
  const approvalEntry = journal.append("approval", id, {
    planHash: hash,
    environment: plan.environment.name,
    protected: plan.environment.protected,
    approvedBy: approval.user,
    approvedAt: approval.at,
    typed: approval.typed,
  });
  // 4b. S6: the reversible step first. Code edits, tests, push, draft PR. Only a PR that exists lets `complete` run.
  let codeChange: ApplyResult["codeChange"];
  if (plan.codeEdits.length > 0) {
    if (!plan.code) throw new PlanTampered("plan has code edits but no code settings. Refusing.");
    if (!deps.code) {
      throw new Error(
        "This plan has code edits but no target repo is configured (LANDER_REPO_PATH). Nothing was written. Run lander land again, with --no-code to land only the flag.",
      );
    }
    const branch = landBranchName(plan.flag.name, id);
    journal.append("code_started", id, { branch, baseBranch: plan.code.baseBranch, files: [...new Set(plan.codeEdits.map((e) => e.path))].sort(), planHash: hash });
    let res;
    try {
      res = await runCodeChange(plan, {
        ...deps.code,
        prBodyFile: resolve(deps.store.dir(id), "pr.md"),
        journalId: approvalEntry.id,
        planId: id,
        hash,
        redact: [envKey],
      });
    } catch (err) {
      const msg = redactSecrets(redactKey(err, envKey), [envKey]);
      journal.append("code_failed", id, {
        stage: err instanceof CodeChangeFailed ? err.stage : "unknown",
        branch: err instanceof CodeChangeFailed ? err.branch : branch,
        error: msg,
      });
      throw err;
    }
    if (res.status === "local_only") {
      journal.append("code_stopped", id, { branch: res.branch, commit: res.commit, reason: res.reason });
      throw new CodeStageStopped(res.reason, res.branch, res.commit);
    }
    journal.append("code_done", id, {
      flag: plan.flag.name,
      environment: plan.environment.name,
      branch: res.branch,
      commit: res.commit,
      prUrl: res.prUrl,
      baseBranch: plan.code.baseBranch,
      losingKeys: plan.code.losingKeys,
      props: plan.code.props,
    });
    codeChange = { branch: res.branch, commit: res.commit, prUrl: res.prUrl };

    // The code stage can take minutes (tests). Re-read the flag so the before-state journaled for rollback is still true.
    const again = await port.readFlagState(envKey, plan.flag.name);
    if (!sameFlagState(again.state, plan.flagBefore)) {
      const reason = `Flag ${plan.flag.name} changed while the code stage ran (someone edited it). The draft PR ${res.prUrl} is open; the experiment was NOT completed. Close the PR or land again.`;
      journal.append("code_stopped", id, { branch: res.branch, commit: res.commit, prUrl: res.prUrl, reason });
      throw new DriftDetected(reason);
    }
  }

  const started = journal.append("apply_started", id, {
    planHash: hash,
    environment: { name: plan.environment.name, protected: plan.environment.protected, keyFingerprint: plan.environment.keyFingerprint },
    flag: plan.flag.name,
    experiment: plan.experiment,
    rollout: plan.rollout,
    before: before.state,
    beforeRaw: before.raw,
  });

  let response: unknown;
  try {
    response = await port.completeExperiment(envKey, plan.experiment.id, plan.rollout);
  } catch (err) {
    journal.append("apply_failed", id, { startedId: started.id, stage: "complete", error: redactKey(err, envKey) });
    throw err;
  }
  journal.append("step_done", id, { step: "complete_experiment", experimentId: plan.experiment.id, response: response ?? null });

  // 5. read back what Flagsmith now says.
  const warnings: string[] = [];
  let after: Awaited<ReturnType<LandPort["readFlagState"]>>;
  let exp: Awaited<ReturnType<LandPort["getExperiment"]>>;
  try {
    after = await port.readFlagState(envKey, plan.flag.name);
    exp = await port.getExperiment(envKey, plan.experiment.id);
  } catch (err) {
    // The write went through; record that the read-back did not, so the journal never ends at step_done silently.
    journal.append("apply_failed", id, { startedId: started.id, stage: "readback", written: true, error: redactKey(err, envKey) });
    throw err;
  }
  if (exp.status !== "completed") warnings.push(`experiment status after complete is "${exp.status}", expected "completed"`);
  const done = journal.append("apply_done", id, {
    startedId: started.id,
    planHash: hash,
    flag: plan.flag.name,
    before: before.state,
    after: after.state,
    afterRaw: after.raw,
    experimentAfter: { status: exp.status, rollout_decision: exp.rollout_decision ?? null, rollout_variant: exp.rollout_variant ?? null },
    warnings,
  });
  return {
    planId: id,
    journalId: done.id,
    before: before.state,
    after: after.state,
    experimentStatusAfter: exp.status,
    warnings,
    ...(codeChange ? { codeChange } : {}),
  };
}
