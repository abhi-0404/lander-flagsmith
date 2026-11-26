import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  experimentSchema,
  exposuresEnvelopeSchema,
  resultsEnvelopeSchema,
  type Experiment,
  type ExperimentExposures,
  type ExperimentResults,
} from "../src/flagsmith/schemas.js";

export const FIXTURES = join(import.meta.dirname, "..", "fixtures");

export function readJson(...parts: string[]): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, ...parts), "utf8")) as unknown;
}

export interface Evidence {
  experiment: Experiment;
  results: ExperimentResults | null;
  exposures: ExperimentExposures | null;
}

/** Load one experiment's evidence from a fixture folder (real capture or demo set). */
export function loadEvidence(dir: "real" | "demo", id: number): Evidence {
  const detailName = dir === "real" ? "experiments-detail-running-with-data.json" : `experiments-detail-${id}.json`;
  const resName = dir === "real" ? "experiments-results.json" : `experiments-results-${id}.json`;
  const expName = dir === "real" ? "experiments-exposures.json" : `experiments-exposures-${id}.json`;
  return {
    experiment: experimentSchema.parse(readJson(dir, detailName)),
    results: resultsEnvelopeSchema.parse(readJson(dir, resName)).results,
    exposures: exposuresEnvelopeSchema.parse(readJson(dir, expName)).exposures,
  };
}

export const AS_OF = "2026-11-26T09:00:00.000Z";
export const AS_OF_MS = Date.parse(AS_OF);

export interface SynthArm {
  n: number;
  conv: number;
  /** Inference vs control (omit for control). */
  chance?: number;
  lift?: number;
  ciLow?: number;
  ciHigh?: number;
}

export interface SynthOptions {
  /** Flag (feature) name, default flag_x. */
  flag?: string;
  /** Feature initial value (the control branch value in code), default "control". */
  initialValue?: string;
  status?: "created" | "running" | "paused" | "completed";
  /** control arm counts. Its key is always "control". */
  control: { n: number; conv: number };
  /** variant key -> arm. */
  variants: Record<string, SynthArm>;
  /** Allocation percent per variant (control gets the rest). Omit to leave experiment_rollout out. */
  weights?: Record<string, number>;
  /** Second metric (guardrail): per variant chance_to_win. */
  guardrail?: Record<string, number>;
  /** Guardrail interval per variant (default -0.1 to 0.3). */
  guardrailCi?: Record<string, [number, number]>;
  /** expected_direction of the primary metric (default "increase"); null leaves both direction fields out. */
  primaryDirection?: string | null;
  /** expected_direction of the guardrail (default "decrease"). */
  guardrailDirection?: string | null;
  asOf?: string | null;
  isFinal?: boolean;
  excluded?: number;
  srmPValue?: number | null;
  lastErrorAt?: string | null;
  results?: null;
}

/** Build a synthetic experiment, results and exposures that parse with the real schemas. */
export function synth(o: SynthOptions): Evidence {
  const keys = Object.keys(o.variants);
  const options = keys.map((k, i) => ({ id: i + 1, key: k, string_value: k, default_percentage_allocation: 0 }));
  const dir = (d: string | null | undefined, dflt: string): Record<string, string> =>
    d === null ? {} : { expected_direction: d ?? dflt };
  const metrics: Record<string, unknown>[] = [
    { id: 1, metric: 1, metric_name: "checkout_completed", ...dir(o.primaryDirection, "increase") },
  ];
  if (o.guardrail) metrics.push({ id: 2, metric: 2, metric_name: "refund_requested", ...dir(o.guardrailDirection, "decrease") });
  const experiment = experimentSchema.parse({
    id: 1,
    feature: { id: 1, name: o.flag ?? "flag_x", initial_value: o.initialValue ?? "control", multivariate_options: options },
    name: "Synthetic",
    status: o.status ?? "running",
    metrics,
    ...(o.weights
      ? {
          experiment_rollout: {
            multivariate_feature_state_values: options.map((op) => ({
              multivariate_feature_option: op.id,
              percentage_allocation: o.weights?.[op.key] ?? 0,
            })),
          },
        }
      : {}),
  });
  if (o.results === null) return { experiment, results: null, exposures: null };

  const variantsCell: Record<string, { n: number; sum: number }> = { control: { n: o.control.n, sum: o.control.conv } };
  const inference: Record<string, unknown> = {};
  for (const [k, a] of Object.entries(o.variants)) {
    variantsCell[k] = { n: a.n, sum: a.conv };
    inference[k] = {
      lift: a.lift ?? 0.1,
      ci_low: a.ciLow ?? 0.01,
      ci_high: a.ciHigh ?? 0.2,
      chance_to_win: a.chance ?? 0.5,
    };
  }
  const metricsOut: unknown[] = [{ metric_id: 1, variants: variantsCell, inference }];
  if (o.guardrail) {
    const gi: Record<string, unknown> = {};
    for (const [k, c] of Object.entries(o.guardrail)) {
      const [lo, hi] = o.guardrailCi?.[k] ?? [-0.1, 0.3];
      gi[k] = { lift: (lo + hi) / 2, ci_low: lo, ci_high: hi, chance_to_win: c };
    }
    metricsOut.push({ metric_id: 2, variants: variantsCell, inference: gi });
  }
  const counts: Record<string, number> = { control: o.control.n };
  for (const [k, a] of Object.entries(o.variants)) counts[k] = a.n;
  const series = { granularity: "hour", points: [{ bucket: "2026-11-25T08:00:00+00:00", new_identities: counts }] };
  const results = resultsEnvelopeSchema.parse({
    results: {
      as_of: o.asOf === undefined ? AS_OF : o.asOf,
      last_error_at: o.lastErrorAt ?? null,
      is_final: o.isFinal ?? false,
      payload: { metrics: metricsOut, srm_p_value: o.srmPValue ?? null, exposures_timeseries: series },
    },
  }).results;
  const exposures = exposuresEnvelopeSchema.parse({
    exposures: { as_of: AS_OF, payload: { timeseries: series, excluded_identities: o.excluded ?? 0 } },
  }).exposures;
  return { experiment, results, exposures };
}
