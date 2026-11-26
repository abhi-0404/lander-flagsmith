import { describe, expect, it } from "vitest";
import { AS_OF_MS, loadEvidence, synth, type SynthOptions } from "../../test/helpers.js";
import { computeVerdict, type Verdict } from "./engine.js";

const run = (o: SynthOptions, nowMs = AS_OF_MS): Verdict => computeVerdict({ ...synth(o), nowMs });
const codes = (v: Verdict): string[] => v.reasons.map((r) => r.code);

describe("verdicts on the real Flagsmith 2.295.2 capture (fixtures/real)", () => {
  const real = loadEvidence("real", 1);
  const asOf = Date.parse(real.results?.as_of ?? "");

  it("ships variant_b: 99.6 percent chance, interval above zero, split ok despite srm_p_value null", () => {
    const v = computeVerdict({ ...real, nowMs: asOf });
    expect(v.decision).toBe("SHIP");
    expect(v.label).toBe("SHIP variant_b");
    expect(v.winner).toEqual({ variant: "variant_b", optionId: 2 });
    expect(v.srm?.pValue).toBeGreaterThan(0.5);
    expect(v.arms.map((a) => [a.key, a.exposures])).toEqual([
      ["control", 510],
      ["variant_a", 504],
      ["variant_b", 516],
    ]);
  });

  it("reads variant_a at about 60 percent and does not ship it", () => {
    const v = computeVerdict({ ...real, nowMs: asOf });
    expect(v.arms.find((a) => a.key === "variant_a")?.chanceToWin).toBeCloseTo(0.604, 3);
  });

  it("refuses the same data as stale a day later", () => {
    const v = computeVerdict({ ...real, nowMs: asOf + 24 * 3_600_000 });
    expect(v.decision).toBe("REFUSE");
    expect(v.kind).toBe("STALE");
    expect(codes(v)).toContain("STALE_RESULTS");
    expect(v.winner).toBeNull();
  });

  it("answers COLLECTING when results are null (before the first refresh)", () => {
    const v = computeVerdict({ experiment: real.experiment, results: null, exposures: null, nowMs: asOf });
    expect(v.decision).toBe("KEEP_RUNNING");
    expect(v.kind).toBe("COLLECTING");
    expect(codes(v)).toContain("NO_RESULTS");
  });
});

describe("verdicts on the demo set (fixtures/demo)", () => {
  const verdict = (id: number): Verdict => computeVerdict({ ...loadEvidence("demo", id), nowMs: AS_OF_MS });

  it("checkout_cta: SHIP the clear winner and carries the MV option id", () => {
    const v = verdict(1);
    expect(v.label).toBe("SHIP get-everyones-times");
    expect(v.winner).toEqual({ variant: "get-everyones-times", optionId: 11 });
  });

  it("pricing_banner: KEEP RUNNING at about 85 percent, never ship", () => {
    const v = verdict(2);
    expect(v.decision).toBe("KEEP_RUNNING");
    expect(v.kind).toBe("KEEP_RUNNING");
    expect(v.arms[1]?.chanceToWin).toBeGreaterThan(0.8);
    expect(v.arms[1]?.chanceToWin).toBeLessThan(0.9);
  });

  it("signup_steps: DO NOT TRUST on a 61/39 split even though the variant looks good", () => {
    const v = verdict(3);
    expect(v.decision).toBe("REFUSE");
    expect(v.kind).toBe("DO_NOT_TRUST");
    expect(v.reasons[0]?.message).toMatch(/61\.0%.*39\.0%/);
    expect(v.winner).toBeNull();
  });

  it("onboarding_tips: COLLECTING with floors per arm and an ETA", () => {
    const v = verdict(4);
    expect(v.kind).toBe("COLLECTING");
    expect(codes(v)).toEqual(expect.arrayContaining(["TOO_FEW_EXPOSURES", "BELOW_FLOOR"]));
    expect(v.etaHours).not.toBeNull();
  });

  it("search_ranking: wins the primary metric but REFUSE on guardrail harm", () => {
    const v = verdict(5);
    expect(v.decision).toBe("REFUSE");
    expect(v.kind).toBe("GUARDRAIL_HARM");
    expect(v.reasons.some((r) => r.code === "GUARDRAIL_HARM" && r.message.includes("refund_requested"))).toBe(true);
    expect(v.winner).toBeNull();
  });
});

describe("synthetic rules", () => {
  const winner = { n: 500, conv: 80, chance: 0.97, lift: 0.3, ciLow: 0.05, ciHigh: 0.55 };
  const control = { n: 500, conv: 60 };
  const loser = { n: 500, conv: 30, chance: 0.01, lift: -0.5, ciLow: -0.7, ciHigh: -0.3 };

  it("SHIP at exactly the 95 percent threshold, KEEP RUNNING just below", () => {
    expect(run({ control, variants: { b: { ...winner, chance: 0.95 } } }).decision).toBe("SHIP");
    expect(run({ control, variants: { b: { ...winner, chance: 0.9499 } } }).decision).toBe("KEEP_RUNNING");
  });

  it("does not ship when the interval includes zero even above 95 percent", () => {
    const v = run({ control, variants: { b: { ...winner, ciLow: -0.01 } } });
    expect(v.decision).toBe("KEEP_RUNNING");
    expect(codes(v)).toContain("INCONCLUSIVE");
  });

  it("picks the best of several winning variants", () => {
    const v = run({ control, variants: { b: { ...winner, chance: 0.96 }, c: { ...winner, chance: 0.99 } } });
    expect(v.winner?.variant).toBe("c");
    expect(v.winner?.optionId).toBe(2);
  });

  it("SHIP CONTROL when every variant is below 5 percent", () => {
    const v = run({ control, variants: { b: loser, c: { ...loser, conv: 35, chance: 0.04 } } });
    expect(v.kind).toBe("SHIP_CONTROL");
    expect(v.decision).toBe("SHIP");
    expect(v.winner).toEqual({ variant: null, optionId: null });
  });

  it("does not SHIP CONTROL when only some variants lose", () => {
    const v = run({ control, variants: { b: loser, c: { n: 500, conv: 62, chance: 0.5 } } });
    expect(v.decision).toBe("KEEP_RUNNING");
  });

  it("COLLECTING below the exposure floor (49), past it at 50", () => {
    expect(run({ control: { n: 49, conv: 6 }, variants: { b: { ...winner, n: 500 } } }).kind).toBe("COLLECTING");
    expect(run({ control: { n: 50, conv: 6 }, variants: { b: { ...winner, n: 50 } } }).kind).not.toBe("COLLECTING");
  });

  it("COLLECTING below the conversion floor (4), past it at 5, in any arm", () => {
    const low = run({ control: { n: 500, conv: 4 }, variants: { b: winner } });
    expect(low.kind).toBe("COLLECTING");
    expect(low.reasons[0]?.code).toBe("BELOW_FLOOR");
    expect(run({ control: { n: 500, conv: 5 }, variants: { b: winner } }).kind).not.toBe("COLLECTING");
    expect(run({ control, variants: { b: { ...winner, conv: 4 } } }).kind).toBe("COLLECTING");
  });

  it("a tiny skewed sample is COLLECTING, not DO NOT TRUST (floors come first)", () => {
    expect(run({ control: { n: 30, conv: 5 }, variants: { b: { n: 10, conv: 5 } } }).kind).toBe("COLLECTING");
  });

  it("DO NOT TRUST on SRM and it beats a winning result", () => {
    const v = run({ control: { n: 700, conv: 70 }, variants: { b: { ...winner, n: 300 } } });
    expect(v.kind).toBe("DO_NOT_TRUST");
    expect(v.winner).toBeNull();
  });

  it("SRM is judged against the allocation, not 50/50", () => {
    // 90/10 allocation, 900/100 observed: no mismatch, so the win stands.
    const ok = run({ control: { n: 900, conv: 90 }, variants: { b: { ...winner, n: 100, conv: 20 } }, weights: { b: 10 } });
    expect(ok.decision).toBe("SHIP");
    // Same counts with no allocation known (implied 50/50): mismatch.
    const bad = run({ control: { n: 900, conv: 90 }, variants: { b: { ...winner, n: 100, conv: 20 } } });
    expect(bad.kind).toBe("DO_NOT_TRUST");
  });

  it("DO NOT TRUST when Flagsmith itself reports a tiny srm_p_value", () => {
    const v = run({ control, variants: { b: winner }, srmPValue: 0.0001 });
    expect(v.kind).toBe("DO_NOT_TRUST");
    expect(codes(v)).toContain("SRM_FLAGSMITH");
  });

  it("a large srm_p_value from Flagsmith does not block", () => {
    expect(run({ control, variants: { b: winner }, srmPValue: 0.4 }).decision).toBe("SHIP");
  });

  it("DO NOT TRUST above 1 percent excluded identities, ok at or below", () => {
    expect(run({ control, variants: { b: winner }, excluded: 11 }).kind).toBe("DO_NOT_TRUST");
    expect(run({ control, variants: { b: winner }, excluded: 5 }).decision).toBe("SHIP");
  });

  it("STALE: results older than an hour are refused, fresh ones are not", () => {
    expect(run({ control, variants: { b: winner } }, AS_OF_MS + 59 * 60_000).decision).toBe("SHIP");
    const v = run({ control, variants: { b: winner } }, AS_OF_MS + 61 * 60_000);
    expect(v.kind).toBe("STALE");
    expect(v.decision).toBe("REFUSE");
  });

  it("STALE does not apply to final results", () => {
    expect(run({ control, variants: { b: winner }, isFinal: true }, AS_OF_MS + 5 * 24 * 3_600_000).decision).toBe("SHIP");
  });

  it("missing as_of is treated as stale", () => {
    expect(run({ control, variants: { b: winner }, asOf: null }).kind).toBe("STALE");
  });

  it("notes a failed refresh without blocking", () => {
    const v = run({ control, variants: { b: winner }, lastErrorAt: "2026-11-26T09:30:00.000Z" });
    expect(v.decision).toBe("SHIP");
    expect(codes(v)).toContain("RESULTS_ERROR");
  });

  it("GUARDRAIL_HARM only when the winner is likely worse (below 5 percent) on another metric", () => {
    expect(run({ control, variants: { b: winner }, guardrail: { b: 0.04 } }).kind).toBe("GUARDRAIL_HARM");
    expect(run({ control, variants: { b: winner }, guardrail: { b: 0.2 } }).decision).toBe("SHIP");
  });

  it("guardrails do not block SHIP CONTROL", () => {
    const v = run({ control, variants: { b: loser }, guardrail: { b: 0.01 } });
    expect(v.kind).toBe("SHIP_CONTROL");
  });

  it("completed experiments are refused with nothing to land", () => {
    const v = run({ status: "completed", control, variants: { b: winner } });
    expect(v.decision).toBe("REFUSE");
    expect(v.kind).toBe("COMPLETED");
  });

  it("not started experiments keep running", () => {
    expect(run({ status: "created", control, variants: { b: winner } }).kind).toBe("NOT_STARTED");
  });

  it("paused experiments are still judged, with a note", () => {
    const v = run({ status: "paused", control, variants: { b: winner } });
    expect(v.decision).toBe("SHIP");
    expect(codes(v)).toContain("PAUSED");
  });

  it("a variant with no inference yet is inconclusive, never a crash", () => {
    const e = synth({ control, variants: { b: winner } });
    const m = e.results?.payload.metrics[0];
    if (m) m.inference = {};
    expect(computeVerdict({ ...e, nowMs: AS_OF_MS }).decision).toBe("KEEP_RUNNING");
  });

  it("is deterministic: same input, same output", () => {
    const e = synth({ control, variants: { b: winner } });
    expect(computeVerdict({ ...e, nowMs: AS_OF_MS })).toEqual(computeVerdict({ ...e, nowMs: AS_OF_MS }));
  });

  it("thresholds are configurable", () => {
    const e = synth({ control, variants: { b: { ...winner, chance: 0.9 } } });
    expect(computeVerdict({ ...e, nowMs: AS_OF_MS, config: { winChance: 0.85 } }).decision).toBe("SHIP");
  });

  // Reviewer additions: fail closed on anything Lander cannot read.

  it("never ships when the primary metric has no readable direction", () => {
    for (const d of [null, "sideways"]) {
      const v = run({ control, variants: { b: winner }, primaryDirection: d });
      expect(v.decision).toBe("REFUSE");
      expect(codes(v)).toContain("METRIC_DIRECTION_UNKNOWN");
      expect(v.winner).toBeNull();
    }
  });

  it("never ships when a guardrail has no readable direction", () => {
    const v = run({ control, variants: { b: winner }, guardrail: { b: 0.5 }, guardrailDirection: null });
    expect(v.decision).toBe("REFUSE");
    expect(codes(v)).toContain("METRIC_DIRECTION_UNKNOWN");
  });

  it("increase metric: a high chance with the interval below zero is contradictory and never ships", () => {
    const v = run({ control, variants: { b: { ...winner, lift: -0.3, ciLow: -0.5, ciHigh: -0.05 } } });
    expect(v.decision).not.toBe("SHIP");
  });

  it("decrease primary: ships only when chance and interval agree (lower is better)", () => {
    const good = { ...winner, lift: -0.3, ciLow: -0.5, ciHigh: -0.05 };
    expect(run({ control, variants: { b: good }, primaryDirection: "decrease" }).decision).toBe("SHIP");
    // Same chance but the interval says the metric went up: orientation unclear, no ship.
    expect(run({ control, variants: { b: winner }, primaryDirection: "decrease" }).decision).not.toBe("SHIP");
  });

  it("decrease primary with the other chance_to_win orientation never ships control wrongly", () => {
    // If chance_to_win meant "raw value higher", a variant that lowered the metric (good) shows a low chance.
    const v = run({ control, variants: { b: { ...loser, lift: -0.5, ciLow: -0.7, ciHigh: -0.3 } }, primaryDirection: "decrease" });
    expect(v.decision).toBe("KEEP_RUNNING");
  });

  it("SHIP CONTROL needs every variant to have moved the bad way", () => {
    const v = run({ control, variants: { b: { ...loser, lift: 0.2, ciLow: 0.05, ciHigh: 0.4 } } });
    expect(v.decision).not.toBe("SHIP");
  });

  it("guardrail harm is caught by the interval even when chance_to_win reads as fine", () => {
    // refund_requested (decrease) clearly up, but chance_to_win oriented the other way reads 0.99.
    const v = run({ control, variants: { b: winner }, guardrail: { b: 0.99 }, guardrailCi: { b: [0.2, 0.8] } });
    expect(v.kind).toBe("GUARDRAIL_HARM");
    expect(v.decision).toBe("REFUSE");
  });

  it("a guardrail with no inference for the winner blocks SHIP (keep running)", () => {
    const e = synth({ control, variants: { b: winner }, guardrail: { b: 0.5 } });
    const g = e.results?.payload.metrics[1];
    if (g) g.inference = {};
    const v = computeVerdict({ ...e, nowMs: AS_OF_MS });
    expect(v.decision).toBe("KEEP_RUNNING");
    expect(codes(v)).toContain("GUARDRAIL_PENDING");
  });

  it("does not judge a guardrail as the primary when the primary metric is missing from results", () => {
    const e = synth({ control, variants: { b: winner }, guardrail: { b: 0.5 } });
    if (e.results) e.results.payload.metrics = e.results.payload.metrics.filter((m) => m.metric_id !== 1);
    const v = computeVerdict({ ...e, nowMs: AS_OF_MS });
    expect(v.decision).toBe("KEEP_RUNNING");
    expect(codes(v)).toContain("PRIMARY_METRIC_MISSING");
  });

  it("refuses a winner that maps to no multivariate option", () => {
    const e = synth({ control, variants: { b: winner } });
    e.experiment.feature.multivariate_options = [];
    const v = computeVerdict({ ...e, nowMs: AS_OF_MS });
    expect(v.decision).toBe("REFUSE");
    expect(codes(v)).toContain("UNMAPPED_WINNER");
    expect(v.winner).toBeNull();
  });

  it("REFUSE beats SHIP: SRM plus stale plus a winner is still refused", () => {
    const v = run({ control: { n: 700, conv: 70 }, variants: { b: { ...winner, n: 300 } } }, AS_OF_MS + 5 * 3_600_000);
    expect(v.decision).toBe("REFUSE");
    expect(v.winner).toBeNull();
  });
});
