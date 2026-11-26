import type { Evidence, FlagsmithAdapter } from "./adapter.js";
import { flagsmithJson } from "./cli.js";
import { flagGetArgs, flagRestoreArgs, normalizeFlagState } from "./flagState.js";
import type { Experiment } from "./schemas.js";
import type { FlagState, RolloutDecision } from "../plan/types.js";

/**
 * Everything `land`, `apply` and `rollback` need from Flagsmith, as one small interface. The live implementation sits on the
 * CLI adapter; the tests use a fake; `--fixtures` uses a read-only one. `env` is the environment API key.
 */
export interface LandPort {
  /** "fixtures" ports can never write. */
  readonly mode: "live" | "fixtures";
  listExperiments(env: string): Promise<Experiment[]>;
  /** Detail + (throttled) refresh + results + exposures for one experiment. */
  collect(env: string, experiment: Experiment, opts: { refresh: boolean }): Promise<Evidence>;
  getExperiment(env: string, id: number): Promise<Experiment>;
  readFlagState(env: string, flag: string): Promise<{ state: FlagState; raw: unknown }>;
  /** WRITE. Irreversible. */
  completeExperiment(env: string, id: number, decision: RolloutDecision): Promise<unknown>;
  /** WRITE. Puts the served value, enabled flag and weights back. */
  restoreFlagState(env: string, flag: string, state: FlagState): Promise<unknown>;
}

/** Runs `flagsmith <subcommand> ...` with --json and returns parsed JSON (injectable for tests). */
export type FlagCli = (subcommand: string[], env: string) => Promise<unknown>;

export const liveFlagCli: FlagCli = (subcommand, env) => flagsmithJson(subcommand, { environment: env });

export class LiveLandPort implements LandPort {
  readonly mode = "live" as const;
  constructor(
    private readonly adapter: FlagsmithAdapter,
    private readonly cli: FlagCli = liveFlagCli,
  ) {}
  listExperiments(env: string) {
    return this.adapter.listExperiments(env);
  }
  collect(env: string, experiment: Experiment, opts: { refresh: boolean }) {
    return this.adapter.collect(env, experiment, opts);
  }
  getExperiment(env: string, id: number) {
    return this.adapter.getExperiment(env, id);
  }
  async readFlagState(env: string, flag: string) {
    const raw = await this.cli(flagGetArgs(flag), env);
    return { state: normalizeFlagState(raw), raw };
  }
  completeExperiment(env: string, id: number, decision: RolloutDecision) {
    return this.adapter.completeExperiment(env, id, decision);
  }
  restoreFlagState(env: string, flag: string, state: FlagState) {
    return this.cli(flagRestoreArgs(flag, state), env);
  }
}

/** Offline port for `--fixtures`: reads recorded responses, every write throws. */
export class FixturesLandPort implements LandPort {
  readonly mode = "fixtures" as const;
  constructor(private readonly adapter: FlagsmithAdapter) {}
  listExperiments(env: string) {
    return this.adapter.listExperiments(env);
  }
  collect(env: string, experiment: Experiment, opts: { refresh: boolean }) {
    return this.adapter.collect(env, experiment, opts);
  }
  getExperiment(env: string, id: number) {
    return this.adapter.getExperiment(env, id);
  }
  async readFlagState(_env: string, _flag: string) {
    const state: FlagState = { enabled: null, value: null, valueType: null, weights: null };
    return { state, raw: { source: "fixtures", note: "no flag state is recorded in fixtures" } };
  }
  completeExperiment(): Promise<unknown> {
    return Promise.reject(new Error("fixtures mode is read only: refusing to complete an experiment"));
  }
  restoreFlagState(): Promise<unknown> {
    return Promise.reject(new Error("fixtures mode is read only: refusing to restore a flag"));
  }
}
