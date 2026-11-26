import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FlagsmithAdapter } from "../src/flagsmith/adapter.js";
import { fixtureTransport } from "../src/flagsmith/fixtureTransport.js";
import { renderTable, visibleLength } from "../src/output/table.js";
import { renderScan, runScan } from "../src/scan.js";
import { FIXTURES } from "./helpers.js";

const fixtureAdapter = (dir: string) =>
  new FlagsmithAdapter({ call: fixtureTransport(join(FIXTURES, dir)), sleep: async () => {}, settleMs: 0 });

describe("runScan on fixtures/demo", () => {
  it("returns the five scenario verdicts in order, plus the not-mine flags", async () => {
    const report = await runScan(fixtureAdapter("demo"), "staging", { refresh: true, now: "replay", projectId: "1" });
    expect(report.experiments.map((r) => [r.flag, r.verdict.kind])).toEqual([
      ["checkout_cta", "SHIP_VARIANT"],
      ["pricing_banner", "KEEP_RUNNING"],
      ["signup_steps", "DO_NOT_TRUST"],
      ["onboarding_tips", "COLLECTING"],
      ["search_ranking", "GUARDRAIL_HARM"],
    ]);
    expect(report.notMine).toEqual(["maintenance_mode", "new_nav"]);
    expect(report.summary).toEqual({ SHIP: 1, KEEP_RUNNING: 2, REFUSE: 2, notMine: 2 });
    expect(report.evaluatedAt).toBe("2026-11-26T09:00:00.000Z");
  });

  it("is JSON serializable and round trips", async () => {
    const report = await runScan(fixtureAdapter("demo"), "staging", { refresh: false, now: "replay" });
    const back = JSON.parse(JSON.stringify(report)) as typeof report;
    expect(back.experiments[0]?.verdict.winner).toEqual({ variant: "get-everyones-times", optionId: 11 });
    expect(back.notMine).toEqual([]);
  });

  it("with the real clock the 2026 fixtures are stale and refused", async () => {
    const report = await runScan(fixtureAdapter("demo"), "staging", { refresh: false, now: Date.parse("2026-12-30T00:00:00Z") });
    expect(report.experiments.find((r) => r.flag === "checkout_cta")?.verdict.kind).toBe("STALE");
  });

  it("renders every label and reason in the table", async () => {
    const report = await runScan(fixtureAdapter("demo"), "staging", { refresh: false, now: "replay", projectId: "1" });
    const text = renderScan(report);
    for (const label of ["SHIP get-everyones-times", "KEEP RUNNING", "DO NOT TRUST", "COLLECTING", "GUARDRAIL HARM"]) {
      expect(text).toContain(label);
    }
    expect(text).toContain("sample ratio mismatch");
    expect(text).toContain("Not mine");
    expect(text).toContain("1 ready to ship, 2 keep running, 2 refused, 2 not mine");
  });
});

describe("fixtures mode is never mistaken for live", () => {
  it("marks the report and the rendered text as a fixtures replay", async () => {
    const report = await runScan(fixtureAdapter("demo"), "staging", { refresh: false, now: "replay", fixturesDir: "fixtures/demo" });
    expect(report.source).toEqual({ mode: "fixtures", dir: "fixtures/demo" });
    const text = renderScan(report);
    expect(text.split("\n")[0]).toMatch(/FIXTURES REPLAY.*not live Flagsmith/);
    expect(text).toContain("Lander scan (fixtures)");
  });

  it("a live scan says live", async () => {
    const report = await runScan(fixtureAdapter("demo"), "staging", { refresh: false, now: "replay" });
    expect(report.source).toEqual({ mode: "live" });
    expect(renderScan(report)).not.toContain("FIXTURES REPLAY");
  });
});

describe("runScan on fixtures/real", () => {
  it("ships the real capture and has no not-mine flags", async () => {
    const report = await runScan(fixtureAdapter("real"), "dev", { refresh: true, now: "replay", projectId: "1" });
    expect(report.experiments).toHaveLength(1);
    expect(report.experiments[0]?.verdict.label).toBe("SHIP variant_b");
    expect(report.notMine).toEqual([]);
  });

  it("warns instead of failing when the project flag list cannot be read", async () => {
    const adapter = new FlagsmithAdapter({
      call: async (m, p) => {
        if (p.includes("/projects/")) throw new Error("403 forbidden");
        return fixtureTransport(join(FIXTURES, "real"))(m, p);
      },
      sleep: async () => {},
      settleMs: 0,
    });
    const report = await runScan(adapter, "dev", { refresh: false, now: "replay", projectId: "1" });
    expect(report.warnings.join("\n")).toMatch(/not mine.*403/s);
    expect(report.experiments).toHaveLength(1);
  });
});

describe("renderTable", () => {
  it("aligns columns ignoring ANSI codes", () => {
    const out = renderTable(["A", "BB"], [["x", "\u001b[31mred\u001b[0m"], ["longer", "y"]]).split("\n");
    expect(out[0]).toBe("A       BB");
    expect(visibleLength(out[2] ?? "")).toBe(visibleLength("x       red"));
  });
});
