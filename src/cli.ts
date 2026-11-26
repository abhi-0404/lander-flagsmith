#!/usr/bin/env node
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { Command } from "commander";
import { loadConfig, resolveEnvironmentKey } from "./config.js";
import { cliTransport, FlagsmithAdapter } from "./flagsmith/adapter.js";
import { fixtureTransport } from "./flagsmith/fixtureTransport.js";
import { RefreshThrottle } from "./flagsmith/refreshThrottle.js";
import { renderScan, runScan } from "./scan.js";
import { Journal } from "./executor/journal.js";
import { FixturesLandPort, LiveLandPort } from "./flagsmith/landPort.js";
import { LandRefused } from "./plan/builder.js";
import { defaultApprovalIO } from "./plan/approve.js";
import { PlanStore } from "./plan/store.js";
import { resolveLandEnvironment, runApply, runLand, runRollback, type RunContext } from "./land.js";
import { codemodEdits } from "./repo/edits.js";
import { realRunner } from "./executor/runner.js";
import { renderRetire, runRetireChecks } from "./executor/retire.js";
import { CodeStageStopped } from "./executor/apply.js";
import { CodeChangeFailed } from "./executor/codeChange.js";

const program = new Command();
program
  .name("lander")
  .description(
    "Lander lands the Flagsmith experiments you already have, and refuses the ones you should not trust.",
  )
  .version("0.1.0");

program
  .command("scan")
  .description("List experiments with a deterministic verdict for each (no LLM, read only)")
  .option("--env <name>", "environment name (staging, production) or a raw environment key", "staging")
  .option("--json", "JSON output")
  .option("--fixtures <dir>", "read recorded Flagsmith responses from a folder instead of calling Flagsmith (offline demo)")
  .option("--no-refresh", "do not ask Flagsmith to refresh results and exposures first")
  .option("--now <iso>", "evaluate staleness at this time instead of the real clock")
  .option("--project <id>", "project id, to list flags that have no experiment (default FLAGSMITH_PROJECT_ID)")
  .action(
    async (opts: { env: string; json?: boolean; fixtures?: string; refresh: boolean; now?: string; project?: string }) => {
      let nowOpt: number | "replay" | undefined;
      if (opts.now !== undefined) {
        nowOpt = Date.parse(opts.now);
        if (!Number.isFinite(nowOpt)) throw new Error(`--now: not a date: ${opts.now}`);
      } else if (opts.fixtures) {
        nowOpt = "replay";
      }
      let report;
      if (opts.fixtures) {
        const adapter = new FlagsmithAdapter({ call: fixtureTransport(opts.fixtures), settleMs: 0 });
        report = await runScan(adapter, opts.env, {
          refresh: opts.refresh,
          fixturesDir: opts.fixtures,
          ...(nowOpt !== undefined ? { now: nowOpt } : {}),
          ...(opts.project || ["features-list.json", "features-list-with-env.json"].some((f) => existsSync(join(opts.fixtures as string, f)))
            ? { projectId: opts.project ?? "1" }
            : {}),
        });
      } else {
        const cfg = loadConfig();
        const envKey = resolveEnvironmentKey(cfg, opts.env);
        const adapter = new FlagsmithAdapter({ call: cliTransport, throttle: new RefreshThrottle(".lander/state.json") });
        const projectId = opts.project ?? (cfg.FLAGSMITH_PROJECT_ID || undefined);
        report = await runScan(adapter, envKey, {
          refresh: opts.refresh,
          ...(nowOpt !== undefined ? { now: nowOpt } : {}),
          ...(projectId ? { projectId } : {}),
        });
        report.environment = opts.env;
      }
      console.log(opts.json ? JSON.stringify(report, null, 2) : renderScan(report));
    },
  );

const LANDER_DIR = ".lander";

function livePort(): LiveLandPort {
  return new LiveLandPort(new FlagsmithAdapter({ call: cliTransport, throttle: new RefreshThrottle(`${LANDER_DIR}/state.json`) }));
}

/** B6 settings for a run: the target repo from .env. Null when code changes are switched off or the repo is missing. */
function codeContext(cfg: ReturnType<typeof loadConfig>, enabled: boolean, mustExist: boolean): RunContext["code"] | undefined {
  if (!enabled) return undefined;
  const repoPath = resolve(cfg.LANDER_REPO_PATH);
  if (!existsSync(repoPath)) {
    if (mustExist) throw new Error(`LANDER_REPO_PATH does not exist: ${repoPath}. Set it in .env, or land only the flag with --no-code.`);
    return undefined;
  }
  return { provider: codemodEdits, repoPath, baseBranch: cfg.LANDER_BASE_BRANCH, runner: realRunner };
}

function baseContext(json: boolean | undefined): Pick<RunContext, "store" | "journal" | "io" | "log" | "clock" | "cfg"> & { loaded: ReturnType<typeof loadConfig> } {
  const cfg = loadConfig();
  return {
    loaded: cfg,
    cfg,
    store: new PlanStore(LANDER_DIR),
    journal: new Journal(`${LANDER_DIR}/journal.jsonl`),
    io: defaultApprovalIO(),
    // --json keeps stdout machine readable: progress goes to stderr.
    log: (line: string) => (json ? console.error(line) : console.log(line)),
    clock: { now: Date.now },
  };
}

program
  .command("land")
  .description("Re-check the verdict, build a plan, get typed approval, then complete the experiment (SHIP verdicts only)")
  .argument("<flag>", "flag key of the experiment to land")
  .option("--env <name>", "environment name (staging, production)", "staging")
  .option("--dry-run", "run everything except writes (no plan file, no journal, no Flagsmith write)")
  .option("--fixtures <dir>", "read recorded responses instead of Flagsmith (dry run only)")
  .option("--no-code", "land only the flag: no code edits, branch or PR (default: also open a draft PR that removes the losing branches)")
  .option("--explain", "rewrite the decision brief in plain words with a model (needs ANTHROPIC_API_KEY; decides nothing)")
  .option("--ttl <minutes>", "how long the plan stays approvable", "30")
  .option("--json", "print the outcome as JSON (progress goes to stderr)")
  .action(async (flag: string, opts: { env: string; dryRun?: boolean; fixtures?: string; explain?: boolean; ttl: string; json?: boolean; code: boolean }) => {
    const base = baseContext(opts.json);
    const ttlMinutes = Number(opts.ttl);
    if (!Number.isFinite(ttlMinutes) || ttlMinutes <= 0) throw new Error(`--ttl: not a positive number: ${opts.ttl}`);
    const env = opts.fixtures
      ? { name: opts.env.trim().toLowerCase(), key: opts.env.trim().toLowerCase(), protectedEnv: base.loaded.LANDER_PROTECTED_ENVS.map((x) => x.toLowerCase()).includes(opts.env.trim().toLowerCase()) }
      : resolveLandEnvironment(base.loaded, opts.env);
    const port = opts.fixtures
      ? new FixturesLandPort(new FlagsmithAdapter({ call: fixtureTransport(opts.fixtures), settleMs: 0 }))
      : livePort();
    const ctx: RunContext = {
      ...base,
      port,
      envName: env.name,
      envKey: env.key,
      protectedEnv: env.protectedEnv,
      clock: { now: Date.now, ...(opts.fixtures ? { verdictNow: "replay" as const } : {}) },
    };
    const code = codeContext(base.loaded, opts.code, !opts.dryRun);
    if (code) ctx.code = code;
    try {
      const out = await runLand(flag, { dryRun: Boolean(opts.dryRun), ...(opts.explain ? { explain: true } : {}), ttlMinutes }, ctx);
      if (opts.json) console.log(JSON.stringify(out, null, 2));
    } catch (err) {
      if (err instanceof LandRefused) {
        console.error(err.message);
        process.exitCode = 2;
        return;
      }
      if (err instanceof CodeStageStopped || err instanceof CodeChangeFailed) {
        console.error(err.message);
        process.exitCode = 3;
        return;
      }
      throw err;
    }
  });

program
  .command("apply")
  .description("Apply a saved plan (same gates as land: hash, TTL, typed approval, verdict and flag re-check)")
  .argument("<plan-id>", "plan id (12 hex characters) printed by lander land")
  .action(async (planId: string) => {
    const base = baseContext(false);
    const store = base.store;
    const { plan } = store.load(planId);
    const env = resolveLandEnvironment(base.loaded, plan.environment.name);
    const code = plan.codeEdits.length > 0 ? codeContext(base.loaded, true, true) : undefined;
    try {
      await runApply(planId, { ...base, port: livePort(), envName: env.name, envKey: env.key, protectedEnv: env.protectedEnv, ...(code ? { code } : {}) });
    } catch (err) {
      if (err instanceof CodeStageStopped || err instanceof CodeChangeFailed) {
        console.error(err.message);
        process.exitCode = 3;
        return;
      }
      throw err;
    }
  });

program
  .command("rollback")
  .description("Restore the flag state recorded before an apply (value, enabled, weights). The experiment stays completed.")
  .argument("<journal-id>", "journal id (or plan id) printed by lander land")
  .option("--dry-run", "show what would be restored, write nothing")
  .action(async (ref: string, opts: { dryRun?: boolean }) => {
    const base = baseContext(false);
    await runRollback(ref, { dryRun: Boolean(opts.dryRun) }, {
      ...base,
      port: livePort(),
      resolveKey: (name) => resolveLandEnvironment(base.loaded, name).key,
    });
  });

const journalCmd = program.command("journal").description("Inspect the audit journal");
journalCmd
  .command("verify")
  .description("Check the journal's hash chain")
  .action(() => {
    const r = new Journal(`${LANDER_DIR}/journal.jsonl`).verify();
    if (r.ok) console.log(`Journal OK: ${r.entries} entries, hash chain intact.`);
    else {
      console.error(`Journal BROKEN at line ${r.line}: ${r.reason}`);
      process.exitCode = 1;
    }
  });

program
  .command("retire")
  .description("Gate checks for retiring a landed flag: experiment completed, PR merged, zero references (dry run: archives nothing)")
  .argument("<flag>", "flag key")
  .option("--env <name>", "environment name (staging, production)", "staging")
  .option("--json", "JSON output")
  .action(async (flag: string, opts: { env: string; json?: boolean }) => {
    const base = baseContext(opts.json);
    const env = resolveLandEnvironment(base.loaded, opts.env);
    const repo = resolve(base.loaded.LANDER_REPO_PATH);
    const report = await runRetireChecks(flag, {
      port: livePort(),
      envName: env.name,
      envKey: env.key,
      journal: base.journal,
      repoPath: existsSync(repo) ? repo : null,
      runner: realRunner,
    });
    console.log(opts.json ? JSON.stringify(report, null, 2) : renderRetire(report));
    if (!report.ready) process.exitCode = 2;
  });

try {
  await program.parseAsync(process.argv);
} catch (err) {
  console.error(`lander: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
}
