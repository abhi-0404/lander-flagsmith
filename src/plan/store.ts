import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { planHash, planIdOf } from "./hash.js";
import { planFileSchema, type LandPlan, type PlanFile } from "./types.js";

export class PlanTampered extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanTampered";
  }
}
export class PlanExpired extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanExpired";
  }
}

const PLAN_ID = /^[0-9a-f]{12}$/;

/** `.lander/plans/<id>/plan.json` (+ brief.md). The id is the first 12 hex chars of the plan hash. */
export class PlanStore {
  constructor(readonly root = ".lander") {}

  dir(id: string): string {
    if (!PLAN_ID.test(id)) throw new Error(`Bad plan id: ${JSON.stringify(id)} (expected 12 hex characters)`);
    return join(this.root, "plans", id);
  }

  file(id: string): string {
    return join(this.dir(id), "plan.json");
  }

  /** Write the plan with its content hash. Fixtures plans are never written: they can never be applied. */
  save(plan: LandPlan, hash: string): string {
    if (plan.source !== "live") throw new Error("refusing to save a fixtures plan: fixtures runs are dry-run only");
    if (planHash(plan) !== hash) throw new Error("refusing to save a plan whose hash does not match its content");
    const id = planIdOf(hash);
    mkdirSync(this.dir(id), { recursive: true });
    const body: PlanFile = { hash, plan };
    writeFileSync(this.file(id), `${JSON.stringify(body, null, 2)}\n`, "utf8");
    writeFileSync(join(this.dir(id), "brief.md"), plan.brief, "utf8");
    return id;
  }

  /** Read a plan and prove it is unchanged: schema valid, hash recomputed from the content, id matches the hash. */
  load(id: string): { id: string; hash: string; plan: LandPlan } {
    const path = this.file(id);
    if (!existsSync(path)) throw new Error(`No plan ${id} (looked for ${path})`);
    let parsed;
    try {
      parsed = planFileSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
    } catch (err) {
      throw new PlanTampered(`Plan ${id} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!parsed.success) {
      throw new PlanTampered(`Plan ${id} does not match the plan schema: ${parsed.error.issues[0]?.message ?? "invalid"}`);
    }
    const { hash, plan } = parsed.data;
    const actual = planHash(plan);
    if (actual !== hash) {
      throw new PlanTampered(
        `Plan ${id} was modified after it was written (stored hash ${hash.slice(0, 12)}, content hash ${actual.slice(0, 12)}). Refusing.`,
      );
    }
    if (planIdOf(hash) !== id) {
      throw new PlanTampered(`Plan ${id} does not belong in this folder (its hash starts ${planIdOf(hash)}). Refusing.`);
    }
    return { id, hash, plan };
  }
}

/** TTL gate. Throws when the plan has expired (or its expiry is unreadable). */
export function assertPlanFresh(plan: LandPlan, nowMs: number): void {
  const exp = Date.parse(plan.expiresAt);
  if (!Number.isFinite(exp)) throw new PlanExpired("plan has no readable expiry; refusing");
  if (nowMs >= exp) {
    throw new PlanExpired(`Plan expired at ${plan.expiresAt}. Plans are short lived because evidence goes stale: run lander land again.`);
  }
}
