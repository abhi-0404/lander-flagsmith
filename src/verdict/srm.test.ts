import { describe, expect, it } from "vitest";
import { chiSquarePValue, srmCheck } from "./srm.js";

describe("chiSquarePValue", () => {
  it("matches textbook critical values", () => {
    expect(chiSquarePValue(3.841459, 1)).toBeCloseTo(0.05, 4);
    expect(chiSquarePValue(5.991465, 2)).toBeCloseTo(0.05, 4);
    expect(chiSquarePValue(10.827566, 1)).toBeCloseTo(0.001, 5);
    expect(chiSquarePValue(13.815511, 2)).toBeCloseTo(0.001, 5);
    expect(chiSquarePValue(0, 3)).toBe(1);
  });

  it("is tiny for a huge statistic and stays within [0, 1]", () => {
    const p = chiSquarePValue(200, 2);
    expect(p).toBeGreaterThanOrEqual(0);
    expect(p).toBeLessThan(1e-40);
  });
});

describe("srmCheck", () => {
  it("passes a balanced 50/50 split", () => {
    const r = srmCheck({ control: 500, b: 500 });
    expect(r?.pValue).toBeCloseTo(1, 10);
    expect(r?.df).toBe(1);
  });

  it("flags 61/39 on a 50/50 test", () => {
    const r = srmCheck({ control: 610, b: 390 });
    expect(r?.pValue).toBeLessThan(1e-9);
    expect(r?.arms[0]?.observedShare).toBeCloseTo(0.61, 6);
  });

  it("respects unequal allocation weights", () => {
    // 90/10 allocation observed 900/100 is perfect.
    expect(srmCheck({ control: 900, b: 100 }, { control: 90, b: 10 })?.pValue).toBeCloseTo(1, 10);
    // The same counts against an equal split are a mismatch.
    expect(srmCheck({ control: 900, b: 100 })?.pValue).toBeLessThan(1e-9);
  });

  it("works with three arms (df 2)", () => {
    const r = srmCheck({ control: 510, a: 504, b: 516 }, { control: 33.4, a: 33.3, b: 33.3 });
    expect(r?.df).toBe(2);
    expect(r?.pValue).toBeGreaterThan(0.9);
  });

  it("returns null when there is nothing to test", () => {
    expect(srmCheck({ control: 10 })).toBeNull();
    expect(srmCheck({ control: 0, b: 0 })).toBeNull();
  });
});
