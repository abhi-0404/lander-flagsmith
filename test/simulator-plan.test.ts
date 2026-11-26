import { describe, expect, it } from "vitest";
import { EXPERIMENT_FLAGS } from "../tools/demoFlags.js";
import { TWO_DAYS_MS, decide, planTraffic } from "../tools/simulator/plan.js";

describe("simulator plan", () => {
  it("is deterministic for a given seed and differs for another", () => {
    const a = planTraffic(42);
    expect(planTraffic(42)).toEqual(a);
    expect(planTraffic(43)).not.toEqual(a);
  });

  it("has the documented identity counts and keeps timestamps inside 2 days", () => {
    const plan = planTraffic(1);
    for (const f of EXPERIMENT_FLAGS) {
      expect(plan.filter((p) => p.flag === f.name)).toHaveLength(f.identities);
    }
    for (const p of plan) {
      expect(p.exposureAgoMs).toBeGreaterThanOrEqual(0);
      expect(p.exposureAgoMs).toBeLessThan(TWO_DAYS_MS);
    }
  });

  it("orders identities oldest first", () => {
    const plan = planTraffic(1);
    for (let i = 1; i < plan.length; i++) {
      expect(plan[i - 1]!.exposureAgoMs).toBeGreaterThanOrEqual(plan[i]!.exposureAgoMs);
    }
  });

  it("produces the intended conversion rates and the SRM shape", () => {
    const plan = planTraffic(7);
    const checkout = EXPERIMENT_FLAGS.find((f) => f.name === "checkout_cta")!;
    const mine = plan.filter((p) => p.flag === "checkout_cta");
    const rate = (isVariant: boolean) =>
      mine.filter((p) => decide(p, checkout, isVariant).converted).length / mine.length;
    expect(rate(false)).toBeGreaterThan(0.08);
    expect(rate(false)).toBeLessThan(0.12);
    expect(rate(true)).toBeGreaterThan(0.12);
    expect(rate(true)).toBeLessThan(0.16);

    const signup = EXPERIMENT_FLAGS.find((f) => f.name === "signup_steps")!;
    const ids = plan.filter((p) => p.flag === "signup_steps");
    const variantExposed = ids.filter((p) => decide(p, signup, true).exposed).length / ids.length;
    expect(variantExposed).toBeGreaterThan(0.55);
    expect(variantExposed).toBeLessThan(0.65);
    expect(ids.every((p) => decide(p, signup, false).exposed)).toBe(true);
  });
});
