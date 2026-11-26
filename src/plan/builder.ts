import { createHash } from "node:crypto";
import { FlagsmithAdapter, type Evidence } from "../flagsmith/adapter.js";
import { assertFlagKey } from "../flagsmith/cli.js";
import type { LandPort } from "../flagsmith/landPort.js";
import type { Experiment } from "../flagsmith/schemas.js";
import { computeVerdict, type Verdict, type VerdictConfig } from "../verdict/engine.js";
import { renderBrief } from "./brief.js";
import { planHash, planIdOf } from "./hash.js";
import { discoverAliases, type CodeEditProvider } from "../repo/edits.js";
import type { CodeEdit, LandPlan, PlanVerdict, RolloutDecision } from "./types.js";

/** Landing is refused: carries the verdict so the CLI can print the reasons. */
export class LandRefused extends Error {
  constructor(
    message: string,
    readonly verdict: Verdict | null = null,
  ) {
    super(message);
    this.name = "LandRefused";
  }
}

export const DEFAULT_PLAN_TTL_MINUTES = 30;

export const keyFingerprint = (envKey: string): string => createHash("sha256").update(envKey).digest("hex").slice(0, 12);

/** Pick the experiment to land for a flag: running or paused first, otherwise the newest. */
export function pickExperiment(experiments: Experiment[], flag: string): Experiment | null {
  const mine = experiments.filter((e) => e.feature.name === flag);
  if (mine.length === 0) return null;
  const active = mine.filter((e) => e.status === "running" || e.status === "paused");
  const pool = active.length > 0 ? active : mine;
  return [...pool].sort((a, b) => b.id - a.id)[0] ?? null;
}

export interface Clock {
  /** Epoch ms for TTL checks and timestamps. */
  now: () => number;
  /** Epoch ms for the verdict's stale check, or "replay" to freeze it at the newest results time (fixtures). */
  verdictNow?: number | "replay";
}

export interface Evaluation {
  experiment: Experiment;
  evidence: Evidence;
  verdict: Verdict;
  evaluatedAtMs: number;
}

/** Collect evidence for an already known experiment and compute the verdict. The one place both `land` and `apply` judge. */
export async function evaluateExperiment(
  port: LandPort,
  envKey: string,
  experiment: Experiment,
  opts: { refresh: boolean; clock: Clock; config?: Partial<VerdictConfig> },
): Promise<Evaluation> {
  const evidence = await port.collect(envKey, experiment, { refresh: opts.refresh });
  let nowMs: number;
  const vn = opts.clock.verdictNow;
  if (vn === "replay") {
    const asOf = evidence.results?.as_of ? Date.parse(evidence.results.as_of) : NaN;
    nowMs = Number.isFinite(asOf) ? asOf : opts.clock.now();
  } else {
    nowMs = vn ?? opts.clock.now();
  }
  const verdict = computeVerdict({
    experiment: evidence.experiment,
    results: evidence.results,
    exposures: evidence.exposures,
    nowMs,
    ...(opts.config ? { config: opts.config } : {}),
  });
  return { experiment: evidence.experiment, evidence, verdict, evaluatedAtMs: nowMs };
}

/** The rollout a SHIP verdict asks for. Null for anything else, and for a winner without an option id (fail closed). */
export function rolloutFor(verdict: Verdict): RolloutDecision | null {
  if (verdict.decision !== "SHIP" || !verdict.winner) return null;
  if (verdict.winner.variant === null) return { decision: "control" };
  if (verdict.winner.optionId === null) return null;
  return { decision: "variant", variantOptionId: verdict.winner.optionId, variantKey: verdict.winner.variant };
}

export function toPlanVerdict(v: Verdict): PlanVerdict {
  return {
    decision: v.decision,
    kind: v.kind,
    label: v.label,
    winner: v.winner,
    metricName: v.metricName,
    asOf: v.asOf,
    srmPValue: v.srm ? v.srm.pValue : null,
    reasons: v.reasons.map((r) => ({ code: r.code, severity: r.severity, message: r.message })),
    arms: v.arms.map((a) => ({
      key: a.key,
      isControl: a.isControl,
      exposures: a.exposures,
      conversions: a.conversions,
      rate: a.rate,
      lift: a.lift,
      ciLow: a.ciLow,
      ciHigh: a.ciHigh,
      chanceToWin: a.chanceToWin,
    })),
  };
}

/** What must still hold at apply time: same decision, same kind, same winner (S5). */
export function sameVerdict(plan: PlanVerdict, now: Verdict): boolean {
  return plan.decision === now.decision && plan.kind === now.kind && JSON.stringify(plan.winner) === JSON.stringify(now.winner);
}

export function refusalText(flag: string, v: Verdict): string {
  const lines = [`Refusing to land ${flag}: verdict is ${v.label} (${v.decision}).`];
  for (const r of v.reasons.filter((x) => x.severity !== "info")) lines.push(`  - ${r.message}`);
  return lines.join("\n");
}

export interface BuildInput {
  port: LandPort;
  envName: string;
  envKey: string;
  protectedEnv: boolean;
  flag: string;
  clock: Clock;
  ttlMinutes?: number;
  refresh?: boolean;
  config?: Partial<VerdictConfig>;
  /** B6: where the flag is used in code. Omit (or pass no provider) to land the flag only. */
  code?: { provider: CodeEditProvider; repoPath: string; baseBranch: string };
}

export interface BuiltPlan {
  plan: LandPlan;
  hash: string;
  id: string;
  rawFlagState: unknown;
}

/**
 * Re-check the verdict live and, only for SHIP, build the complete plan (rollout decision, MV option id, flag before-state,
 * the irreversible step, the brief). Throws LandRefused with the reasons for anything else. Writes nothing anywhere.
 */
export async function buildLandPlan(input: BuildInput): Promise<BuiltPlan> {
  const flag = assertFlagKey(input.flag);
  const listed = pickExperiment(await input.port.listExperiments(input.envKey), flag);
  if (!listed) {
    throw new LandRefused(
      `Refusing to land ${flag}: no experiment on this flag in ${input.envName} (Lander only lands flags that have one).`,
    );
  }
  const ev = await evaluateExperiment(input.port, input.envKey, listed, {
    refresh: input.refresh ?? true,
    clock: input.clock,
    ...(input.config ? { config: input.config } : {}),
  });
  const rollout = rolloutFor(ev.verdict);
  if (!rollout) throw new LandRefused(refusalText(flag, ev.verdict), ev.verdict);

  const { state, raw } = await input.port.readFlagState(input.envKey, flag);
  const createdMs = input.clock.now();
  const ttlMin = input.ttlMinutes ?? DEFAULT_PLAN_TTL_MINUTES;
  if (!(ttlMin > 0)) throw new Error("plan TTL must be a positive number of minutes");
  const pv = toPlanVerdict(ev.verdict);
  const experiment = { id: ev.experiment.id, name: ev.experiment.name, status: ev.experiment.status };

  let codeEdits: CodeEdit[] = [];
  let code: LandPlan["code"];
  if (input.code) {
    const variants = pv.arms.filter((a) => !a.isControl).map((a) => a.key);
    const winnerKey = rollout.decision === "variant" ? rollout.variantKey : null;
    const controlKey = ev.experiment.feature.initial_value ?? null;
    const losingKeys = winnerKey === null ? variants : [...variants.filter((k) => k !== winnerKey), ...(controlKey && controlKey !== winnerKey ? [controlKey] : [])];
    codeEdits = await input.code.provider.propose({ repoPath: input.code.repoPath, flag, winnerKey, controlKey, losingKeys });
    if (codeEdits.length > 0) {
      code = { baseBranch: input.code.baseBranch, losingKeys, props: discoverAliases(input.code.repoPath, flag).props };
    }
  }

  const plan: LandPlan = {
    schema: 1,
    createdAt: new Date(createdMs).toISOString(),
    expiresAt: new Date(createdMs + ttlMin * 60_000).toISOString(),
    source: input.port.mode,
    environment: { name: input.envName, keyFingerprint: keyFingerprint(input.envKey), protected: input.protectedEnv },
    experiment,
    flag: { name: flag, featureId: ev.experiment.feature.id },
    verdict: pv,
    rollout,
    flagBefore: state,
    steps: [
      {
        kind: "complete_experiment",
        irreversible: true,
        method: "POST",
        path: FlagsmithAdapter.completePathTemplate(ev.experiment.id),
        body: FlagsmithAdapter.completeBody(rollout),
      },
    ],
    codeEdits,
    ...(code ? { code } : {}),
    brief: renderBrief({ flag, environment: input.envName, experiment, verdict: pv, rollout, codeFiles: new Set(codeEdits.map((e) => e.path)).size }),
  };
  const hash = planHash(plan);
  return { plan, hash, id: planIdOf(hash), rawFlagState: raw };
}
