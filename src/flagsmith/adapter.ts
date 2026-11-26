import type { RolloutDecision } from "../plan/types.js";
import { assertFlagKey, flagsmithApi, type HttpMethod } from "./cli.js";
import { parseThrottleSeconds, RefreshThrottle } from "./refreshThrottle.js";
import {
  experimentListPageSchema,
  experimentSchema,
  exposuresEnvelopeSchema,
  featureListPageSchema,
  parseWith,
  resultsEnvelopeSchema,
  type Experiment,
  type ExperimentExposures,
  type ExperimentResults,
  type FeatureSummary,
} from "./schemas.js";

/**
 * The only place that knows Flagsmith paths and payload shapes. Everything goes through one `ApiCall`, which is
 * the `flagsmith api <path> -X <METHOD> --json --no-input` wrapper in production and a fixture reader offline.
 * Paths are relative to https://api.flagsmith.com/ ; `env` is the environment API key.
 */
export type ApiCall = (method: HttpMethod, path: string, body?: unknown) => Promise<unknown>;

/** Production transport: the Flagsmith CLI wrapper (execFile, argument array, no shell). */
export const cliTransport: ApiCall = (method, path, body) =>
  flagsmithApi(method, path, body !== undefined ? { body } : {});

export type RefreshKind = "results" | "exposures";

export type RefreshOutcome =
  | { status: "refreshed" }
  /** Not sent: either Lander's own 5 minute guard or a 429 from Flagsmith. */
  | { status: "throttled"; retryAfterSeconds: number; source: "local" | "server" };

export interface AdapterOptions {
  call: ApiCall;
  throttle?: RefreshThrottle;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Wait after a refresh before reading (Flagsmith fills results within a second or two). */
  settleMs?: number;
  /** How many times to re-read results that are still null after a refresh. */
  settleAttempts?: number;
}

export interface Evidence {
  experiment: Experiment;
  results: ExperimentResults | null;
  exposures: ExperimentExposures | null;
  refresh: { results: RefreshOutcome | null; exposures: RefreshOutcome | null };
}

const MAX_PAGES = 20;

function intId(id: number): number {
  if (!Number.isInteger(id) || id <= 0) throw new Error(`Bad experiment id: ${String(id)}`);
  return id;
}

/** Page number from a DRF `next` link (absolute URL or relative query). */
function nextPage(next: string | null | undefined): number | null {
  if (!next) return null;
  const m = /[?&]page=(\d+)/.exec(next);
  return m ? Number(m[1]) : null;
}

export class FlagsmithAdapter {
  private readonly call: ApiCall;
  private readonly throttle: RefreshThrottle;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly settleMs: number;
  private readonly settleAttempts: number;

  constructor(opts: AdapterOptions) {
    this.call = opts.call;
    this.throttle = opts.throttle ?? new RefreshThrottle();
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.settleMs = opts.settleMs ?? 1500;
    this.settleAttempts = opts.settleAttempts ?? 3;
  }

  private expPath(env: string, id?: number, tail = ""): string {
    const base = `api/v1/environments/${assertFlagKey(env)}/experiments/`;
    return id === undefined ? base : `${base}${intId(id)}/${tail}`;
  }

  /** All experiments in an environment (follows pagination). */
  async listExperiments(env: string): Promise<Experiment[]> {
    const out: Experiment[] = [];
    let page = 1;
    for (let i = 0; i < MAX_PAGES; i++) {
      const path = this.expPath(env) + (page > 1 ? `?page=${page}` : "");
      const data = parseWith(experimentListPageSchema, await this.call("GET", path), "experiments list");
      out.push(...data.results);
      const np = nextPage(data.next);
      if (np === null) break;
      page = np;
    }
    return out;
  }

  /** Detail view: carries `experiment_rollout` (arm allocations) that the list view omits. */
  async getExperiment(env: string, id: number): Promise<Experiment> {
    return parseWith(experimentSchema, await this.call("GET", this.expPath(env, id)), `experiment ${id}`);
  }

  /**
   * POST .../{kind}/refresh/. Flagsmith answers 202 with a null body, or 429 inside the 5 minute window
   * ("Expected available in N seconds."). The 429 never throws: it becomes a `throttled` outcome and is remembered.
   */
  async refresh(env: string, id: number, kind: RefreshKind): Promise<RefreshOutcome> {
    const key = `${env}:${id}:${kind}`;
    const t = this.now();
    if (!this.throttle.canRefresh(key, t)) {
      return { status: "throttled", retryAfterSeconds: this.throttle.secondsUntilAllowed(key, t), source: "local" };
    }
    let body: unknown;
    try {
      body = await this.call("POST", this.expPath(env, id, `${kind}/refresh/`));
    } catch (err) {
      const seconds = parseThrottleSeconds(err instanceof Error ? err.message : String(err));
      if (seconds === null) throw err;
      this.throttle.recordRetryAfter(key, t, seconds);
      return { status: "throttled", retryAfterSeconds: seconds, source: "server" };
    }
    // Some CLI builds print a non-2xx body and still exit 0.
    const detail =
      body && typeof body === "object" && "detail" in body ? String((body as { detail: unknown }).detail) : "";
    const seconds = detail ? parseThrottleSeconds(detail) : null;
    if (seconds !== null) {
      this.throttle.recordRetryAfter(key, t, seconds);
      return { status: "throttled", retryAfterSeconds: seconds, source: "server" };
    }
    this.throttle.recordRefresh(key, t);
    return { status: "refreshed" };
  }

  /** Request body of `POST .../complete/` (A2 #9). Pure. */
  static completeBody(decision: RolloutDecision): Record<string, unknown> {
    return decision.decision === "variant"
      ? { rollout_decision: "variant", rollout_variant: decision.variantOptionId }
      : { rollout_decision: "control" };
  }

  /** `.../complete/` path with the environment placeholder, as stored in the plan. */
  static completePathTemplate(experimentId: number): string {
    return `api/v1/environments/{env}/experiments/${intId(experimentId)}/complete/`;
  }

  /** WRITE. Ends the experiment and rolls out the decision. Irreversible. Only the executor calls this, after approval. */
  async completeExperiment(env: string, id: number, decision: RolloutDecision): Promise<unknown> {
    return this.call("POST", this.expPath(env, id, "complete/"), FlagsmithAdapter.completeBody(decision));
  }

  /** Null until the first refresh has computed something. */
  async getResults(env: string, id: number): Promise<ExperimentResults | null> {
    const data = parseWith(resultsEnvelopeSchema, await this.call("GET", this.expPath(env, id, "results/")), `results ${id}`);
    return data.results;
  }

  async getExposures(env: string, id: number): Promise<ExperimentExposures | null> {
    const data = parseWith(
      exposuresEnvelopeSchema,
      await this.call("GET", this.expPath(env, id, "exposures/")),
      `exposures ${id}`,
    );
    return data.exposures;
  }

  /** Features of a project (for flags that have no experiment). Follows pagination. */
  async listFeatures(projectId: string | number): Promise<FeatureSummary[]> {
    const pid = assertFlagKey(String(projectId));
    const out: FeatureSummary[] = [];
    let page = 1;
    for (let i = 0; i < MAX_PAGES; i++) {
      const path = `api/v1/projects/${pid}/features/` + (page > 1 ? `?page=${page}` : "");
      const data = parseWith(featureListPageSchema, await this.call("GET", path), "features list");
      out.push(...data.results);
      const np = nextPage(data.next);
      if (np === null) break;
      page = np;
    }
    return out;
  }

  /**
   * Everything the verdict engine needs for one experiment. With `refresh` true it refreshes results and exposures
   * (honoring the throttle), waits for them to settle, then reads. Detail fetch failures fall back to the list item.
   */
  async collect(env: string, listed: Experiment, opts: { refresh: boolean }): Promise<Evidence> {
    const id = listed.id;
    let experiment = listed;
    try {
      experiment = await this.getExperiment(env, id);
    } catch {
      // The list view lacks experiment_rollout only; the verdict then assumes an equal split.
    }
    const refreshable = opts.refresh && (experiment.status === "running" || experiment.status === "paused");
    const refresh: Evidence["refresh"] = { results: null, exposures: null };
    if (refreshable) {
      refresh.results = await this.refresh(env, id, "results");
      refresh.exposures = await this.refresh(env, id, "exposures");
    }
    const didRefresh = refresh.results?.status === "refreshed" || refresh.exposures?.status === "refreshed";
    if (didRefresh) await this.sleep(this.settleMs);
    let results = await this.getResults(env, id);
    for (let i = 0; didRefresh && results === null && i < this.settleAttempts; i++) {
      await this.sleep(this.settleMs);
      results = await this.getResults(env, id);
    }
    const exposures = await this.getExposures(env, id);
    return { experiment, results, exposures, refresh };
  }
}
