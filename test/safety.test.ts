import { describe, expect, it } from "vitest";
import { assertFlagKey, buildApiArgs } from "../src/flagsmith/cli.js";
import { READ_TOOL_ALLOWLIST, isAllowedReadTool } from "../src/flagsmith/readTools.js";
import { canRefresh } from "../src/flagsmith/refreshThrottle.js";

describe("read tool allowlist (S1)", () => {
  it("contains no write-looking tool names", () => {
    for (const name of READ_TOOL_ALLOWLIST) {
      expect(name).toMatch(/^(get|list)_/);
    }
  });

  it("rejects tools that are not on the list", () => {
    expect(isAllowedReadTool("update_feature_state")).toBe(false);
    expect(isAllowedReadTool("list_experiments")).toBe(true);
  });
});

describe("flag key validation (S8)", () => {
  it("accepts normal keys", () => {
    expect(assertFlagKey("checkout_cta")).toBe("checkout_cta");
    expect(assertFlagKey("a.b-c_1")).toBe("a.b-c_1");
  });

  it("rejects anything that could reach a shell or an option", () => {
    for (const bad of ["a b", "a;rm -rf", "$(x)", "a/b", "", "--yes", "-e", "..", ".hidden","a\nb"]) {
      expect(() => assertFlagKey(bad)).toThrow(/Unsafe flag key/);
    }
  });
});

describe("flagsmith api argument builder", () => {
  it("builds an argument array, never a shell string, and sends bodies on stdin", () => {
    const args = buildApiArgs("POST", "/api/v1/environments/x/experiments/1/complete/", {
      environment: "ENVKEY",
      body: { rollout_decision: "control" },
    });
    expect(args).toEqual([
      "api",
      "api/v1/environments/x/experiments/1/complete/",
      "-X",
      "POST",
      "--json",
      "--no-input",
      "-e",
      "ENVKEY",
      "--input",
      "-",
    ]);
  });
});

describe("refresh throttle", () => {
  it("blocks a second refresh inside five minutes", () => {
    const t0 = 1_000_000;
    expect(canRefresh(undefined, t0)).toBe(true);
    expect(canRefresh(t0, t0 + 4 * 60_000)).toBe(false);
    expect(canRefresh(t0, t0 + 5 * 60_000)).toBe(true);
  });
});
