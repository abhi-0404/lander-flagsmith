import type {
  Experiment,
  ExperimentExposures,
  ExperimentMetric,
  ExperimentResults,
  MetricResult,
} from "../flagsmith/schemas.js";
import { srmCheck, type SrmResult } from "./srm.js";

/**
 * Deterministic verdict rules (the LLM explains, code decides). Pure: no I/O, the clock is an argument.
 * Thresholds follow the documented Flagsmith statistics rules; see docs/verdict-rules.md.
 *
 * Decision (what Lander will do):  SHIP | KEEP_RUNNING | REFUSE
 *   SHIP          a winner was found (a variant, or control when every variant loses). Landing is allowed.
 *   KEEP_RUNNING  not enough evidence yet (collecting data, below floors, inconclusive, not started). Wait.
 *   REFUSE        the evidence cannot be trusted or the action is blocked (SRM, stale, guardrail harm, ended).
 * Landing is allowed only for SHIP.
 */

export type Decision = "SHIP" | "KEEP_RUNNING" | "REFUSE";

export type VerdictKind =
  | "SHIP_VARIANT"
  | "SHIP_CONTROL"
  | "COLLECTING"
  | "KEEP_RUNNING"
  | "DO_NOT_TRUST"
  | "STALE"
  | "GUARDRAIL_HARM"
  | "NOT_STARTED"
  | "COMPLETED";

export type ReasonCode =
  | "NOT_STARTED"
  | "ALREADY_COMPLETED"
  | "NO_RESULTS"
  | "TOO_FEW_EXPOSURES"
  | "BELOW_FLOOR"
  | "SRM"
  | "SRM_FLAGSMITH"
  | "METRIC_DIRECTION_UNKNOWN"
  | "PRIMARY_METRIC_MISSING"
  | "UNMAPPED_WINNER"
  | "GUARDRAIL_PENDING"
  | "EXCLUDED_IDENTITIES"
  | "STALE_RESULTS"
  | "RESULTS_ERROR"
  | "PAUSED"
  | "GUARDRAIL_HARM"
  | "WIN"
  | "ALL_VARIANTS_LOSE"
  | "INCONCLUSIVE";

export interface Reason {
  code: ReasonCode;
  /** block: forbids landing. wait: needs more data. info: context only. */
  severity: "block" | "wait" | "info";
  message: string;
}

export interface VerdictConfig {
  /** A variant wins above this chance to beat control (and its interval must exclude zero). */
  winChance: number;
  /** Control wins when every variant is below this chance to beat control. */
  loseChance: number;
  /** Per-arm floors under which Flagsmith shows "Collecting data". */
  minExposures: number;
  minConversions: number;
  /** SRM chi-square p-value under which the split is not trusted. */
  srmPValue: number;
  /** Excluded (quarantined) identities above this share of exposures are not trusted. */
  maxExcludedShare: number;
  /** Results older than this (relative to `now`) are stale. */
  maxResultsAgeMs: number;
  controlKey: string;
}

export const DEFAULT_VERDICT_CONFIG: VerdictConfig = {
  winChance: 0.95,
  loseChance: 0.05,
  minExposures: 50,
  minConversions: 5,
  srmPValue: 0.001,
  maxExcludedShare: 0.01,
  maxResultsAgeMs: 60 * 60 * 1000,
  controlKey: "control",
};

export interface ArmStats {
  key: string;
  isControl: boolean;
  exposures: number;
  conversions: number;
  /** conversions / exposures, null when no exposures. */
  rate: number | null;
  /** Share of all exposures vs the share the allocation asks for. */
  share: number | null;
  expectedShare: number | null;
  lift: number | null;
  ciLow: number | null;
  ciHigh: number | null;
  chanceToWin: number | null;
}

export interface Verdict {
  decision: Decision;
  kind: VerdictKind;
  /** Human label: "SHIP get-everyones-times", "KEEP RUNNING", "DO NOT TRUST"... */
  label: string;
  /** Present only for SHIP. variant null means control survives. optionId is the MV option id for rollout_variant. */
  winner: { variant: string | null; optionId: number | null } | null;
  reasons: Reason[];
  metricName: string | null;
  arms: ArmStats[];
  srm: SrmResult | null;
  asOf: string | null;
  /** Hours until every arm reaches the floors at the current exposure rate (COLLECTING only). */
  etaHours: number | null;
}

export interface VerdictInput {
  experiment: Experiment;
  results: ExperimentResults | null;
  exposures: ExperimentExposures | null;
  /** Epoch ms used for the stale check. */
  nowMs: number;
  config?: Partial<VerdictConfig>;
}

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;

function sumSeries(
  series: { points: { new_identities?: Record<string, number> | undefined }[] } | undefined,
): Record<string, number> | null {
  if (!series || series.points.length === 0) return null;
  const out: Record<string, number> = {};
  for (const p of series.points) {
    for (const [k, v] of Object.entries(p.new_identities ?? {})) out[k] = (out[k] ?? 0) + v;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** Arm key -> MV option, and the expected allocation per arm (control is the remainder). */
function allocation(exp: Experiment, controlKey: string): { weights: Record<string, number> | undefined; keys: string[] } {
  const opts = exp.feature.multivariate_options;
  const keyOf = (o: (typeof opts)[number]): string => o.key ?? o.string_value ?? String(o.id);
  const keys = [controlKey, ...opts.map(keyOf)];
  const rows = exp.experiment_rollout?.multivariate_feature_state_values ?? [];
  if (rows.length === 0) return { weights: undefined, keys };
  const weights: Record<string, number> = {};
  let used = 0;
  for (const o of opts) {
    const row = rows.find((r) => r.multivariate_feature_option === o.id);
    const w = row?.percentage_allocation ?? 0;
    weights[keyOf(o)] = w;
    used += w;
  }
  const rest = 100 - used;
  if (rest <= 0) return { weights: undefined, keys };
  weights[controlKey] = rest;
  return { weights, keys };
}

/** Which way is better for a metric. "unknown" (missing, unrecognised or contradictory) never ships. */
export type MetricDirection = "increase" | "decrease" | "unknown";

export function metricDirection(m: ExperimentMetric | undefined): MetricDirection {
  const read = (x: string | undefined): MetricDirection | null => {
    if (x === undefined) return null;
    const t = x.trim().toLowerCase();
    if (t === "increase" || t === "up") return "increase";
    if (t === "decrease" || t === "down") return "decrease";
    return "unknown";
  };
  const a = read(m?.expected_direction);
  const b = read(m?.direction);
  if (a === null && b === null) return "unknown";
  if (a !== null && b !== null && a !== b) return "unknown";
  return a ?? b ?? "unknown";
}

interface PickedMetric {
  name: string;
  metric: MetricResult;
  direction: MetricDirection;
}

/**
 * Primary = the experiment's first metric, matched by id. If the results carry metric ids and none matches, there is
 * no primary (fail closed: never judge a guardrail as if it were the primary). Index matching only when ids are absent.
 */
function pickPrimary(exp: Experiment, results: ExperimentResults): { primary: PickedMetric | null; guardrails: PickedMetric[] } {
  const metrics = results.payload.metrics;
  const expMetricFor = (m: MetricResult, idx: number): ExperimentMetric | undefined =>
    m.metric_id !== undefined
      ? exp.metrics.find((x) => x.metric !== undefined && Number(x.metric) === m.metric_id)
      : exp.metrics[idx];
  const pick = (m: MetricResult, idx: number): PickedMetric => {
    const em = expMetricFor(m, idx);
    return {
      name: em?.metric_name ?? (m.metric_id !== undefined ? `metric ${m.metric_id}` : `metric ${idx + 1}`),
      metric: m,
      direction: metricDirection(em),
    };
  };
  const firstId = exp.metrics[0]?.metric;
  const anyIds = metrics.some((m) => m.metric_id !== undefined);
  let pIdx: number;
  if (anyIds && firstId !== undefined) {
    pIdx = metrics.findIndex((m) => m.metric_id !== undefined && m.metric_id === Number(firstId));
  } else {
    pIdx = metrics.length > 0 ? 0 : -1;
  }
  const pm = pIdx >= 0 ? metrics[pIdx] : undefined;
  const primary = pm ? pick(pm, pIdx) : null;
  const guardrails = metrics
    .map((m, i) => ({ m, i }))
    .filter(({ i }) => i !== pIdx)
    .map(({ m, i }) => pick(m, i));
  return { primary, guardrails };
}

/** Hours until every arm has the floor exposures and conversions at the pace seen so far; null if unknowable. */
function estimateEtaHours(arms: ArmStats[], results: ExperimentResults, cfg: VerdictConfig): number | null {
  const buckets = results.payload.exposures_timeseries?.points ?? [];
  const asOf = results.as_of ? Date.parse(results.as_of) : NaN;
  const first = buckets.length > 0 ? Date.parse(buckets[0]?.bucket ?? "") : NaN;
  if (!Number.isFinite(asOf) || !Number.isFinite(first)) return null;
  const elapsedH = Math.max(1, (asOf - first) / 3_600_000);
  let worst = 0;
  for (const a of arms) {
    const expRate = a.exposures / elapsedH;
    const convRate = a.conversions / elapsedH;
    if (a.exposures < cfg.minExposures) {
      if (expRate <= 0) return null;
      worst = Math.max(worst, (cfg.minExposures - a.exposures) / expRate);
    }
    if (a.conversions < cfg.minConversions) {
      if (convRate <= 0) return null;
      worst = Math.max(worst, (cfg.minConversions - a.conversions) / convRate);
    }
  }
  return Math.ceil(worst * 10) / 10;
}

function base(input: VerdictInput): Verdict {
  return {
    decision: "KEEP_RUNNING",
    kind: "KEEP_RUNNING",
    label: "KEEP RUNNING",
    winner: null,
    reasons: [],
    metricName: null,
    arms: [],
    srm: null,
    asOf: input.results?.as_of ?? null,
    etaHours: null,
  };
}

function finish(v: Verdict, decision: Decision, kind: VerdictKind, label: string, reasons: Reason[]): Verdict {
  return { ...v, decision, kind, label, reasons: [...v.reasons, ...reasons] };
}

export function computeVerdict(input: VerdictInput): Verdict {
  const cfg: VerdictConfig = { ...DEFAULT_VERDICT_CONFIG, ...input.config };
  const { experiment: exp, results, exposures } = input;
  const v = base(input);

  if (exp.status === "completed") {
    const how = exp.rollout_decision ? ` (rollout decision: ${exp.rollout_decision})` : "";
    return finish(v, "REFUSE", "COMPLETED", "COMPLETED", [
      { code: "ALREADY_COMPLETED", severity: "block", message: `experiment already ended${how}; nothing to land` },
    ]);
  }
  if (exp.status === "created") {
    return finish(v, "KEEP_RUNNING", "NOT_STARTED", "NOT STARTED", [
      { code: "NOT_STARTED", severity: "wait", message: "experiment has not been started" },
    ]);
  }

  const reasons: Reason[] = [];
  if (exp.status === "paused") {
    reasons.push({ code: "PAUSED", severity: "info", message: "experiment is paused; no new exposures are collected" });
  }

  const metricsPresent = results !== null && results.payload.metrics.length > 0;
  if (!results || !metricsPresent) {
    return finish({ ...v, reasons }, "KEEP_RUNNING", "COLLECTING", "COLLECTING", [
      { code: "NO_RESULTS", severity: "wait", message: "no results computed yet (refresh pending or no events in the warehouse)" },
    ]);
  }

  const picked = pickPrimary(exp, results);
  if (!picked.primary) {
    const want = exp.metrics[0]?.metric_name;
    return finish({ ...v, reasons }, "KEEP_RUNNING", "COLLECTING", "COLLECTING", [
      {
        code: "PRIMARY_METRIC_MISSING",
        severity: "wait",
        message: `results do not include the primary metric${want ? ` ${want}` : ""}`,
      },
    ]);
  }
  const pickedPrimary = picked.primary;
  const { guardrails } = picked;
  const primary = pickedPrimary.metric;
  const primaryName = pickedPrimary.name;
  const primaryDir = pickedPrimary.direction;

  // Arms: expected keys from the experiment, plus anything observed.
  const { weights, keys: expectedKeys } = allocation(exp, cfg.controlKey);
  const exposureCounts =
    sumSeries(exposures?.payload.timeseries) ??
    sumSeries(results.payload.exposures_timeseries) ??
    Object.fromEntries(Object.entries(primary.variants).map(([k, x]) => [k, x.n]));
  const armKeys = [...new Set([...expectedKeys, ...Object.keys(primary.variants), ...Object.keys(exposureCounts)])];
  const controlKey = armKeys.includes(cfg.controlKey) ? cfg.controlKey : (armKeys.find((k) => !(k in primary.inference)) ?? cfg.controlKey);
  const observed: Record<string, number> = {};
  for (const k of armKeys) observed[k] = exposureCounts[k] ?? primary.variants[k]?.n ?? 0;
  const total = Object.values(observed).reduce((s, x) => s + x, 0);
  const srm = srmCheck(observed, weights);

  const arms: ArmStats[] = armKeys.map((key) => {
    const cell = primary.variants[key];
    const inf = primary.inference[key];
    const exposuresN = observed[key] ?? 0;
    const conversions = cell?.sum ?? 0;
    const sa = srm?.arms.find((a) => a.key === key);
    return {
      key,
      isControl: key === controlKey,
      exposures: exposuresN,
      conversions,
      rate: exposuresN > 0 ? conversions / exposuresN : null,
      share: sa?.observedShare ?? null,
      expectedShare: sa?.expectedShare ?? null,
      lift: inf?.lift ?? null,
      ciLow: inf?.ci_low ?? null,
      ciHigh: inf?.ci_high ?? null,
      chanceToWin: inf?.chance_to_win ?? null,
    };
  });
  const filled: Verdict = { ...v, reasons, arms, srm, metricName: primaryName };

  // 1. COLLECTING: any arm below the floors. Checked first so a tiny sample is never called an SRM.
  const wait: Reason[] = [];
  for (const a of arms) {
    if (a.exposures < cfg.minExposures) {
      wait.push({
        code: "TOO_FEW_EXPOSURES",
        severity: "wait",
        message: `${a.key}: ${a.exposures} exposures, needs ${cfg.minExposures}`,
      });
    }
    if (a.conversions < cfg.minConversions) {
      wait.push({
        code: "BELOW_FLOOR",
        severity: "wait",
        message: `${a.key}: ${a.conversions} conversions on ${primaryName ?? "the primary metric"}, needs ${cfg.minConversions}`,
      });
    }
  }
  if (wait.length > 0) {
    const eta = estimateEtaHours(arms, results, cfg);
    return { ...finish(filled, "KEEP_RUNNING", "COLLECTING", "COLLECTING", wait), etaHours: eta };
  }

  // 2. Trust checks: SRM, Flagsmith's own SRM p-value, quarantined identities, stale or failing refreshes.
  const trust: Reason[] = [];
  let distrust = false;
  if (srm && srm.pValue < cfg.srmPValue) {
    distrust = true;
    const split = srm.arms.map((a) => `${a.key} ${pct(a.observedShare)}`).join(" / ");
    const want = srm.arms.map((a) => pct(a.expectedShare)).join(" / ");
    trust.push({
      code: "SRM",
      severity: "block",
      message: `sample ratio mismatch: observed ${split}, expected ${want} (chi-square p = ${srm.pValue < 1e-4 ? srm.pValue.toExponential(1) : srm.pValue.toFixed(4)}); likely a tracking or assignment bug`,
    });
  }
  const fp = results.payload.srm_p_value;
  if (typeof fp === "number" && fp < cfg.srmPValue) {
    distrust = true;
    trust.push({ code: "SRM_FLAGSMITH", severity: "block", message: `Flagsmith reports SRM p-value ${fp}` });
  }
  const excluded = exposures?.payload.excluded_identities ?? 0;
  if (excluded > 0 && total + excluded > 0 && excluded / (total + excluded) > cfg.maxExcludedShare) {
    distrust = true;
    trust.push({
      code: "EXCLUDED_IDENTITIES",
      severity: "block",
      message: `${excluded} quarantined identities (${pct(excluded / (total + excluded))}), above ${pct(cfg.maxExcludedShare)}`,
    });
  }
  let stale = false;
  const asOfMs = results.as_of ? Date.parse(results.as_of) : NaN;
  if (!results.is_final) {
    if (!Number.isFinite(asOfMs)) {
      stale = true;
      trust.push({ code: "STALE_RESULTS", severity: "block", message: "results carry no computation time (as_of)" });
    } else if (input.nowMs - asOfMs > cfg.maxResultsAgeMs) {
      stale = true;
      const hours = (input.nowMs - asOfMs) / 3_600_000;
      trust.push({
        code: "STALE_RESULTS",
        severity: "block",
        message: `results are ${hours.toFixed(1)} h old (limit ${(cfg.maxResultsAgeMs / 3_600_000).toFixed(1)} h); refresh first`,
      });
    }
  }
  const errMs = results.last_error_at ? Date.parse(results.last_error_at) : NaN;
  if (Number.isFinite(errMs) && (!Number.isFinite(asOfMs) || errMs > asOfMs)) {
    trust.push({ code: "RESULTS_ERROR", severity: "info", message: `last refresh failed at ${results.last_error_at}` });
  }
  // Lander cannot tell which way is better: chance_to_win and the interval cannot be read safely.
  for (const m of [pickedPrimary, ...guardrails]) {
    if (m.direction === "unknown") {
      distrust = true;
      trust.push({
        code: "METRIC_DIRECTION_UNKNOWN",
        severity: "block",
        message: `metric ${m.name} has no readable expected direction (increase or decrease); cannot tell better from worse`,
      });
    }
  }
  if (distrust) return finish(filled, "REFUSE", "DO_NOT_TRUST", "DO NOT TRUST", trust);
  if (stale) return finish(filled, "REFUSE", "STALE", "STALE", trust);
  const live: Verdict = { ...filled, reasons: [...filled.reasons, ...trust] };

  // 3. Decide on the primary metric.
  const variants = arms.filter((a) => !a.isControl);
  const optionFor = (key: string): number | null =>
    exp.feature.multivariate_options.find((o) => (o.key ?? o.string_value ?? String(o.id)) === key)?.id ?? null;
  // chance_to_win orientation for decrease metrics is unverified on Flagsmith Cloud, so a verdict needs BOTH readings to
  // agree: a high chance AND a raw interval on the good side of zero (above for increase, below for decrease).
  // Were the orientation the other way round, the two would contradict and nothing would ship.
  const goodSide = (a: ArmStats): boolean =>
    primaryDir === "increase" ? a.ciLow !== null && a.ciLow > 0 : a.ciHigh !== null && a.ciHigh < 0;
  const movedBad = (a: ArmStats): boolean =>
    a.lift !== null && (primaryDir === "increase" ? a.lift < 0 : a.lift > 0);
  const winners = variants
    .filter((a) => a.chanceToWin !== null && a.chanceToWin >= cfg.winChance && goodSide(a))
    .sort((a, b) => (b.chanceToWin ?? 0) - (a.chanceToWin ?? 0));
  const best = winners[0];

  if (best) {
    // Guardrails: the winner must not be clearly losing on any other metric.
    // Harm under either reading of chance_to_win: a low chance, or a raw interval entirely on the harmful side.
    const harmed: Reason[] = [];
    const pending: Reason[] = [];
    for (const g of guardrails) {
      const inf = g.metric.inference[best.key];
      const gp = inf?.chance_to_win;
      const lo = inf?.ci_low;
      const hi = inf?.ci_high;
      const ciHarm = g.direction === "increase" ? typeof hi === "number" && hi < 0 : typeof lo === "number" && lo > 0;
      if ((typeof gp === "number" && gp < cfg.loseChance) || ciHarm) {
        const why = typeof gp === "number" ? `${pct(gp)} chance to beat control` : "interval on the harmful side";
        harmed.push({
          code: "GUARDRAIL_HARM",
          severity: "block",
          message: `${best.key} is likely worse on guardrail ${g.name} (${why})`,
        });
      } else if (typeof gp !== "number") {
        pending.push({
          code: "GUARDRAIL_PENDING",
          severity: "wait",
          message: `guardrail ${g.name} has no inference for ${best.key} yet; cannot rule out harm`,
        });
      }
    }
    if (harmed.length > 0) {
      const win: Reason = {
        code: "WIN",
        severity: "info",
        message: `${best.key} wins ${primaryName ?? "the primary metric"} (${pct(best.chanceToWin ?? 0)} chance to beat control)`,
      };
      return finish(live, "REFUSE", "GUARDRAIL_HARM", "GUARDRAIL HARM", [win, ...harmed]);
    }
    if (pending.length > 0) return finish(live, "KEEP_RUNNING", "KEEP_RUNNING", "KEEP RUNNING", pending);
    const optionId = optionFor(best.key);
    if (optionId === null) {
      return finish(live, "REFUSE", "DO_NOT_TRUST", "DO NOT TRUST", [
        {
          code: "UNMAPPED_WINNER",
          severity: "block",
          message: `${best.key} wins but matches no multivariate option of ${exp.feature.name}; cannot roll it out`,
        },
      ]);
    }
    const lift = best.lift !== null ? `, lift ${best.lift >= 0 ? "+" : ""}${pct(best.lift)} relative` : "";
    const ci = best.ciLow !== null && best.ciHigh !== null ? `, 95% interval ${pct(best.ciLow)} to ${pct(best.ciHigh)}` : "";
    return {
      ...finish(live, "SHIP", "SHIP_VARIANT", `SHIP ${best.key}`, [
        {
          code: "WIN",
          severity: "info",
          message: `${best.key} beats control with ${pct(best.chanceToWin ?? 0)} chance${lift}${ci}; split ok, guardrails ok`,
        },
      ]),
      winner: { variant: best.key, optionId },
    };
  }

  const allLose =
    variants.length > 0 &&
    variants.every((a) => a.chanceToWin !== null && a.chanceToWin < cfg.loseChance && movedBad(a));
  if (allLose) {
    return {
      ...finish(live, "SHIP", "SHIP_CONTROL", "SHIP CONTROL", [
        {
          code: "ALL_VARIANTS_LOSE",
          severity: "info",
          message: `every variant is below ${pct(cfg.loseChance)} chance to beat control; keep control, delete the variants`,
        },
      ]),
      winner: { variant: null, optionId: null },
    };
  }

  const ranked = variants.filter((a) => a.chanceToWin !== null).sort((a, b) => (b.chanceToWin ?? 0) - (a.chanceToWin ?? 0));
  const top = ranked[0];
  const detail = top
    ? `best arm ${top.key} at ${pct(top.chanceToWin ?? 0)} chance to beat control; ships above ${pct(cfg.winChance)} (interval excluding zero), control wins below ${pct(cfg.loseChance)}`
    : "no variant has an inference yet";
  return finish(live, "KEEP_RUNNING", "KEEP_RUNNING", "KEEP RUNNING", [
    { code: "INCONCLUSIVE", severity: "wait", message: `inconclusive: ${detail}` },
  ]);
}
