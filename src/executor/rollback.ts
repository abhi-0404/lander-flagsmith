// NEVER imported by agent/. Restores served value, enabled state and weights only; a completed experiment stays completed.
import { keyFingerprint } from "../plan/builder.js";
import { ApprovalRefused } from "../plan/approve.js";
import { flagStateSchema, type Approval, type FlagState } from "../plan/types.js";
import { isEmptyFlagState, sameFlagState } from "../flagsmith/flagState.js";
import type { LandPort } from "../flagsmith/landPort.js";
import type { Journal, JournalEntry } from "./journal.js";
import { redactKey } from "./apply.js";

export interface RollbackTarget {
  planId: string;
  flag: string;
  environment: { name: string; protected: boolean; keyFingerprint: string };
  /** State to restore. */
  before: FlagState;
  /** State right after the apply, when it finished (drift check); null for an orphan `apply_started`. */
  expectedNow: FlagState | null;
  /** Journal entry the human approves against (its hash prefix is what they type). */
  started: JournalEntry;
}

export class RollbackRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RollbackRefused";
  }
}

const str = (x: unknown): string => (typeof x === "string" ? x : "");

/** Find what to roll back from a journal entry id or a plan id. Pure given the entries. */
export function findRollbackTarget(entries: JournalEntry[], ref: string): RollbackTarget {
  const r = ref.trim().toLowerCase();
  if (r.length < 6) throw new RollbackRefused("Give at least 6 characters of the journal id or plan id.");
  const hit = entries.filter((e) => e.id.startsWith(r) || (e.planId !== null && e.planId.startsWith(r)));
  const planIds = [...new Set(hit.map((e) => e.planId).filter((p): p is string => p !== null))];
  if (planIds.length === 0) throw new RollbackRefused(`No journal entry matches ${ref}.`);
  if (planIds.length > 1) throw new RollbackRefused(`${ref} matches more than one plan; give more characters.`);
  const planId = planIds[0] as string;
  const mine = entries.filter((e) => e.planId === planId);
  const started = mine.filter((e) => e.type === "apply_started").at(-1);
  if (!started) throw new RollbackRefused(`Plan ${planId} was never applied (no apply_started entry): nothing to roll back.`);
  const done = mine.filter((e) => e.type === "apply_done").at(-1);

  const before = flagStateSchema.safeParse(started.data["before"]);
  if (!before.success) throw new RollbackRefused("The journal's before-state is unreadable; refusing.");
  const env = started.data["environment"] as { name?: unknown; protected?: unknown; keyFingerprint?: unknown } | undefined;
  const flag = str(started.data["flag"]);
  if (!env || !str(env.name) || !str(env.keyFingerprint) || !flag) throw new RollbackRefused("The journal entry is missing the flag or environment; refusing.");
  let expectedNow: FlagState | null = null;
  if (done) {
    const after = flagStateSchema.safeParse(done.data["after"]);
    if (!after.success) throw new RollbackRefused("The journal's after-state is unreadable; refusing.");
    expectedNow = after.data;
  }
  return {
    planId,
    flag,
    environment: { name: str(env.name), protected: env.protected === true, keyFingerprint: str(env.keyFingerprint) },
    before: before.data,
    expectedNow,
    started,
  };
}

export interface RollbackDeps {
  port: LandPort;
  journal: Journal;
  envKey: string;
}

export interface RollbackResult {
  journalId: string;
  restored: boolean;
  before: FlagState;
  after: FlagState;
  note: string;
}

/**
 * Put the flag back. Refuses on a broken journal chain, a different environment key, an empty before-state, or when someone changed
 * the flag since the apply (the current state is not the one the apply left). The approval must be for the journal entry.
 */
export async function executeRollback(target: RollbackTarget, approval: Approval, deps: RollbackDeps): Promise<RollbackResult> {
  const { port, journal, envKey } = deps;
  if (port.mode !== "live") throw new RollbackRefused("fixtures mode can never roll back (dry-run only)");
  if (approval.planHash !== target.started.hash) throw new ApprovalRefused("The approval was given for a different journal entry.");
  if (approval.environment !== target.environment.name) throw new ApprovalRefused("The approval is for another environment.");
  if (target.environment.protected && approval.typed.environment !== target.environment.name) {
    throw new ApprovalRefused(`${target.environment.name} is protected: the approval must include the typed environment name.`);
  }
  const v = journal.verify();
  if (!v.ok) throw new RollbackRefused(`The journal hash chain is broken at line ${v.line}: ${v.reason}. Refusing to act on it.`);
  if (keyFingerprint(envKey) !== target.environment.keyFingerprint) {
    throw new RollbackRefused(`The key for environment ${target.environment.name} is not the one used when the plan was applied.`);
  }
  if (isEmptyFlagState(target.before)) throw new RollbackRefused("The recorded before-state is empty; there is nothing to restore.");

  const current = await port.readFlagState(envKey, target.flag);
  if (target.expectedNow && !sameFlagState(current.state, target.expectedNow)) {
    throw new RollbackRefused(
      `Flag ${target.flag} changed after the apply (someone edited it). Expected ${JSON.stringify(target.expectedNow)}, found ${JSON.stringify(current.state)}. Refusing to overwrite it.`,
    );
  }
  const started = journal.append("rollback_started", target.planId, {
    targetId: target.started.id,
    flag: target.flag,
    environment: target.environment.name,
    approvedBy: approval.user,
    approvedAt: approval.at,
    typed: approval.typed,
    before: current.state,
    restoreTo: target.before,
  });
  try {
    await port.restoreFlagState(envKey, target.flag, target.before);
  } catch (err) {
    journal.append("rollback_failed", target.planId, { startedId: started.id, error: redactKey(err, envKey) });
    throw err;
  }
  const after = await port.readFlagState(envKey, target.flag);
  const restored = sameFlagState(after.state, target.before);
  const note = restored
    ? "Flag state restored. The experiment stays completed: Flagsmith cannot reopen it."
    : "Flag state written but the read-back differs from the recorded state; check it in Flagsmith.";
  const done = journal.append("rollback_done", target.planId, {
    startedId: started.id,
    flag: target.flag,
    before: current.state,
    after: after.state,
    afterRaw: after.raw,
    restored,
    note,
  });
  return { journalId: done.id, restored, before: current.state, after: after.state, note };
}
