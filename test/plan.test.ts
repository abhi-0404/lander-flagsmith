import { describe, expect, it } from "vitest";
import { canonicalJson, planHash } from "../src/plan/hash.js";

describe("plan hash (S4)", () => {
  it("does not depend on key order", () => {
    expect(planHash({ a: 1, b: { c: 2, d: [1, 2] } })).toBe(planHash({ b: { d: [1, 2], c: 2 }, a: 1 }));
  });

  it("changes when any value changes", () => {
    const base = { flag: "checkout_cta", diff: "-old\n+new" };
    expect(planHash(base)).not.toBe(planHash({ ...base, diff: "-old\n+new2" }));
  });

  it("is a 64 char hex SHA-256 and canonical form has no whitespace", () => {
    expect(planHash({ x: 1 })).toMatch(/^[0-9a-f]{64}$/);
    expect(canonicalJson({ b: 1, a: [true, null] })).toBe('{"a":[true,null],"b":1}');
  });
});
