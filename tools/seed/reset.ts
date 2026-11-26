/**
 * `seed --reset`: remove what seed created in ONE environment so it can be seeded again, in this order
 * (verified on self-hosted 2.295.2, a running experiment cannot be deleted):
 *   1. every `<flag>_test` experiment of the demo flags: pause if running, then DELETE
 *   2. the demo metric of this environment (DELETE .../experiment-metrics/<id>/)
 *   3. the demo features (flag deletion is project wide, so a feature is kept while ANOTHER environment still has an
 *      experiment on it; pass that environment's key as `otherEnvironmentKey` to get that protection)
 * Nothing else is touched: flags and experiments that are not in the demo list are never read for deletion.
 */
import { EXPERIMENT_FLAGS, KILL_SWITCH, METRIC } from "../demoFlags.js";

export type ResetApi = (method: "GET" | "POST" | "DELETE", path: string) => Promise<unknown>;

export interface ResetDeps {
  api: ResetApi;
  /** `flagsmith feature delete <name> --yes`; resolves false when the feature does not exist. */
  deleteFeature: (name: string) => Promise<boolean>;
  envKey: string;
  otherEnvironmentKey?: string;
  log: (line: string) => void;
}

interface ExperimentRow {
  id?: number;
  name?: string;
  status?: string;
  feature?: { name?: string } | number | null;
}

const asList = (r: unknown): Record<string, unknown>[] => {
  if (Array.isArray(r)) return r as Record<string, unknown>[];
  const results = (r as { results?: unknown } | null)?.results;
  return Array.isArray(results) ? (results as Record<string, unknown>[]) : [];
};

export interface ResetSummary {
  experimentsDeleted: string[];
  metricDeleted: boolean;
  featuresDeleted: string[];
  featuresKept: string[];
}

export async function resetDemo(deps: ResetDeps): Promise<ResetSummary> {
  const { api, deleteFeature, envKey, log } = deps;
  const demoNames = new Set(EXPERIMENT_FLAGS.map((f) => `${f.name}_test`));
  const summary: ResetSummary = { experimentsDeleted: [], metricDeleted: false, featuresDeleted: [], featuresKept: [] };

  for (const e of asList(await api("GET", `api/v1/environments/${envKey}/experiments/`)) as ExperimentRow[]) {
    if (!e.name || !demoNames.has(e.name) || typeof e.id !== "number") continue;
    // A created experiment is deletable as is; only a running one needs the pause first.
    if (e.status === "running") await api("POST", `api/v1/environments/${envKey}/experiments/${e.id}/pause/`);
    await api("DELETE", `api/v1/environments/${envKey}/experiments/${e.id}/`);
    summary.experimentsDeleted.push(e.name);
    log(`deleted experiment ${e.name} (${e.id})`);
  }

  const metric = asList(await api("GET", `api/v1/environments/${envKey}/experiment-metrics/`)).find((m) => m["name"] === METRIC.name);
  if (metric && typeof metric["id"] === "number") {
    await api("DELETE", `api/v1/environments/${envKey}/experiment-metrics/${metric["id"]}/`);
    summary.metricDeleted = true;
    log(`deleted metric ${METRIC.name}`);
  }

  const busyElsewhere = new Set<string>();
  if (deps.otherEnvironmentKey && deps.otherEnvironmentKey !== envKey) {
    for (const e of asList(await api("GET", `api/v1/environments/${deps.otherEnvironmentKey}/experiments/`)) as ExperimentRow[]) {
      if (e.name && demoNames.has(e.name)) busyElsewhere.add(e.name.replace(/_test$/, ""));
    }
  }
  for (const name of [...EXPERIMENT_FLAGS.map((f) => f.name), KILL_SWITCH.name]) {
    if (busyElsewhere.has(name)) {
      summary.featuresKept.push(name);
      log(`kept feature ${name} (another environment still has an experiment on it)`);
      continue;
    }
    if (await deleteFeature(name)) {
      summary.featuresDeleted.push(name);
      log(`deleted feature ${name}`);
    }
  }
  return summary;
}
