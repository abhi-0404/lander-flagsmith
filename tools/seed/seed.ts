/**
 * Seed the demo experiments through the Flagsmith CLI v2 (plan B7, A2 #17-#20).
 *
 *   pnpm seed --env staging            # needs keys, see .env.example
 *   pnpm seed --env staging --dry-run  # prints every command, needs no keys, calls nothing
 *
 * Steps: warehouse connection, metric, 3 multivariate flags with keyed variants,
 * 1 standard kill switch, then one experiment per multivariate flag, started.
 *
 * Payload shapes marked UNVERIFIED are guesses to be confirmed in the Phase 0
 * lifecycle spike (docs/cli-facts.md); the script prints the raw response when it
 * cannot find what it needs, so a mismatch is a one-line fix.
 */
import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { buildApiArgs, globalArgs, runFlagsmith, type HttpMethod } from "../../src/flagsmith/cli.js";
import { EXPERIMENT_FLAGS, KILL_SWITCH, METRIC, parseEnvName, type EnvName } from "../demoFlags.js";

const { values } = parseArgs({
  options: {
    env: { type: "string" },
    "dry-run": { type: "boolean", default: false },
    reset: { type: "boolean", default: false },
    warehouse: { type: "string", default: "flagsmith" },
  },
});

const dryRun = values["dry-run"] === true;
const envName: EnvName = parseEnvName(values.env);

if (existsSync(".env")) process.loadEnvFile(".env");

const projectId = process.env["FLAGSMITH_PROJECT_ID"] || (dryRun ? "<PROJECT_ID>" : "");
const envKey =
  (envName === "staging" ? process.env["LANDER_ENV_STAGING"] : process.env["LANDER_ENV_PRODUCTION"]) ||
  (dryRun ? "<ENV_KEY>" : "");
if (!projectId || !envKey) {
  console.error("Set FLAGSMITH_PROJECT_ID and LANDER_ENV_STAGING / LANDER_ENV_PRODUCTION in .env (see .env.example).");
  process.exit(1);
}
if (values.reset) {
  console.error("--reset is not implemented yet (see tools/seed/reset.ts).");
  process.exit(1);
}

type Json = any;

/** Run a CLI call, or print it when --dry-run. Returns parsed JSON (null if empty or dry). */
async function call(args: string[], stdin?: string): Promise<Json> {
  if (dryRun) {
    console.log(`[dry-run] flagsmith ${args.join(" ")}${stdin ? `   <<< ${stdin}` : ""}`);
    return null;
  }
  console.log(`flagsmith ${args.slice(0, 4).join(" ")} ...`);
  const out = (await runFlagsmith(args, stdin !== undefined ? { stdin } : {})).trim();
  return out ? JSON.parse(out) : null;
}

const scope = { project: projectId, environment: envKey };
const cli = (sub: string[]) => [...sub, ...globalArgs(scope)];
const api = (method: HttpMethod, path: string, body?: unknown) =>
  call(buildApiArgs(method, path, { ...scope, ...(body !== undefined ? { body } : {}) }), body !== undefined ? JSON.stringify(body) : undefined);

const asList = (r: Json): Json[] => (Array.isArray(r) ? r : Array.isArray(r?.results) ? r.results : []);

function need<T>(value: T | undefined | null, what: string, raw: Json): T {
  if (value === undefined || value === null) {
    throw new Error(`Could not find ${what} in the response. Raw response:\n${JSON.stringify(raw, null, 2)}`);
  }
  return value;
}

async function ensureWarehouse(): Promise<void> {
  const path = `api/v1/environments/${envKey}/warehouse-connections/`;
  const existing = asList(await api("GET", path));
  if (existing.length > 0) {
    console.log(`warehouse connection already present (${existing.length})`);
    return;
  }
  // Cloud managed warehouse. Self-hosted fallback body (06 section 4.2):
  // {"warehouse_type":"postgres","config":{"source":"flagsmith_database"}}   UNVERIFIED for Cloud.
  const body =
    values.warehouse === "flagsmith_database"
      ? { warehouse_type: "postgres", config: { source: "flagsmith_database" } }
      : { warehouse_type: "flagsmith" };
  await api("POST", path, body);
}

async function ensureMetric(): Promise<number | string> {
  const path = `api/v1/environments/${envKey}/experiment-metrics/`;
  const found = asList(await api("GET", path)).find((m) => m?.name === METRIC.name);
  if (found) return found.id;
  const created = await api("POST", path, {
    name: METRIC.name,
    aggregation: METRIC.aggregation,
    direction: METRIC.direction,
    definition: { version: 1, event: METRIC.event },
  });
  return dryRun ? "<METRIC_ID>" : need(created?.id, "metric id", created);
}

async function ensureMultivariateFlag(f: (typeof EXPERIMENT_FLAGS)[number]): Promise<{ featureId: number | string; variantId: number | string }> {
  const existing = await safeGet(["feature", "get", f.name]);
  if (!existing) {
    await call(cli(["feature", "create", f.name, "--value", f.controlValue, "--enabled", "--description", f.hypothesis]));
    await call(cli(["feature", "variant", "add", f.name, "--value", f.variantKey, "--key", f.variantKey, "--weight", String(f.variantWeight)]));
  } else {
    console.log(`feature ${f.name} already exists`);
  }
  const feature = dryRun ? { id: "<FEATURE_ID>", variants: [{ id: "<VARIANT_ID>", key: f.variantKey }] } : await call(cli(["feature", "get", f.name]));
  // Field names UNVERIFIED: tolerate `variants` or `multivariate_options`.
  const variants: Json[] = feature?.variants ?? feature?.multivariate_options ?? [];
  const variant = variants.find((v) => v?.key === f.variantKey);
  return {
    featureId: need(feature?.id, `${f.name} feature id`, feature),
    variantId: need(variant?.id, `${f.name} variant id for key ${f.variantKey}`, feature),
  };
}

async function safeGet(sub: string[]): Promise<Json | null> {
  if (dryRun) return null;
  try {
    return await call(cli(sub));
  } catch {
    return null;
  }
}

async function ensureKillSwitch(): Promise<void> {
  if (await safeGet(["feature", "get", KILL_SWITCH.name])) {
    console.log(`feature ${KILL_SWITCH.name} already exists`);
    return;
  }
  await call(cli(["feature", "create", KILL_SWITCH.name, "--description", KILL_SWITCH.description]));
}

async function createAndStartExperiment(
  f: (typeof EXPERIMENT_FLAGS)[number],
  ids: { featureId: number | string; variantId: number | string },
  metricId: number | string,
): Promise<void> {
  const base = `api/v1/environments/${envKey}/experiments/`;
  const already = asList(await api("GET", base)).find((e) => e?.name === `${f.name}_test`);
  if (already) {
    console.log(`experiment ${f.name}_test already exists (status ${already.status})`);
    return;
  }
  const created = await api("POST", base, {
    feature: ids.featureId,
    name: `${f.name}_test`,
    hypothesis: f.hypothesis,
    metrics: [{ metric: metricId, expected_direction: "increase" }],
    experiment_rollout: {
      enabled: true,
      rollout_percentage: 100,
      // type/value shape UNVERIFIED (Phase 0 spike).
      feature_state_value: { type: "unicode", value: f.controlValue },
      multivariate_feature_state_values: [
        { multivariate_feature_option: ids.variantId, percentage_allocation: f.variantWeight },
      ],
    },
  });
  const experimentId = dryRun ? "<EXPERIMENT_ID>" : need(created?.id, `${f.name} experiment id`, created);
  await api("POST", `${base}${experimentId}/start/`);
}

async function main(): Promise<void> {
  console.log(`Seeding ${envName}${dryRun ? " (dry run)" : ""}`);
  await ensureWarehouse();
  const metricId = await ensureMetric();
  const ids = new Map<string, { featureId: number | string; variantId: number | string }>();
  for (const f of EXPERIMENT_FLAGS) ids.set(f.name, await ensureMultivariateFlag(f));
  await ensureKillSwitch();
  for (const f of EXPERIMENT_FLAGS) await createAndStartExperiment(f, ids.get(f.name)!, metricId);
  console.log("Done. Next: pnpm simulate --env " + envName);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
