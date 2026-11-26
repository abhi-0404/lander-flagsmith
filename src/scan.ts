import type { FlagsmithAdapter, RefreshOutcome } from "./flagsmith/adapter.js";
import { renderTable } from "./output/table.js";
import { bold, green, red, yellow } from "./output/colors.js";
import { computeVerdict, type Decision, type Verdict, type VerdictConfig } from "./verdict/engine.js";

export interface ScanRow {
  experimentId: number;
  experiment: string;
  flag: string;
  featureId: number;
  status: string;
  verdict: Verdict;
  refresh: { results: RefreshOutcome | null; exposures: RefreshOutcome | null };
}

export interface ScanReport {
  /** "fixtures": recorded responses replayed offline, NOT live Flagsmith data. Never land from a fixtures scan. */
  source: { mode: "live" } | { mode: "fixtures"; dir: string };
  environment: string;
  /** ISO time the verdicts were computed against (the replay clock when reading fixtures). */
  evaluatedAt: string;
  experiments: ScanRow[];
  /** Flags in the project that have no experiment: left alone (kill switches, plain toggles). */
  notMine: string[];
  warnings: string[];
  summary: Record<Decision, number> & { notMine: number };
}

export interface ScanOptions {
  /** Refresh results and exposures first (honors the 5 minute throttle). */
  refresh: boolean;
  /** Fixed clock for the stale check. Omit for the real clock; fixtures pass "replay". */
  now?: number | "replay";
  projectId?: string;
  config?: Partial<VerdictConfig>;
  /** Set when the adapter reads a fixture folder, so the output can never pass for live data. */
  fixturesDir?: string;
}

export async function runScan(adapter: FlagsmithAdapter, env: string, opts: ScanOptions): Promise<ScanReport> {
  const listed = await adapter.listExperiments(env);
  const evidence = [];
  for (const e of listed) evidence.push(await adapter.collect(env, e, { refresh: opts.refresh }));

  let nowMs: number;
  if (opts.now === "replay") {
    // Offline replay: freeze the clock at the newest computation time in the fixtures, so "stale" is not a lie.
    const times = evidence.map((x) => (x.results?.as_of ? Date.parse(x.results.as_of) : NaN)).filter(Number.isFinite);
    nowMs = times.length > 0 ? Math.max(...times) : Date.now();
  } else {
    nowMs = opts.now ?? Date.now();
  }

  const experiments: ScanRow[] = evidence.map((x) => ({
    experimentId: x.experiment.id,
    experiment: x.experiment.name,
    flag: x.experiment.feature.name,
    featureId: x.experiment.feature.id,
    status: x.experiment.status,
    verdict: computeVerdict({
      experiment: x.experiment,
      results: x.results,
      exposures: x.exposures,
      nowMs,
      ...(opts.config ? { config: opts.config } : {}),
    }),
    refresh: x.refresh,
  }));

  const warnings: string[] = [];
  let notMine: string[] = [];
  if (opts.projectId) {
    try {
      const withExperiment = new Set(experiments.map((r) => r.featureId));
      notMine = (await adapter.listFeatures(opts.projectId))
        .filter((f) => !f.is_archived && !withExperiment.has(f.id))
        .map((f) => f.name);
    } catch (err) {
      warnings.push(`could not list project flags for the "not mine" check: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  for (const r of experiments) {
    for (const [kind, o] of Object.entries(r.refresh)) {
      if (o && o.status === "throttled") {
        warnings.push(
          `${r.flag}: ${kind} refresh skipped (${o.source === "server" ? "Flagsmith returned 429" : "Lander's 5 minute guard"}, retry in ${o.retryAfterSeconds} s); using results as of ${r.verdict.asOf ?? "n/a"}`,
        );
      }
    }
  }

  const summary = { SHIP: 0, KEEP_RUNNING: 0, REFUSE: 0, notMine: notMine.length };
  for (const r of experiments) summary[r.verdict.decision]++;
  return {
    source: opts.fixturesDir !== undefined ? { mode: "fixtures", dir: opts.fixturesDir } : { mode: "live" },
    environment: env,
    evaluatedAt: new Date(nowMs).toISOString(),
    experiments,
    notMine,
    warnings,
    summary,
  };
}

const colorFor = (d: Decision): ((s: string) => string) => (d === "SHIP" ? green : d === "REFUSE" ? red : yellow);
const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;

function bestArm(v: Verdict): string {
  const top = v.arms
    .filter((a) => !a.isControl && a.chanceToWin !== null)
    .sort((a, b) => (b.chanceToWin ?? 0) - (a.chanceToWin ?? 0))[0];
  return top ? `${top.key} ${pct(top.chanceToWin ?? 0)}` : "-";
}

function exposuresCell(v: Verdict): string {
  if (v.arms.length === 0) return "-";
  return v.arms.map((a) => String(a.exposures)).join(" / ");
}

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}~` : s);

/** Human table plus the reasons under it. */
export function renderScan(report: ScanReport): string {
  const out: string[] = [];
  if (report.source.mode === "fixtures") {
    out.push(yellow(bold(`FIXTURES REPLAY from ${report.source.dir}: recorded data, not live Flagsmith. Nothing here can be landed.`)));
  }
  const where = report.source.mode === "fixtures" ? "fixtures" : "live";
  out.push(bold(`Lander scan (${where}): environment ${report.environment} (evaluated ${report.evaluatedAt})`));
  out.push("");
  if (report.experiments.length === 0) {
    out.push("No experiments in this environment.");
  } else {
    const rows = report.experiments.map((r) => [
      String(r.experimentId),
      clip(r.experiment, 30),
      r.flag,
      r.status,
      exposuresCell(r.verdict),
      bestArm(r.verdict),
      colorFor(r.verdict.decision)(r.verdict.label),
    ]);
    out.push(renderTable(["ID", "EXPERIMENT", "FLAG", "STATUS", "EXPOSURES (arms)", "BEST ARM, CHANCE TO BEAT CONTROL", "VERDICT"], rows));
    out.push("");
    out.push(bold("Why"));
    for (const r of report.experiments) {
      const color = colorFor(r.verdict.decision);
      out.push(`  ${color(r.verdict.label)}  ${r.flag} (experiment ${r.experimentId}, primary metric ${r.verdict.metricName ?? "n/a"})`);
      const reasons = r.verdict.reasons.filter((x) => x.severity !== "info" || x.code === "WIN" || x.code === "ALL_VARIANTS_LOSE" || x.code === "PAUSED" || x.code === "RESULTS_ERROR");
      for (const reason of reasons) out.push(`    - ${reason.message}`);
      if (r.verdict.etaHours !== null) out.push(`    - about ${r.verdict.etaHours} h to reach the floors at the current pace`);
    }
  }
  if (report.notMine.length > 0) {
    out.push("");
    out.push(`${bold("Not mine")} (no experiment, left alone): ${report.notMine.join(", ")}`);
  }
  for (const w of report.warnings) out.push(`\n${yellow("note")}: ${w}`);
  const s = report.summary;
  out.push("");
  out.push(`${s.SHIP} ready to ship, ${s.KEEP_RUNNING} keep running, ${s.REFUSE} refused, ${s.notMine} not mine`);
  return out.join("\n");
}
