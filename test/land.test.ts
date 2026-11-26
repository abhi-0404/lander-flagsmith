import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { explainBrief, type MessagesLike } from "../src/agent/explain.js";
import { applyPlan, DriftDetected } from "../src/executor/apply.js";
import { executeRollback, findRollbackTarget, RollbackRefused } from "../src/executor/rollback.js";
import { FlagsmithAdapter } from "../src/flagsmith/adapter.js";
import { fixtureTransport } from "../src/flagsmith/fixtureTransport.js";
import { flagRestoreArgs, normalizeFlagState } from "../src/flagsmith/flagState.js";
import { FixturesLandPort } from "../src/flagsmith/landPort.js";
import { resolveLandEnvironment, runApply, runLand, runRollback } from "../src/land.js";
import { approve, ApprovalRefused } from "../src/plan/approve.js";
import { buildLandPlan, LandRefused } from "../src/plan/builder.js";
import { approvalPrefix, planHash } from "../src/plan/hash.js";
import { assertPlanFresh, PlanExpired, PlanTampered } from "../src/plan/store.js";
import type { Approval } from "../src/plan/types.js";
import { FakePort, harness, STAGING_KEY, ttyIO, WINNER } from "./fakePort.js";
import { FIXTURES } from "./helpers.js";

const FIXTURES_DIR = join(FIXTURES, "demo");

const build = (h: ReturnType<typeof harness>, flag = "flag_x") =>
  buildLandPlan({
    port: h.port,
    envName: h.ctx.envName,
    envKey: h.ctx.envKey,
    protectedEnv: h.ctx.protectedEnv,
    flag,
    clock: h.ctx.clock,
  });

/** Build, save and approve a plan the way `land` would. */
async function planAndApprove(h: ReturnType<typeof harness>): Promise<{ id: string; hash: string; approval: Approval }> {
  const b = await build(h);
  const id = h.store.save(b.plan, b.hash);
  const approval = await approve(b.plan, b.hash, ttyIO([approvalPrefix(b.hash)]), { now: h.ctx.clock.now, user: () => "tester" });
  return { id, hash: b.hash, approval };
}

const apply = (h: ReturnType<typeof harness>, id: string, approval: Approval) =>
  applyPlan(id, approval, { port: h.port, store: h.store, journal: h.journal, envKey: h.ctx.envKey, clock: h.ctx.clock });

describe("plan building and hashing (S4)", () => {
  it("builds the complete plan for a SHIP verdict: option id, step, before-state, brief", async () => {
    const h = harness();
    const { plan, hash, id } = await build(h);
    expect(plan.rollout).toEqual({ decision: "variant", variantOptionId: 1, variantKey: "b" });
    expect(plan.steps).toEqual([
      {
        kind: "complete_experiment",
        irreversible: true,
        method: "POST",
        path: "api/v1/environments/{env}/experiments/1/complete/",
        body: { rollout_decision: "variant", rollout_variant: 1 },
      },
    ]);
    expect(plan.flagBefore).toEqual(h.port.flag);
    expect(plan.codeEdits).toEqual([]);
    expect(plan.brief).toContain("# Decision brief: flag_x in staging");
    expect(plan.brief).toContain("irreversible");
    expect(hash).toBe(planHash(plan));
    expect(id).toBe(hash.slice(0, 12));
    // The environment key itself is never stored.
    expect(JSON.stringify(plan)).not.toContain(STAGING_KEY);
  });

  it("is deterministic and any change to the plan changes the hash", async () => {
    const h = harness();
    const a = await build(h);
    const b = await build(h);
    expect(a.hash).toBe(b.hash);
    expect(planHash({ ...a.plan, rollout: { decision: "control" } })).not.toBe(a.hash);
    expect(planHash({ ...a.plan, brief: `${a.plan.brief} ` })).not.toBe(a.hash);
  });

  it("refuses anything but SHIP and prints the reasons", async () => {
    const h = harness({ port: new FakePort({ ...WINNER, variants: { b: { ...WINNER.variants["b"]!, chance: 0.6 } } }) });
    await expect(build(h)).rejects.toBeInstanceOf(LandRefused);
    await expect(build(h)).rejects.toThrow(/KEEP RUNNING|Refusing to land flag_x/);
    const stale = harness({ port: new FakePort({ ...WINNER, asOf: "2026-11-20T00:00:00.000Z" }) });
    await expect(build(stale)).rejects.toThrow(/STALE|stale|older/i);
    const srm = harness({ port: new FakePort({ ...WINNER, control: { n: 1500, conv: 150 } }) });
    await expect(build(srm)).rejects.toBeInstanceOf(LandRefused);
  });

  it("refuses a flag with no experiment", async () => {
    await expect(build(harness(), "some_other_flag")).rejects.toThrow(/no experiment on this flag/);
  });

  it("refuses an unsafe flag key", async () => {
    await expect(build(harness(), "--yes")).rejects.toThrow(/Unsafe flag key/);
  });
});

describe("plan TTL", () => {
  it("is valid before expiry and refused at expiry", async () => {
    const h = harness();
    const { plan } = await build(h);
    expect(plan.expiresAt).toBe(new Date(h.time.now + 30 * 60_000).toISOString());
    expect(() => assertPlanFresh(plan, h.time.now + 29 * 60_000)).not.toThrow();
    expect(() => assertPlanFresh(plan, h.time.now + 30 * 60_000)).toThrow(PlanExpired);
    expect(() => assertPlanFresh({ ...plan, expiresAt: "garbage" }, h.time.now)).toThrow(PlanExpired);
  });

  it("apply refuses an expired plan and writes nothing", async () => {
    const h = harness();
    const { id, approval } = await planAndApprove(h);
    h.time.now += 31 * 60_000;
    await expect(apply(h, id, approval)).rejects.toThrow(PlanExpired);
    expect(h.port.writes).toEqual([]);
    expect(h.journal.readAll()).toEqual([]);
  });
});

describe("approval gate (S4)", () => {
  const plan = { environment: { name: "staging", protected: false } };
  const hash = "a".repeat(64);

  it("refuses without a TTY and never even asks", async () => {
    const io = ttyIO(["aaaaaaaa"], false);
    await expect(approve(plan, hash, io)).rejects.toThrow(/interactive terminal/);
    expect(io.asked).toEqual([]);
  });

  it("refuses a wrong hash prefix", async () => {
    await expect(approve(plan, hash, ttyIO(["bbbbbbbb"]))).rejects.toBeInstanceOf(ApprovalRefused);
    await expect(approve(plan, hash, ttyIO(["yes"]))).rejects.toBeInstanceOf(ApprovalRefused);
    await expect(approve(plan, hash, ttyIO([""]))).rejects.toBeInstanceOf(ApprovalRefused);
  });

  it("accepts the right prefix", async () => {
    const a = await approve(plan, hash, ttyIO(["aaaaaaaa"]), { user: () => "me", now: () => 0 });
    expect(a).toMatchObject({ planHash: hash, environment: "staging", user: "me", typed: { hashPrefix: "aaaaaaaa" } });
  });

  it("a protected environment also needs its name typed", async () => {
    const prod = { environment: { name: "production", protected: true } };
    await expect(approve(prod, hash, ttyIO(["aaaaaaaa", "staging"]))).rejects.toThrow(/environment name/);
    await expect(approve(prod, hash, ttyIO(["aaaaaaaa", ""]))).rejects.toBeInstanceOf(ApprovalRefused);
    const ok = await approve(prod, hash, ttyIO(["aaaaaaaa", "production"]));
    expect(ok.typed).toEqual({ hashPrefix: "aaaaaaaa", environment: "production" });
  });

  it("runLand in a non-TTY saves the plan, refuses approval and writes nothing to Flagsmith", async () => {
    const h = harness({ io: ttyIO([], false) });
    await expect(runLand("flag_x", { dryRun: false }, h.ctx)).rejects.toBeInstanceOf(ApprovalRefused);
    expect(h.port.writes).toEqual([]);
    expect(h.journal.readAll()).toEqual([]);
    expect(readdirSync(join(h.store.root, "plans"))).toHaveLength(1);
  });

  it("apply refuses an approval given for a different hash and one missing the protected env name", async () => {
    const h = harness();
    const { id, approval } = await planAndApprove(h);
    await expect(apply(h, id, { ...approval, planHash: "f".repeat(64) })).rejects.toBeInstanceOf(PlanTampered);
    const prod = harness({ envName: "production", protectedEnv: true });
    const bp = await build(prod);
    const pid = prod.store.save(bp.plan, bp.hash);
    const hashOnly: Approval = { planHash: bp.hash, environment: "production", user: "t", at: "t", typed: { hashPrefix: approvalPrefix(bp.hash) } };
    await expect(apply(prod, pid, hashOnly)).rejects.toBeInstanceOf(ApprovalRefused);
    expect(prod.port.writes).toEqual([]);
  });
});

describe("apply: happy path, journal, ordering", () => {
  it("completes the experiment, journals approval before the write and before/after state", async () => {
    const h = harness();
    const { id, approval } = await planAndApprove(h);
    let journalTypesAtWrite: string[] = [];
    h.port.onWrite = () => {
      journalTypesAtWrite = h.journal.readAll().map((e) => e.type);
    };
    const r = await apply(h, id, approval);
    expect(journalTypesAtWrite).toEqual(["approval", "apply_started"]);
    expect(h.port.writes).toEqual(["complete:1:variant"]);
    expect(r.experimentStatusAfter).toBe("completed");
    expect(r.before).toMatchObject({ value: "control", weights: { "1": 50 } });
    expect(r.after).toMatchObject({ value: "b", weights: { "1": 100 } });
    const entries = h.journal.readAll();
    expect(entries.map((e) => e.type)).toEqual(["approval", "apply_started", "step_done", "apply_done"]);
    expect(entries.at(-1)?.id).toBe(r.journalId);
    expect(entries[0]?.data).toMatchObject({ approvedBy: "tester", typed: { hashPrefix: approval.typed.hashPrefix } });
    expect(entries[1]?.data["before"]).toMatchObject({ value: "control" });
    expect(entries[3]?.data["after"]).toMatchObject({ value: "b" });
    expect(h.journal.verify()).toEqual({ ok: true, entries: 4 });
  });

  it("runLand end to end applies after typed approval", async () => {
    const h = harness({ io: ttyIO([]) });
    const b = await build(h);
    h.ctx.io = ttyIO([approvalPrefix(b.hash)]);
    const out = await runLand("flag_x", { dryRun: false }, h.ctx);
    expect(out.status).toBe("applied");
    expect(h.port.writes).toEqual(["complete:1:variant"]);
    expect(existsSync(h.store.file(b.id))).toBe(true);
    expect(readFileSync(join(h.store.dir(b.id), "brief.md"), "utf8")).toBe(b.plan.brief);
  });

  it("runApply resumes a saved plan with the same gates", async () => {
    const h = harness();
    const b = await build(h);
    h.store.save(b.plan, b.hash);
    h.ctx.io = ttyIO([approvalPrefix(b.hash)]);
    const r = await runApply(b.id, h.ctx);
    expect(r.result.experimentStatusAfter).toBe("completed");
    const h2 = harness({ io: ttyIO(["nope"]) });
    const b2 = await build(h2);
    h2.store.save(b2.plan, b2.hash);
    await expect(runApply(b2.id, h2.ctx)).rejects.toBeInstanceOf(ApprovalRefused);
    expect(h2.port.writes).toEqual([]);
  });

  it("journals a failed write and rethrows", async () => {
    const h = harness();
    const { id, approval } = await planAndApprove(h);
    h.port.failComplete = true;
    await expect(apply(h, id, approval)).rejects.toThrow(/boom/);
    expect(h.journal.readAll().map((e) => e.type)).toEqual(["approval", "apply_started", "apply_failed"]);
    expect(h.port.writes).toEqual([]);
  });
});

describe("apply: integrity and drift checks refuse before any write", () => {
  it("refuses an edited plan file (hash mismatch)", async () => {
    const h = harness();
    const { id, approval } = await planAndApprove(h);
    const file = h.store.file(id);
    const edited = readFileSync(file, "utf8").replace('"decision": "variant"', '"decision": "control"').replace(/"variantOptionId": 1,\s*"variantKey": "b",?/, "");
    writeFileSync(file, edited);
    await expect(apply(h, id, approval)).rejects.toThrow(PlanTampered);
    expect(h.port.writes).toEqual([]);
    expect(h.journal.readAll()).toEqual([]);
  });

  it("refuses a plan whose stored hash was recomputed to match an edit but whose folder id does not", async () => {
    const h = harness();
    const { id, approval } = await planAndApprove(h);
    const file = h.store.file(id);
    const body = JSON.parse(readFileSync(file, "utf8")) as { hash: string; plan: { flag: { name: string } } };
    body.plan.flag.name = "other_flag";
    body.hash = planHash(body.plan);
    writeFileSync(file, JSON.stringify(body));
    await expect(apply(h, id, approval)).rejects.toThrow(/does not belong in this folder/);
    expect(h.port.writes).toEqual([]);
  });

  it("verdict drift: results turned inconclusive after the plan, apply aborts", async () => {
    const h = harness();
    const { id, approval } = await planAndApprove(h);
    const inf = h.port.evidence.results?.payload.metrics[0]?.inference["b"];
    if (!inf) throw new Error("test setup");
    inf.chance_to_win = 0.6;
    await expect(apply(h, id, approval)).rejects.toThrow(DriftDetected);
    await expect(apply(h, id, approval)).rejects.toThrow(/verdict changed/);
    expect(h.port.writes).toEqual([]);
    expect(h.journal.readAll()).toEqual([]);
  });

  it("verdict drift: the experiment was completed by someone else", async () => {
    const h = harness();
    const { id, approval } = await planAndApprove(h);
    h.port.evidence.experiment.status = "completed";
    await expect(apply(h, id, approval)).rejects.toThrow(DriftDetected);
    expect(h.port.writes).toEqual([]);
  });

  it("flag drift: someone changed the flag after the plan", async () => {
    const h = harness();
    const { id, approval } = await planAndApprove(h);
    h.port.flag = { ...h.port.flag, value: "edited-by-someone" };
    await expect(apply(h, id, approval)).rejects.toThrow(/changed since the plan was made/);
    expect(h.port.writes).toEqual([]);
    expect(h.journal.readAll()).toEqual([]);
  });

  it("refuses when the environment key is not the one the plan was made with", async () => {
    const h = harness();
    const { id, approval } = await planAndApprove(h);
    await expect(
      applyPlan(id, approval, { port: h.port, store: h.store, journal: h.journal, envKey: "some-other-key", clock: h.ctx.clock }),
    ).rejects.toThrow(DriftDetected);
    expect(h.port.writes).toEqual([]);
  });
});

describe("fixtures mode is dry-run only", () => {
  const fixturePort = () => new FixturesLandPort(new FlagsmithAdapter({ call: fixtureTransport(FIXTURES_DIR), settleMs: 0 }));
  const fixtureCtx = (io = ttyIO([])) => {
    const h = harness({ io });
    return { ...h, ctx: { ...h.ctx, port: fixturePort(), clock: { now: () => Date.now(), verdictNow: "replay" as const } } };
  };

  it("dry-run works on the demo fixtures, shows the plan and writes nothing", async () => {
    const h = fixtureCtx();
    const out = await runLand("checkout_cta", { dryRun: true }, h.ctx);
    expect(out.status).toBe("dry-run");
    expect(out.plan.source).toBe("fixtures");
    expect(out.plan.rollout).toMatchObject({ decision: "variant", variantKey: "get-everyones-times", variantOptionId: 11 });
    expect(h.lines.join("\n")).toContain("FIXTURES REPLAY");
    expect(h.lines.join("\n")).toContain("Dry run: nothing was written");
    expect(existsSync(h.store.root)).toBe(false);
    expect(h.journal.readAll()).toEqual([]);
  });

  it("refuses to land without --dry-run, and dry-run still refuses non-SHIP experiments", async () => {
    const h = fixtureCtx();
    await expect(runLand("checkout_cta", { dryRun: false }, h.ctx)).rejects.toThrow(/dry-run only/);
    await expect(runLand("signup_steps", { dryRun: true }, h.ctx)).rejects.toBeInstanceOf(LandRefused);
    await expect(runLand("pricing_banner", { dryRun: true }, h.ctx)).rejects.toBeInstanceOf(LandRefused);
  });

  it("cannot save or apply a fixtures plan, and its port refuses every write", async () => {
    const h = fixtureCtx();
    const out = await runLand("checkout_cta", { dryRun: true }, h.ctx);
    expect(() => h.store.save(out.plan, out.hash)).toThrow(/fixtures/);
    await expect(fixturePort().completeExperiment()).rejects.toThrow(/read only/);
    await expect(fixturePort().restoreFlagState()).rejects.toThrow(/read only/);
    await expect(runApply("0123456789ab", h.ctx)).rejects.toThrow(/dry-run only/);
  });
});

describe("rollback", () => {
  async function applied() {
    const h = harness();
    const { id, approval } = await planAndApprove(h);
    const r = await apply(h, id, approval);
    return { h, id, r };
  }
  const typedFor = (target: { started: { hash: string } }, env = "staging"): Approval => ({
    planHash: target.started.hash,
    environment: env,
    user: "tester",
    at: "t",
    typed: { hashPrefix: approvalPrefix(target.started.hash) },
  });

  it("restores the recorded flag state from a journal id and journals it", async () => {
    const { h, r } = await applied();
    expect(h.port.flag.value).toBe("b");
    const out = await runRollback(r.journalId, { dryRun: false }, {
      ...h.ctx,
      io: ttyIO([approvalPrefix(findRollbackTarget(h.journal.readAll(), r.journalId).started.hash)]),
      resolveKey: () => h.ctx.envKey,
    });
    expect(out.result?.restored).toBe(true);
    expect(h.port.flag).toMatchObject({ value: "control", weights: { "1": 50 } });
    expect(h.port.writes).toEqual(["complete:1:variant", "restore:flag_x"]);
    expect(h.journal.readAll().map((e) => e.type).slice(-2)).toEqual(["rollback_started", "rollback_done"]);
    expect(h.journal.verify().ok).toBe(true);
    // The experiment stays completed.
    expect(h.port.experiment.status).toBe("completed");
  });

  it("also resolves by plan id, and --dry-run restores nothing", async () => {
    const { h, id } = await applied();
    const out = await runRollback(id.slice(0, 8), { dryRun: true }, { ...h.ctx, resolveKey: () => h.ctx.envKey });
    expect(out.result).toBeUndefined();
    expect(h.port.flag.value).toBe("b");
  });

  it("refuses without a TTY and with a wrong hash", async () => {
    const { h, r } = await applied();
    const deps = { ...h.ctx, resolveKey: () => h.ctx.envKey };
    await expect(runRollback(r.journalId, { dryRun: false }, { ...deps, io: ttyIO([], false) })).rejects.toBeInstanceOf(ApprovalRefused);
    await expect(runRollback(r.journalId, { dryRun: false }, { ...deps, io: ttyIO(["wrong"]) })).rejects.toBeInstanceOf(ApprovalRefused);
    expect(h.port.flag.value).toBe("b");
  });

  it("refuses when someone changed the flag after the apply", async () => {
    const { h, r } = await applied();
    h.port.flag = { ...h.port.flag, value: "hand-edited" };
    const target = findRollbackTarget(h.journal.readAll(), r.journalId);
    await expect(executeRollback(target, typedFor(target), { port: h.port, journal: h.journal, envKey: h.ctx.envKey })).rejects.toThrow(
      /changed after the apply/,
    );
    expect(h.port.flag.value).toBe("hand-edited");
  });

  it("refuses on a broken journal chain, an unknown id and a never-applied plan", async () => {
    const { h, r } = await applied();
    const target = findRollbackTarget(h.journal.readAll(), r.journalId);
    const text = readFileSync(h.journal.path, "utf8").replace('"user":"tester"', '"user":"mallory"');
    writeFileSync(h.journal.path, text);
    expect(h.journal.verify().ok).toBe(false);
    await expect(executeRollback(target, typedFor(target), { port: h.port, journal: h.journal, envKey: h.ctx.envKey })).rejects.toThrow(
      /hash chain is broken/,
    );
    expect(() => findRollbackTarget([], "abcdef123456")).toThrow(RollbackRefused);
    expect(() => findRollbackTarget([], "abc")).toThrow(/at least 6/);
  });

  it("a protected environment rollback needs the environment name in the approval", async () => {
    const { h, r } = await applied();
    const target = findRollbackTarget(h.journal.readAll(), r.journalId);
    target.environment.protected = true;
    await expect(executeRollback(target, typedFor(target), { port: h.port, journal: h.journal, envKey: h.ctx.envKey })).rejects.toBeInstanceOf(
      ApprovalRefused,
    );
  });
});

describe("journal hash chain (S12)", () => {
  it("detects an edited, removed or reordered line", async () => {
    const h = harness();
    const { id, approval } = await planAndApprove(h);
    await apply(h, id, approval);
    const lines = readFileSync(h.journal.path, "utf8").trim().split("\n");
    expect(h.journal.verify()).toEqual({ ok: true, entries: 4 });
    writeFileSync(h.journal.path, `${[lines[0], lines[2], lines[1], lines[3]].join("\n")}\n`);
    expect(h.journal.verify().ok).toBe(false);
    writeFileSync(h.journal.path, `${[lines[0], lines[2], lines[3]].join("\n")}\n`);
    expect(h.journal.verify().ok).toBe(false);
    writeFileSync(h.journal.path, `${lines.join("\n").replace('"seq":2', '"seq":9')}\n`);
    expect(h.journal.verify().ok).toBe(false);
  });
});

describe("flag state helpers", () => {
  it("normalizes the likely flag get shapes", () => {
    expect(normalizeFlagState({ enabled: true, feature_state_value: "x", multivariate_feature_state_values: [{ multivariate_feature_option: 3, percentage_allocation: 40 }] })).toEqual({
      enabled: true,
      value: "x",
      valueType: "string",
      weights: { "3": 40 },
    });
    expect(normalizeFlagState([{ enabled: false, value: { type: "integer", value: 7 } }])).toMatchObject({ enabled: false, value: 7, valueType: "integer" });
    expect(normalizeFlagState(null)).toEqual({ enabled: null, value: null, valueType: null, weights: null });
  });

  it("builds flag update arguments with = forms and refuses an empty state", () => {
    expect(flagRestoreArgs("checkout_cta", { enabled: true, value: "-v", valueType: "string", weights: { "2": 30, "1": 70 } })).toEqual([
      "flag",
      "update",
      "checkout_cta",
      "--value=-v",
      "--type=string",
      "--enable",
      "--weight=1=70",
      "--weight=2=30",
      "--yes",
    ]);
    expect(() => flagRestoreArgs("x", { enabled: null, value: null, valueType: null, weights: null })).toThrow(/nothing Lander can restore/);
    expect(() => flagRestoreArgs("--yes", { enabled: true, value: null, valueType: null, weights: null })).toThrow(/Unsafe flag key/);
  });
});

describe("adapter write path and environment resolution", () => {
  it("completeExperiment posts the documented body to the complete endpoint", async () => {
    const calls: unknown[][] = [];
    const adapter = new FlagsmithAdapter({ call: async (...a) => void calls.push(a) });
    await adapter.completeExperiment("ENVKEY", 7, { decision: "variant", variantOptionId: 42, variantKey: "k" });
    await adapter.completeExperiment("ENVKEY", 7, { decision: "control" });
    expect(calls).toEqual([
      ["POST", "api/v1/environments/ENVKEY/experiments/7/complete/", { rollout_decision: "variant", rollout_variant: 42 }],
      ["POST", "api/v1/environments/ENVKEY/experiments/7/complete/", { rollout_decision: "control" }],
    ]);
  });

  it("only accepts named environments for land and marks protected ones", () => {
    const cfg = { LANDER_ENV_STAGING: "s", LANDER_ENV_PRODUCTION: "p", LANDER_PROTECTED_ENVS: ["production"] };
    expect(resolveLandEnvironment(cfg, "Production")).toEqual({ name: "production", key: "p", protectedEnv: true });
    expect(resolveLandEnvironment(cfg, "staging").protectedEnv).toBe(false);
    expect(() => resolveLandEnvironment(cfg, "RAWKEY123")).toThrow(/named environment/);
    expect(() => resolveLandEnvironment({ ...cfg, LANDER_ENV_STAGING: "" }, "staging")).toThrow(/LANDER_ENV_STAGING/);
  });
});

describe("--explain: the model never decides", () => {
  const brief = "# Decision brief\nVerdict: SHIP b";

  it("is skipped cleanly without an API key", async () => {
    expect(await explainBrief(brief, { model: "m", apiKey: "" })).toEqual({ status: "skipped", reason: "ANTHROPIC_API_KEY is not set" });
  });

  it("returns the rewrite from the model, sending only the brief with a no-tools request", async () => {
    let seen: Parameters<MessagesLike["create"]>[0] | undefined;
    const client: MessagesLike = {
      create: async (p) => {
        seen = p;
        return { stop_reason: "end_turn", content: [{ type: "text", text: "Variant b won." }] };
      },
    };
    const r = await explainBrief(brief, { model: "claude-haiku-5-5", apiKey: "k", client });
    expect(r).toEqual({ status: "ok", text: "Variant b won.", model: "claude-haiku-5-5" });
    expect(seen?.messages).toEqual([{ role: "user", content: brief }]);
    expect(seen).not.toHaveProperty("tools");
  });

  it("turns refusals and errors into notes, and never throws", async () => {
    const refuse: MessagesLike = { create: async () => ({ stop_reason: "refusal", content: [] }) };
    expect((await explainBrief(brief, { model: "m", client: refuse })).status).toBe("failed");
    const boom: MessagesLike = { create: async () => Promise.reject(new Error("network down")) };
    expect(await explainBrief(brief, { model: "m", client: boom })).toEqual({ status: "failed", reason: "network down" });
  });

  it("does not change the plan, its hash or the decision; land continues without a key", async () => {
    const h = harness();
    const base = await build(h);
    const out = await runLand("flag_x", { dryRun: true, explain: true }, { ...h.ctx, cfg: { ANTHROPIC_API_KEY: "", LANDER_EXPLAIN_MODEL: "claude-haiku-5-5" } });
    expect(out.hash).toBe(base.hash);
    expect(out.explain).toEqual({ status: "skipped", reason: "ANTHROPIC_API_KEY is not set" });
    expect(h.lines.join("\n")).toContain("--explain skipped");
    const withModel = harness();
    const o2 = await runLand("flag_x", { dryRun: true, explain: true }, {
      ...withModel.ctx,
      cfg: { ANTHROPIC_API_KEY: "k", LANDER_EXPLAIN_MODEL: "claude-haiku-5-5" },
      explainClient: { create: async () => ({ stop_reason: "end_turn", content: [{ type: "text", text: "Pick control instead." }] }) },
    });
    expect(o2.hash).toBe(base.hash);
    expect(o2.plan.rollout).toEqual(base.plan.rollout);
  });
});

describe("structure", () => {
  it("agent code never imports the executor (S9) and the executor never imports agent code", () => {
    const root = join(import.meta.dirname, "..", "src");
    for (const f of readdirSync(join(root, "agent"))) {
      expect(readFileSync(join(root, "agent", f), "utf8")).not.toMatch(/executor\//);
    }
    for (const f of readdirSync(join(root, "executor"))) {
      expect(readFileSync(join(root, "executor", f), "utf8")).not.toMatch(/from "\.\.\/agent\//);
    }
  });
});

describe("reviewer hardening (Phase 2 safety pass)", () => {
  it("a plan is applied at most once: replaying the same approval is refused before any write", async () => {
    const h = harness();
    const { id, approval } = await planAndApprove(h);
    await apply(h, id, approval);
    const writes = h.port.writes.length;
    await expect(apply(h, id, approval)).rejects.toThrow(/already applied|verdict changed/);
    expect(h.port.writes.length).toBe(writes);
  });

  it("refuses an approval object that does not carry the typed hash prefix", async () => {
    const h = harness();
    const { id, approval } = await planAndApprove(h);
    await expect(apply(h, id, { ...approval, typed: { hashPrefix: "" } })).rejects.toBeInstanceOf(ApprovalRefused);
    expect(h.port.writes).toEqual([]);
    expect(h.journal.readAll()).toEqual([]);
  });

  it("refuses to apply on a broken journal chain", async () => {
    const h = harness();
    const { id, approval } = await planAndApprove(h);
    h.journal.append("approval", null, { note: "earlier" });
    const line = readFileSync(h.journal.path, "utf8").replace("earlier", "edited");
    writeFileSync(h.journal.path, line, "utf8");
    await expect(apply(h, id, approval)).rejects.toThrow(/hash chain is broken/);
    expect(h.port.writes).toEqual([]);
  });

  it("never writes the environment key into the journal on a failed write", async () => {
    const h = harness();
    const { id, approval } = await planAndApprove(h);
    h.port.failComplete = true;
    const orig = h.port.completeExperiment.bind(h.port);
    h.port.completeExperiment = async (env, eid, d) => {
      await orig(env, eid, d).catch(() => undefined);
      throw new Error(`flagsmith api api/v1/environments/${env}/experiments/1/complete/ -e ${env} failed`);
    };
    await expect(apply(h, id, approval)).rejects.toThrow();
    expect(readFileSync(h.journal.path, "utf8")).not.toContain(STAGING_KEY);
  });

  it("journals a failed read-back after the write instead of stopping at step_done", async () => {
    const h = harness();
    const { id, approval } = await planAndApprove(h);
    const origRead = h.port.readFlagState.bind(h.port);
    let calls = 0;
    h.port.readFlagState = async () => {
      calls += 1;
      if (calls > 1) throw new Error("read failed");
      return origRead();
    };
    await expect(apply(h, id, approval)).rejects.toThrow(/read failed/);
    const types = h.journal.readAll().map((e) => e.type);
    expect(types).toEqual(["approval", "apply_started", "step_done", "apply_failed"]);
    expect(h.journal.readAll().at(-1)?.data).toMatchObject({ stage: "readback", written: true });
  });

  it("runApply refuses a plan made before its environment became protected", async () => {
    const h = harness();
    const b = await build(h);
    h.store.save(b.plan, b.hash);
    h.ctx.io = ttyIO([approvalPrefix(b.hash)]);
    await expect(runApply(b.id, { ...h.ctx, protectedEnv: true })).rejects.toThrow(/protected now/);
    expect(h.port.writes).toEqual([]);
  });

  it("CI markers count as no terminal", async () => {
    const { runningInCI } = await import("../src/plan/approve.js");
    expect(runningInCI({ CI: "true" })).toBe(true);
    expect(runningInCI({ GITHUB_ACTIONS: "true" })).toBe(true);
    expect(runningInCI({ CI: "false" })).toBe(false);
    expect(runningInCI({})).toBe(false);
  });

  it("masks the environment key in CLI error command lines", async () => {
    const { maskArgs } = await import("../src/flagsmith/cli.js");
    expect(maskArgs(["api", "api/v1/environments/SECRETKEY/experiments/1/complete/", "-X", "POST", "-e", "SECRETKEY"]).join(" ")).not.toContain("SECRETKEY");
  });

  it("strips terminal escape sequences from the model's rewrite", async () => {
    const client: MessagesLike = {
      create: async () => ({ stop_reason: "end_turn", content: [{ type: "text", text: "ok\u001b[2J\u001b[Hfake plan\u0007\nline" }] }),
    };
    const r = await explainBrief("b", { model: "m", client });
    expect(r).toEqual({ status: "ok", text: "okfake plan\nline", model: "m" });
  });
});
