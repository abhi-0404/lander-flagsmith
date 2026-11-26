import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { planHash } from "../src/plan/hash.js";
import { diffLines, unifiedDiff } from "../src/repo/diff.js";
import { codemodEdits, CodemodError, computeCodeEdits, discoverAliases, EditMismatch, verifyEdits, writeChanges } from "../src/repo/edits.js";
import { assertSafeRelPath, FsGuardError, redactSecrets, resolveInRepo } from "../src/repo/fsGuard.js";
import { residueCheck } from "../src/repo/search.js";
import { copyShop, SHOP_PRESENT } from "./gitRepo.js";

const read = (dir: string, rel: string): string => readFileSync(join(dir, rel), "utf8");

describe("line diff", () => {
  it("marks only the changed lines and keeps context", () => {
    const ops = diffLines(["a", "b", "c", "d"], ["a", "B", "c", "d"]);
    expect(ops.filter((o) => o.t !== " ")).toEqual([
      { t: "-", line: "b" },
      { t: "+", line: "B" },
    ]);
    expect(unifiedDiff("a\nb\nc\nd\ne\nf\ng\n", "a\nb\nc\nX\ne\nf\ng\n", 1)).toEqual(["@@ -3,3 +3,3 @@", " c", "-d", "+X", " e"]);
  });
  it("handles pure deletion, pure addition and no change", () => {
    expect(unifiedDiff("x\ny\n", "")).toEqual(["@@ -1,2 +1,0 @@", "-x", "-y"]);
    expect(unifiedDiff("", "x\n")).toEqual(["@@ -1,0 +1,1 @@", "+x"]);
    expect(unifiedDiff("same\n", "same\n")).toEqual([]);
  });
});

describe("fsGuard (S2)", () => {
  it("accepts plain repo paths and rejects traversal, absolute paths and the deny list", () => {
    expect(assertSafeRelPath("src/a/b.tsx")).toBe("src/a/b.tsx");
    for (const bad of ["../x", "src/../../x", "/etc/passwd", "C:\\x", ".env", "src/.env.local", ".git/config", ".lander/journal.jsonl", "node_modules/x/y.js", "key.pem", "", "a//b"]) {
      expect(() => assertSafeRelPath(bad), bad).toThrow(FsGuardError);
    }
    expect(() => resolveInRepo(tmpdir(), "../escape")).toThrow(FsGuardError);
  });
  it("redacts Flagsmith, Anthropic and GitHub tokens and given literals", () => {
    const text = "k=ser.abcdefghijklmnop1234 a=sk-ant-api03-abcdef12 g=ghp_abcdefghijklmnopqrstuvwx e=my-env-key-123";
    const out = redactSecrets(text, ["my-env-key-123"]);
    expect(out).not.toMatch(/ser\.abc|sk-ant|ghp_|my-env-key/);
    expect(out).toContain("[redacted]");
  });
});

describe.skipIf(!SHOP_PRESENT)("codemod on a copy of lander-demo-shop", () => {
  const run = (flag: string, winner: string | null, control: string, losing: string[]) => {
    const dir = copyShop();
    const edits = computeCodeEdits({ repoPath: dir, flag, winnerKey: winner, controlKey: control, losingKeys: losing });
    return { dir, edits };
  };

  it("checkout_cta, variant wins: keeps the variant branch, drops the flag read, imports, constant and control tests", () => {
    const { dir, edits } = run("checkout_cta", "get-everyones-times", "copy-invite", ["copy-invite"]);
    writeChanges(dir, verifyEdits(dir, edits));
    const comp = read(dir, "src/components/CheckoutButton.tsx");
    expect(comp).toContain('return <button className="cta cta-everyone">');
    expect(comp).not.toMatch(/useVariant|FLAG_KEYS|cta-invite|variant/);
    expect(read(dir, "src/flagKeys.ts")).not.toContain("checkoutCta");
    const test = read(dir, "src/components/CheckoutButton.test.tsx");
    expect(test).toContain("renders the winning copy");
    expect(test).not.toMatch(/copy-invite|Copy invite|checkout_cta|control copy/);
    expect(readFileSync(join(dir, "src/flagKeys.ts"), "utf8")).toContain("pricingBanner"); // other flags untouched
    expect(residueCheck(dir, ["checkout_cta", "copy-invite"], ["checkoutCta"])).toEqual([]);
  });

  it("pricing_banner, control wins: keeps the fall-through, deletes the banner and its test", () => {
    const { dir, edits } = run("pricing_banner", null, "no-banner", ["savings-banner"]);
    writeChanges(dir, verifyEdits(dir, edits));
    const comp = read(dir, "src/components/PricingBanner.tsx");
    expect(comp).toContain("return null;");
    expect(comp).not.toMatch(/banner"|useVariant|Save 20/);
    const test = read(dir, "src/components/PricingBanner.test.tsx");
    expect(test).toContain("shows nothing for control");
    expect(test).not.toContain("savings-banner");
    expect(residueCheck(dir, ["pricing_banner", "savings-banner"], ["pricingBanner"])).toEqual([]);
  });

  it("signup_steps, variant wins: also deletes the component only the losing branch imported", () => {
    const { dir, edits } = run("signup_steps", "one-step", "three-step", ["three-step"]);
    const del = edits.filter((e) => e.delete);
    expect(del.map((e) => e.path)).toEqual(["src/components/ThreeStepSignup.tsx"]);
    writeChanges(dir, verifyEdits(dir, edits));
    expect(read(dir, "src/components/SignupForm.tsx")).toContain("return <OneStepSignup />;");
    expect(read(dir, "src/components/SignupForm.tsx")).not.toContain("ThreeStepSignup");
    expect(() => read(dir, "src/components/ThreeStepSignup.tsx")).toThrow();
    expect(read(dir, "src/components/OneStepSignup.tsx")).toContain("signup-one");
  });

  it("is deterministic and the hashes tie each edit to the file the human saw", () => {
    const a = run("checkout_cta", "get-everyones-times", "copy-invite", ["copy-invite"]);
    const b = run("checkout_cta", "get-everyones-times", "copy-invite", ["copy-invite"]);
    expect(planHash(a.edits)).toBe(planHash(b.edits));
    expect(a.edits.every((e) => /^[0-9a-f]{64}$/.test(e.baseSha256) && /^[0-9a-f]{64}$/.test(e.resultSha256))).toBe(true);
    const other = run("checkout_cta", null, "copy-invite", ["get-everyones-times"]);
    expect(planHash(other.edits)).not.toBe(planHash(a.edits));
    const tampered = a.edits.map((e, i) => (i === 0 ? { ...e, newString: `${e.newString}// extra\n` } : e));
    expect(planHash(tampered)).not.toBe(planHash(a.edits));
  });

  it("refuses to apply when the file changed since the plan, or an edit was altered", () => {
    const { dir, edits } = run("checkout_cta", "get-everyones-times", "copy-invite", ["copy-invite"]);
    const file = join(dir, "src/components/CheckoutButton.tsx");
    writeFileSync(file, `${readFileSync(file, "utf8")}// someone edited this\n`);
    expect(() => verifyEdits(dir, edits)).toThrow(EditMismatch);
    writeFileSync(file, readFileSync(file, "utf8").replace("// someone edited this\n", ""));
    expect(() => verifyEdits(dir, edits)).not.toThrow();
    const altered = edits.map((e, i) => (i === 0 ? { ...e, oldString: "not in the file" } : e));
    expect(() => verifyEdits(dir, altered)).toThrow(EditMismatch);
    const wrongResult = edits.map((e) => ({ ...e, resultSha256: "0".repeat(64) }));
    expect(() => verifyEdits(dir, wrongResult)).toThrow(/result hash/);
  });

  it("refuses edit paths outside the repo or on the deny list", () => {
    const { dir, edits } = run("checkout_cta", "get-everyones-times", "copy-invite", ["copy-invite"]);
    const e0 = edits[0] as (typeof edits)[number];
    for (const path of ["../outside.ts", ".env", ".git/hooks/pre-commit"]) {
      expect(() => verifyEdits(dir, [{ ...e0, path }]), path).toThrow(FsGuardError);
    }
  });

  it("keeps CRLF files CRLF", () => {
    const dir = copyShop();
    for (const f of ["src/components/CheckoutButton.tsx", "src/components/CheckoutButton.test.tsx", "src/flagKeys.ts"]) {
      writeFileSync(join(dir, f), readFileSync(join(dir, f), "utf8").replace(/\n/g, "\r\n"));
    }
    const edits = computeCodeEdits({ repoPath: dir, flag: "checkout_cta", winnerKey: "get-everyones-times", controlKey: "copy-invite", losingKeys: ["copy-invite"] });
    writeChanges(dir, verifyEdits(dir, edits));
    const comp = readFileSync(join(dir, "src/components/CheckoutButton.tsx"), "utf8");
    expect(comp).toContain("\r\n");
    expect(comp.replace(/\r\n/g, "")).not.toContain("\n");
  });

  it("finds the flag key constant", () => {
    expect(discoverAliases(copyShop(), "signup_steps").props).toEqual(["signupSteps"]);
  });

  it("refuses the kill switch (no variant branch): not a pattern it knows", () => {
    const dir = copyShop();
    expect(() => computeCodeEdits({ repoPath: dir, flag: "maintenance_mode", winnerKey: null, controlKey: null, losingKeys: [] })).toThrow(CodemodError);
  });

  it("returns no edits for a flag nothing refers to", async () => {
    const dir = copyShop();
    expect(await codemodEdits.propose({ repoPath: dir, flag: "unused_flag", winnerKey: "x", controlKey: "y", losingKeys: ["y"] })).toEqual([]);
  });
});

/** Small hand-written repos for the refusal cases. */
function mini(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "lander-mini-"));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  return dir;
}
const KEYS = 'export const FLAG_KEYS = {\n  fx: "flag_x",\n} as const;\n';
const comp = (body: string): string => `import { FLAG_KEYS } from "./flagKeys";\nimport { useVariant } from "./flags";\nexport function C() {\n  const v = useVariant(FLAG_KEYS.fx);\n${body}\n}\n`;
const ctx = (dir: string, winner: string | null) => ({ repoPath: dir, flag: "flag_x", winnerKey: winner, controlKey: "ctl", losingKeys: winner === null ? ["b"] : ["ctl"] });

describe("codemod refusals (fail closed)", () => {
  it("applies on a minimal repo", () => {
    const dir = mini({ "src/flagKeys.ts": KEYS, "src/C.tsx": comp('  if (v === "b") {\n    return 1;\n  }\n  return 2;') });
    const edits = computeCodeEdits(ctx(dir, "b"));
    writeChanges(dir, verifyEdits(dir, edits));
    expect(read(dir, "src/C.tsx")).toContain("  return 1;\n}\n");
    expect(read(dir, "src/C.tsx")).not.toContain("useVariant");
  });
  it("refuses a variant winner that no branch tests (only control can be the fall-through)", () => {
    const dir = mini({ "src/flagKeys.ts": KEYS, "src/C.tsx": comp('  if (v === "b") {\n    return 1;\n  }\n  return 2;') });
    expect(() => computeCodeEdits({ ...ctx(dir, "c"), losingKeys: ["b", "ctl"] })).toThrow(/not tested here/);
  });
  it("refuses a branch for a key that is not an arm", () => {
    const dir = mini({ "src/flagKeys.ts": KEYS, "src/C.tsx": comp('  if (v === "zzz") {\n    return 1;\n  }\n  return 2;') });
    expect(() => computeCodeEdits(ctx(dir, "b"))).toThrow(/not one of this experiment's arms/);
  });
  it("refuses a branch that does not return, and an else", () => {
    const noRet = mini({ "src/flagKeys.ts": KEYS, "src/C.tsx": comp('  if (v === "b") {\n    log();\n  }\n  return 2;') });
    expect(() => computeCodeEdits(ctx(noRet, "b"))).toThrow(/does not return/);
    const withElse = mini({ "src/flagKeys.ts": KEYS, "src/C.tsx": comp('  if (v === "b") {\n    return 1;\n  } else {\n    return 2;\n  }') });
    expect(() => computeCodeEdits(ctx(withElse, "b"))).toThrow(/else/);
  });
  it("refuses a winning branch whose return is only nested (it can fall through), accepts a final return", () => {
    const nested = mini({ "src/flagKeys.ts": KEYS, "src/C.tsx": comp(`  if (v === "b") {
    if (x) {
      return 1;
    }
    log();
  }
  return 2;`) });
    expect(() => computeCodeEdits(ctx(nested, "b"))).toThrow(/does not return/);
    const onlyIf = mini({ "src/flagKeys.ts": KEYS, "src/C.tsx": comp(`  if (v === "b") {
    if (x) { return 1; }
  }
  return 2;`) });
    expect(() => computeCodeEdits(ctx(onlyIf, "b"))).toThrow(/does not return/);
    const ok = mini({ "src/flagKeys.ts": KEYS, "src/C.tsx": comp(`  if (v === "b") {
    if (x) { return 1; }
    // done
    return (
      <p>{"}"}</p>
    );
  }
  return 2;`) });
    writeChanges(ok, verifyEdits(ok, computeCodeEdits(ctx(ok, "b"))));
    expect(read(ok, "src/C.tsx")).not.toContain("return 2;");
    expect(read(ok, "src/C.tsx")).toContain("if (x) { return 1; }");
  });
  it("refuses when the kept branch still uses the variant variable", () => {
    const dir = mini({ "src/flagKeys.ts": KEYS, "src/C.tsx": comp('  if (v === "b") {\n    return v;\n  }\n  return 2;') });
    expect(() => computeCodeEdits(ctx(dir, "b"))).toThrow(/still uses the variable/);
  });
  it("refuses a file that mentions the flag in a form it does not know", () => {
    const dir = mini({ "src/flagKeys.ts": KEYS, "src/D.ts": 'export const k = "flag_x";\n' });
    expect(() => computeCodeEdits(ctx(dir, "b"))).toThrow(/no flag read the codemod knows/);
  });
  it("leaves the flag key constant alone while something still uses it", () => {
    const dir = mini({
      "src/flagKeys.ts": KEYS,
      "src/C.tsx": comp('  if (v === "b") {\n    return 1;\n  }\n  return 2;'),
      "src/other.ts": "import { FLAG_KEYS } from \"./flagKeys\";\nexport const x = [FLAG_KEYS.fx];\n",
    });
    // other.ts mentions the flag through the constant and is not a pattern: refused, so the constant is never half removed
    expect(() => computeCodeEdits(ctx(dir, "b"))).toThrow(CodemodError);
  });
});
