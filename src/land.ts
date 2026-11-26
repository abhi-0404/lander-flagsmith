import { applyPlan, type ApplyResult, type CodeStageDeps } from "./executor/apply.js";
import type { Runner } from "./executor/runner.js";
import type { CodeEditProvider } from "./repo/edits.js";
import { Journal, type JournalEntry } from "./executor/journal.js";
import { executeRollback, findRollbackTarget, type RollbackResult, type RollbackTarget } from "./executor/rollback.js";
import { explainBrief, type ExplainResult, type MessagesLike } from "./agent/explain.js";
import type { LanderConfig } from "./config.js";
import type { LandPort } from "./flagsmith/landPort.js";
import { approve, type ApprovalIO } from "./plan/approve.js";
import { buildLandPlan, type Clock } from "./plan/builder.js";
import { renderPlan, fmtFlagState } from "./plan/render.js";
import { assertPlanFresh, PlanStore } from "./plan/store.js";
import type { LandPlan } from "./plan/types.js";
import type { VerdictConfig } from "./verdict/engine.js";

/** Orchestration for `lander land`, `lander apply` and `lander rollback`. The CLI wires real I/O; tests wire fakes. */

export interface RunContext {
  port: LandPort;
  envName: string;
  envKey: string;
  protectedEnv: boolean;
  store: PlanStore;
  journal: Journal;
  clock: Clock;
  io: ApprovalIO;
  log: (line: string) => void;
  config?: Partial<VerdictConfig>;
  /** Injected in tests. */
  explainClient?: MessagesLike;
  cfg?: Pick<LanderConfig, "ANTHROPIC_API_KEY" | "LANDER_EXPLAIN_MODEL">;
  /** B6: the target repo for code edits and the PR. Leave out to land the flag alone (no code step). */
  code?: { provider: CodeEditProvider; repoPath: string; baseBranch: string; runner: Runner; testCommand?: { cmd: string; args: string[] } };
}

const codeStage = (ctx: Pick<RunContext, "code" | "log">): { code: CodeStageDeps } | Record<string, never> =>
  ctx.code
    ? { code: { repoPath: ctx.code.repoPath, runner: ctx.code.runner, log: ctx.log, ...(ctx.code.testCommand ? { testCommand: ctx.code.testCommand } : {}) } }
    : {};

export interface LandOptions {
  dryRun: boolean;
  explain?: boolean;
  ttlMinutes?: number;
}

export type LandOutcome =
  | { status: "dry-run"; planId: string; hash: string; plan: LandPlan; explain?: ExplainResult }
  | { status: "applied"; planId: string; hash: string; plan: LandPlan; result: ApplyResult; explain?: ExplainResult };

/** Named environments only: a raw key as `--env` would put the key into plans and journals. */
export function resolveLandEnvironment(
  cfg: Pick<LanderConfig, "LANDER_ENV_STAGING" | "LANDER_ENV_PRODUCTION" | "LANDER_PROTECTED_ENVS">,
  name: string,
): { name: string; key: string; protectedEnv: boolean } {
  const n = name.trim().toLowerCase();
  const keys: Record<string, string> = { staging: cfg.LANDER_ENV_STAGING, production: cfg.LANDER_ENV_PRODUCTION };
  if (!(n in keys)) throw new Error(`land needs a named environment (staging or production), not "${name}"; raw keys are not accepted for writes`);
  const key = keys[n] as string;
  if (!key) throw new Error(`No key for environment "${n}": set LANDER_ENV_${n.toUpperCase()} in .env`);
  return { name: n, key, protectedEnv: cfg.LANDER_PROTECTED_ENVS.map((x) => x.toLowerCase()).includes(n) };
}

async function maybeExplain(brief: string, ctx: RunContext, opts: LandOptions): Promise<ExplainResult | undefined> {
  if (!opts.explain) return undefined;
  const res = await explainBrief(brief, {
    apiKey: ctx.cfg?.ANTHROPIC_API_KEY ?? "",
    model: ctx.cfg?.LANDER_EXPLAIN_MODEL ?? "claude-haiku-5-5",
    ...(ctx.explainClient ? { client: ctx.explainClient } : {}),
  });
  if (res.status === "ok") {
    ctx.log("");
    ctx.log(`In plain words (rewritten by ${res.model}; the figures above are the record, the model decided nothing):`);
    ctx.log(res.text);
  } else {
    ctx.log("");
    ctx.log(`note: --explain ${res.status}: ${res.reason}. The deterministic brief above is complete.`);
  }
  return res;
}

export function printApplyResult(ctx: Pick<RunContext, "log">, r: ApplyResult, flag: string): void {
  ctx.log("");
  ctx.log(`Applied. Experiment is ${r.experimentStatusAfter}. Journal id ${r.journalId} (undo the flag state with: lander rollback ${r.journalId}).`);
  ctx.log(`Flag ${flag}: before ${fmtFlagState(r.before)} | after ${fmtFlagState(r.after)}`);
  if (r.codeChange) ctx.log(`Draft PR (opened before the experiment was completed): ${r.codeChange.prUrl}`);
  for (const w of r.warnings) ctx.log(`warning: ${w}`);
}

/**
 * lander land <flag> --env <name>: re-check the verdict, build and show the plan, then (unless dry run) save it, ask the human,
 * and apply. Fixtures mode never gets past the dry run.
 */
export async function runLand(flag: string, opts: LandOptions, ctx: RunContext): Promise<LandOutcome> {
  if (ctx.port.mode === "fixtures" && !opts.dryRun) {
    throw new Error("--fixtures is dry-run only: add --dry-run. Recorded data can never be landed.");
  }
  const built = await buildLandPlan({
    port: ctx.port,
    envName: ctx.envName,
    envKey: ctx.envKey,
    protectedEnv: ctx.protectedEnv,
    flag,
    clock: ctx.clock,
    ...(opts.ttlMinutes !== undefined ? { ttlMinutes: opts.ttlMinutes } : {}),
    ...(ctx.config ? { config: ctx.config } : {}),
    ...(ctx.code ? { code: { provider: ctx.code.provider, repoPath: ctx.code.repoPath, baseBranch: ctx.code.baseBranch } } : {}),
  });
  if (ctx.port.mode === "fixtures") ctx.log("FIXTURES REPLAY: recorded data, not live Flagsmith. Dry run only.\n");
  ctx.log(renderPlan(built.plan, built.hash));
  ctx.log("");
  ctx.log(built.plan.brief);
  const explain = await maybeExplain(built.plan.brief, ctx, opts);
  const extra = explain ? { explain } : {};

  if (opts.dryRun) {
    ctx.log("");
    ctx.log(`Dry run: nothing was written (no plan file, no journal, no Flagsmith call). Plan ${built.id} would be saved under ${ctx.store.root}.`);
    return { status: "dry-run", planId: built.id, hash: built.hash, plan: built.plan, ...extra };
  }

  const id = ctx.store.save(built.plan, built.hash);
  ctx.log("");
  ctx.log(`Plan saved: ${ctx.store.file(id)} (resume later with: lander apply ${id}, valid until ${built.plan.expiresAt})`);
  const approval = await approve(built.plan, built.hash, ctx.io, { now: ctx.clock.now });
  const result = await applyPlan(id, approval, { port: ctx.port, store: ctx.store, journal: ctx.journal, envKey: ctx.envKey, clock: ctx.clock, ...(ctx.config ? { config: ctx.config } : {}), ...codeStage(ctx) });
  printApplyResult(ctx, result, flag);
  return { status: "applied", planId: id, hash: built.hash, plan: built.plan, result, ...extra };
}

/** lander apply <plan-id>: resume a saved plan. Same gates: hash, TTL, typed approval, verdict and flag re-check. */
export async function runApply(planId: string, ctx: RunContext): Promise<{ plan: LandPlan; result: ApplyResult }> {
  if (ctx.port.mode === "fixtures") throw new Error("--fixtures is dry-run only: apply is not available");
  const { id, hash, plan } = ctx.store.load(planId);
  assertPlanFresh(plan, ctx.clock.now());
  if (ctx.protectedEnv && !plan.environment.protected) {
    throw new Error(`${plan.environment.name} is protected now but the plan was made when it was not: run lander land again.`);
  }
  ctx.log(renderPlan(plan, hash));
  ctx.log("");
  const approval = await approve(plan, hash, ctx.io, { now: ctx.clock.now });
  const result = await applyPlan(id, approval, { port: ctx.port, store: ctx.store, journal: ctx.journal, envKey: ctx.envKey, clock: ctx.clock, ...(ctx.config ? { config: ctx.config } : {}), ...codeStage(ctx) });
  printApplyResult(ctx, result, plan.flag.name);
  return { plan, result };
}

export function describeRollback(t: RollbackTarget): string[] {
  return [
    `Rollback of plan ${t.planId}: flag ${t.flag} in ${t.environment.name}${t.environment.protected ? " (PROTECTED)" : ""}`,
    `  restore to: ${fmtFlagState(t.before)}`,
    `  expected now: ${t.expectedNow ? fmtFlagState(t.expectedNow) : "(apply did not finish; no drift check)"}`,
    "  The experiment stays completed: Flagsmith cannot reopen it.",
  ];
}

/** lander rollback <journal-id>: restore the flag state recorded before the apply. */
export async function runRollback(
  ref: string,
  opts: { dryRun: boolean },
  ctx: Pick<RunContext, "port" | "journal" | "io" | "log" | "clock"> & { resolveKey: (envName: string) => string },
): Promise<{ target: RollbackTarget; result?: RollbackResult }> {
  const entries: JournalEntry[] = ctx.journal.readAll();
  const target = findRollbackTarget(entries, ref);
  for (const line of describeRollback(target)) ctx.log(line);
  if (opts.dryRun) {
    ctx.log("Dry run: nothing was written.");
    return { target };
  }
  const approval = await approve({ environment: { name: target.environment.name, protected: target.environment.protected } }, target.started.hash, ctx.io, {
    action: "rollback",
    now: ctx.clock.now,
  });
  const result = await executeRollback(target, approval, { port: ctx.port, journal: ctx.journal, envKey: ctx.resolveKey(target.environment.name) });
  ctx.log(`${result.note} Journal id ${result.journalId}.`);
  ctx.log(`Flag ${target.flag}: before ${fmtFlagState(result.before)} | after ${fmtFlagState(result.after)}`);
  return { target, result };
}

