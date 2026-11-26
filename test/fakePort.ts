import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Journal } from "../src/executor/journal.js";
import type { Evidence } from "../src/flagsmith/adapter.js";
import type { LandPort } from "../src/flagsmith/landPort.js";
import type { Experiment } from "../src/flagsmith/schemas.js";
import type { RunContext } from "../src/land.js";
import type { ApprovalIO } from "../src/plan/approve.js";
import { PlanStore } from "../src/plan/store.js";
import type { FlagState, RolloutDecision } from "../src/plan/types.js";
import { AS_OF_MS, synth, type SynthOptions } from "./helpers.js";

/** A winner: variant "b" (option id 1) beats control. */
export const WINNER: SynthOptions = {
  control: { n: 1000, conv: 100 },
  variants: { b: { n: 1000, conv: 150, chance: 0.99, lift: 0.05, ciLow: 0.01, ciHigh: 0.09 } },
  weights: { b: 50 },
};

export const STAGING_KEY = "staging-env-key";
export const PROD_KEY = "production-env-key";

/** In-memory stand-in for Flagsmith. Records every write so tests can assert that nothing was written. */
export class FakePort implements LandPort {
  mode: "live" | "fixtures" = "live";
  writes: string[] = [];
  /** Hook run just before a write, e.g. to inspect the journal. */
  onWrite: (what: string) => void = () => undefined;
  evidence: Evidence;
  flag: FlagState = { enabled: true, value: "control", valueType: "string", weights: { "1": 50 } };
  failComplete = false;

  constructor(options: SynthOptions = WINNER) {
    const e = synth(options);
    this.evidence = { ...e, refresh: { results: null, exposures: null } };
  }

  get experiment(): Experiment {
    return this.evidence.experiment;
  }

  async listExperiments(): Promise<Experiment[]> {
    return [this.evidence.experiment];
  }
  async collect(_env: string, _exp: Experiment, _opts: { refresh: boolean }): Promise<Evidence> {
    return this.evidence;
  }
  async getExperiment(): Promise<Experiment> {
    return this.evidence.experiment;
  }
  async readFlagState(): Promise<{ state: FlagState; raw: unknown }> {
    return { state: structuredClone(this.flag), raw: { fake: true, ...this.flag } };
  }
  async completeExperiment(env: string, id: number, decision: RolloutDecision): Promise<unknown> {
    this.onWrite(`complete ${env} ${id}`);
    if (this.failComplete) throw new Error("boom: 500 from Flagsmith");
    this.writes.push(`complete:${id}:${decision.decision}`);
    this.evidence.experiment.status = "completed";
    this.flag =
      decision.decision === "variant"
        ? { enabled: true, value: decision.variantKey, valueType: "string", weights: { "1": 100 } }
        : { enabled: true, value: "control", valueType: "string", weights: { "1": 0 } };
    return { id, status: "completed" };
  }
  async restoreFlagState(_env: string, flag: string, state: FlagState): Promise<unknown> {
    this.onWrite(`restore ${flag}`);
    this.writes.push(`restore:${flag}`);
    this.flag = structuredClone(state);
    return {};
  }
}

export function ttyIO(answers: string[], isTTY = true): ApprovalIO & { asked: string[] } {
  const asked: string[] = [];
  return {
    isTTY,
    asked,
    async ask(q) {
      asked.push(q);
      const a = answers.shift();
      if (a === undefined) throw new Error("test: no more answers");
      return a;
    },
  };
}

export interface Harness {
  port: FakePort;
  ctx: RunContext;
  dir: string;
  store: PlanStore;
  journal: Journal;
  lines: string[];
  time: { now: number };
}

/** A run context over temp folders, a fixed clock 5 minutes after the results were computed. */
export function harness(opts: { port?: FakePort; io?: ApprovalIO; protectedEnv?: boolean; envName?: string } = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), "lander-test-"));
  const port = opts.port ?? new FakePort();
  const time = { now: AS_OF_MS + 5 * 60_000 };
  const store = new PlanStore(join(dir, ".lander"));
  const journal = new Journal(join(dir, ".lander", "journal.jsonl"), () => time.now, () => "tester");
  const lines: string[] = [];
  const ctx: RunContext = {
    port,
    envName: opts.envName ?? "staging",
    envKey: opts.envName === "production" ? PROD_KEY : STAGING_KEY,
    protectedEnv: opts.protectedEnv ?? false,
    store,
    journal,
    clock: { now: () => time.now, verdictNow: AS_OF_MS + 5 * 60_000 },
    io: opts.io ?? ttyIO([]),
    log: (l) => void lines.push(l),
  };
  return { port, ctx, dir, store, journal, lines, time };
}
