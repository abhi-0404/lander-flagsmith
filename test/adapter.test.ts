import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FlagsmithAdapter, type ApiCall } from "../src/flagsmith/adapter.js";
import { fixtureTransport } from "../src/flagsmith/fixtureTransport.js";
import { parseThrottleSeconds, REFRESH_MIN_INTERVAL_MS, RefreshThrottle } from "../src/flagsmith/refreshThrottle.js";
import { experimentSchema, metricResultSchema } from "../src/flagsmith/schemas.js";
import { FIXTURES, readJson } from "./helpers.js";

const REAL = join(FIXTURES, "real");
const ENV = "ENVKEY123";
const T0 = Date.parse("2026-11-25T14:44:00Z");

interface Call {
  method: string;
  path: string;
}

/** Wrap a transport, record calls, and let a test override individual answers. */
function recorder(
  inner: ApiCall,
  override?: (method: string, path: string) => Promise<unknown> | undefined,
): { call: ApiCall; calls: Call[] } {
  const calls: Call[] = [];
  const call: ApiCall = (method, path) => {
    calls.push({ method, path });
    return override?.(method, path) ?? inner(method, path);
  };
  return { call, calls };
}

const adapter = (call: ApiCall, extra: { throttle?: RefreshThrottle; now?: () => number } = {}) =>
  new FlagsmithAdapter({ call, sleep: async () => {}, now: extra.now ?? (() => T0), ...(extra.throttle ? { throttle: extra.throttle } : {}) });

describe("parseThrottleSeconds", () => {
  it("reads the real 429 body from the fixture", () => {
    const body = readJson("real", "experiments-results-refresh-throttled.json") as { detail: string };
    expect(parseThrottleSeconds(body.detail)).toBe(289);
  });

  it("recognises a CLI error mentioning 429 and falls back to the full window", () => {
    expect(parseThrottleSeconds("flagsmith api ... failed: HTTP 429 Too Many Requests")).toBe(300);
  });

  it("ignores other errors", () => {
    expect(parseThrottleSeconds("HTTP 500 server error")).toBeNull();
  });
});

describe("RefreshThrottle", () => {
  it("allows the first refresh, blocks for 5 minutes, then allows again", () => {
    const t = new RefreshThrottle();
    expect(t.canRefresh("k", T0)).toBe(true);
    t.recordRefresh("k", T0);
    expect(t.canRefresh("k", T0 + REFRESH_MIN_INTERVAL_MS - 1)).toBe(false);
    expect(t.secondsUntilAllowed("k", T0 + 60_000)).toBe(240);
    expect(t.canRefresh("k", T0 + REFRESH_MIN_INTERVAL_MS)).toBe(true);
  });

  it("honors a server retry-after", () => {
    const t = new RefreshThrottle();
    t.recordRetryAfter("k", T0, 289);
    expect(t.canRefresh("k", T0 + 288_000)).toBe(false);
    expect(t.canRefresh("k", T0 + 289_000)).toBe(true);
  });

  it("persists across instances through the state file", () => {
    const dir = mkdtempSync(join(tmpdir(), "lander-throttle-"));
    try {
      const file = join(dir, ".lander", "state.json");
      new RefreshThrottle(file).recordRefresh("env:1:results", T0);
      expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ refreshes: { "env:1:results": T0 } });
      expect(new RefreshThrottle(file).canRefresh("env:1:results", T0 + 1000)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("schemas on the real fixtures", () => {
  it("parses the experiment list item, detail and exposures", async () => {
    const a = adapter(fixtureTransport(REAL));
    const list = await a.listExperiments(ENV);
    expect(list).toHaveLength(1);
    expect(list[0]?.feature.multivariate_options.map((o) => o.key)).toEqual(["variant_a", "variant_b"]);
    const detail = await a.getExperiment(ENV, 1);
    expect(detail.experiment_rollout?.multivariate_feature_state_values).toHaveLength(2);
    const exposures = await a.getExposures(ENV, 1);
    expect(exposures?.payload.excluded_identities).toBe(0);
  });

  it("parses results, with srm_p_value null", async () => {
    const results = await adapter(fixtureTransport(REAL)).getResults(ENV, 1);
    expect(results?.payload.srm_p_value).toBeNull();
    expect(results?.payload.metrics[0]?.inference["variant_b"]?.chance_to_win).toBeCloseTo(0.9964, 3);
  });

  it("answers null for {results: null} and {exposures: null}", async () => {
    const call: ApiCall = async (_m, path) => (path.includes("results") ? readJson("real", "experiments-results-null.json") : readJson("real", "experiments-exposures-empty.json"));
    const a = adapter(call);
    expect(await a.getResults(ENV, 1)).toBeNull();
    expect(await a.getExposures(ENV, 1)).toBeNull();
  });

  it("rejects an unknown status with a readable error", () => {
    const bad = { ...(readJson("real", "experiments-detail-running-with-data.json") as object), status: "exploded" };
    expect(experimentSchema.safeParse(bad).success).toBe(false);
  });

  it("names the failing payload when the shape is wrong", async () => {
    const a = adapter(async () => ({ results: "nope" }));
    await expect(a.listExperiments(ENV)).rejects.toThrow(/Unexpected Flagsmith payload for experiments list/);
  });

  it("rejects unsafe environment keys before any call", async () => {
    const { call, calls } = recorder(fixtureTransport(REAL));
    await expect(adapter(call).listExperiments("a b;rm")).rejects.toThrow(/Unsafe flag key/);
    expect(calls).toHaveLength(0);
  });
});

describe("pagination", () => {
  it("follows next links", async () => {
    const one = readJson("real", "experiments-list.json") as { results: { id: number }[] };
    const mk = (id: number) => ({ ...one.results[0], id });
    const { call, calls } = recorder(async () => undefined, (_m, path) =>
      Promise.resolve(
        path.includes("page=2")
          ? { next: null, results: [mk(2)] }
          : { next: "https://api.flagsmith.com/api/v1/environments/x/experiments/?page=2", results: [mk(1)] },
      ),
    );
    const list = await adapter(call).listExperiments(ENV);
    expect(list.map((e) => e.id)).toEqual([1, 2]);
    expect(calls.map((c) => c.path)).toEqual([
      `api/v1/environments/${ENV}/experiments/`,
      `api/v1/environments/${ENV}/experiments/?page=2`,
    ]);
  });
});

describe("refresh throttle behavior", () => {
  const refreshCalls = (calls: Call[]) => calls.filter((c) => c.method === "POST");

  it("refreshes, then reads (POST refresh paths are exactly the documented ones)", async () => {
    const { call, calls } = recorder(fixtureTransport(REAL));
    const a = adapter(call);
    const list = await a.listExperiments(ENV);
    const ev = await a.collect(ENV, list[0]!, { refresh: true });
    expect(refreshCalls(calls).map((c) => c.path)).toEqual([
      `api/v1/environments/${ENV}/experiments/1/results/refresh/`,
      `api/v1/environments/${ENV}/experiments/1/exposures/refresh/`,
    ]);
    expect(ev.refresh.results).toEqual({ status: "refreshed" });
    expect(ev.results).not.toBeNull();
  });

  it("never refreshes twice inside 5 minutes (local guard) but still returns data", async () => {
    const { call, calls } = recorder(fixtureTransport(REAL));
    let now = T0;
    const a = adapter(call, { now: () => now });
    const list = await a.listExperiments(ENV);
    await a.collect(ENV, list[0]!, { refresh: true });
    now = T0 + 120_000;
    const second = await a.collect(ENV, list[0]!, { refresh: true });
    expect(refreshCalls(calls)).toHaveLength(2);
    expect(second.refresh.results).toMatchObject({ status: "throttled", source: "local", retryAfterSeconds: 180 });
    expect(second.results).not.toBeNull();
    now = T0 + REFRESH_MIN_INTERVAL_MS;
    await a.collect(ENV, list[0]!, { refresh: true });
    expect(refreshCalls(calls)).toHaveLength(4);
  });

  it("turns a server 429 (CLI error text) into a throttled outcome and remembers it", async () => {
    const detail = (readJson("real", "experiments-results-refresh-throttled.json") as { detail: string }).detail;
    const { call, calls } = recorder(fixtureTransport(REAL), (m) =>
      m === "POST" ? Promise.reject(new Error(`flagsmith api ... failed: ${detail}`)) : undefined,
    );
    const a = adapter(call);
    const first = await a.refresh(ENV, 1, "results");
    expect(first).toEqual({ status: "throttled", retryAfterSeconds: 289, source: "server" });
    const again = await a.refresh(ENV, 1, "results");
    expect(again).toMatchObject({ status: "throttled", source: "local" });
    expect(refreshCalls(calls)).toHaveLength(1);
  });

  it("treats a 429 body that arrives with exit code 0 as throttled too", async () => {
    const body = readJson("real", "experiments-results-refresh-throttled.json");
    const { call } = recorder(fixtureTransport(REAL), (m) => (m === "POST" ? Promise.resolve(body) : undefined));
    expect(await adapter(call).refresh(ENV, 1, "results")).toMatchObject({ status: "throttled", retryAfterSeconds: 289 });
  });

  it("rethrows non-throttle errors", async () => {
    const { call } = recorder(fixtureTransport(REAL), (m) => (m === "POST" ? Promise.reject(new Error("HTTP 500")) : undefined));
    await expect(adapter(call).refresh(ENV, 1, "results")).rejects.toThrow("HTTP 500");
  });

  it("does not refresh completed experiments or when refresh is off", async () => {
    const { call, calls } = recorder(fixtureTransport(REAL));
    const a = adapter(call);
    const list = await a.listExperiments(ENV);
    await a.collect(ENV, list[0]!, { refresh: false });
    expect(refreshCalls(calls)).toHaveLength(0);
    const done = recorder(fixtureTransport(REAL), (m, p) =>
      m === "GET" && /\/experiments\/1\/$/.test(p)
        ? Promise.resolve({ ...(readJson("real", "experiments-detail-running-with-data.json") as object), status: "completed" })
        : undefined,
    );
    await adapter(done.call).collect(ENV, list[0]!, { refresh: true });
    expect(refreshCalls(done.calls)).toHaveLength(0);
  });

  it("re-reads results that are still null just after a refresh", async () => {
    let reads = 0;
    const { call } = recorder(fixtureTransport(REAL), (m, p) => {
      if (m === "GET" && p.endsWith("/results/")) {
        reads += 1;
        if (reads < 3) return Promise.resolve({ results: null });
      }
      return undefined;
    });
    const a = adapter(call);
    const list = await a.listExperiments(ENV);
    const ev = await a.collect(ENV, list[0]!, { refresh: true });
    expect(reads).toBe(3);
    expect(ev.results).not.toBeNull();
  });
});

describe("fixture transport", () => {
  it("is read only", async () => {
    await expect(fixtureTransport(REAL)("DELETE", `api/v1/environments/${ENV}/experiments/1/`)).rejects.toThrow(/read only/);
  });
});

describe("results with a null inference (seen live on self-hosted 2.295.2)", () => {
  it("keeps the arm as a variant with no numbers instead of failing the scan", () => {
    const m = metricResultSchema.parse({
      metric_id: 1,
      variants: { control: { n: 10, sum: 1 }, "one-step": { n: 9, sum: 2 } },
      inference: { "one-step": null },
    });
    expect(m.inference["one-step"]).toEqual({});
    expect("control" in m.inference).toBe(false);
  });
});
