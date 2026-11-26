import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { applyPlan, CodeStageStopped, DriftDetected } from "../src/executor/apply.js";
import { CodeChangeFailed } from "../src/executor/codeChange.js";
import { landBranchName } from "../src/executor/git.js";
import { renderRetire, runRetireChecks } from "../src/executor/retire.js";
import { runLand } from "../src/land.js";
import { approve } from "../src/plan/approve.js";
import { buildLandPlan } from "../src/plan/builder.js";
import { approvalPrefix, planHash } from "../src/plan/hash.js";
import { PlanStore, PlanTampered } from "../src/plan/store.js";
import type { Approval } from "../src/plan/types.js";
import { codemodEdits } from "../src/repo/edits.js";
import { FakePort, harness, STAGING_KEY, ttyIO } from "./fakePort.js";
import { assertTemp, git, makeShopRepo, SHOP_PRESENT, stubRunner, type StubOptions } from "./gitRepo.js";

const SHOP_WINNER = {
  flag: "checkout_cta",
  initialValue: "copy-invite",
  control: { n: 1000, conv: 100 },
  variants: { "get-everyones-times": { n: 1000, conv: 150, chance: 0.99, lift: 0.05, ciLow: 0.01, ciHigh: 0.09 } },
  weights: { "get-everyones-times": 50 },
};

type H = ReturnType<typeof harness>;

interface Setup {
  h: H;
  repo: string;
  runner: ReturnType<typeof stubRunner>;
  build: () => ReturnType<typeof buildLandPlan>;
  approved: () => Promise<{ id: string; hash: string; approval: Approval }>;
  apply: (id: string, approval: Approval, withCode?: boolean) => ReturnType<typeof applyPlan>;
}

function setup(opts: StubOptions = {}, extraFiles: Record<string, string> = {}): Setup {
  const h = harness({ port: new FakePort(SHOP_WINNER) });
  const repo = makeShopRepo(extraFiles);
  const runner = stubRunner(opts);
  const build = () =>
    buildLandPlan({
      port: h.port,
      envName: h.ctx.envName,
      envKey: h.ctx.envKey,
      protectedEnv: false,
      flag: "checkout_cta",
      clock: h.ctx.clock,
      code: { provider: codemodEdits, repoPath: repo, baseBranch: "main" },
    });
  const approved = async () => {
    const b = await build();
    const id = h.store.save(b.plan, b.hash);
    const approval = await approve(b.plan, b.hash, ttyIO([approvalPrefix(b.hash)]), { now: h.ctx.clock.now, user: () => "tester" });
    return { id, hash: b.hash, approval };
  };
  const apply = (id: string, approval: Approval, withCode = true) =>
    applyPlan(id, approval, {
      port: h.port,
      store: h.store,
      journal: h.journal,
      envKey: h.ctx.envKey,
      clock: h.ctx.clock,
      ...(withCode ? { code: { repoPath: repo, runner, log: (l: string) => void h.lines.push(l) } } : {}),
    });
  return { h, repo, runner, build, approved, apply };
}

const types = (h: H): string[] => h.journal.readAll().map((e) => e.type);

describe.skipIf(!SHOP_PRESENT)("code change before complete (S6, B6)", () => {
  it("plans the edits inside the hash, and shows the diff and the order in the plan", async () => {
    const s = setup();
    const { plan, hash } = await s.build();
    expect(plan.codeEdits.length).toBeGreaterThan(0);
    expect(plan.code).toEqual({ baseBranch: "main", losingKeys: ["copy-invite"], props: ["checkoutCta"] });
    expect(planHash(plan)).toBe(hash);
    const changed = { ...plan, codeEdits: plan.codeEdits.map((e, i) => (i === 0 ? { ...e, newString: `${e.newString} ` } : e)) };
    expect(planHash(changed)).not.toBe(hash);
    const out: string[] = [];
    await runLand("checkout_cta", { dryRun: true }, { ...s.h.ctx, log: (l) => void out.push(l), code: { provider: codemodEdits, repoPath: s.repo, baseBranch: "main", runner: s.runner } });
    const text = out.join("\n");
    expect(text).toContain("+ branch lander/land-checkout_cta-");
    expect(text).toContain("src/components/CheckoutButton.tsx");
    expect(text).toContain("THEN complete the experiment");
    expect(text).toContain('-  return <button className="cta cta-invite">Copy invite link</button>;');
    expect(s.runner.calls.filter((c) => c.cmd !== "git").length).toBe(0); // a dry run runs no tests, no gh
    expect(git(s.repo, "branch", "--list").trim()).toBe("* main");
  });

  it("happy path: branch, edits, tests, commit, push, draft PR, and only then complete", async () => {
    const s = setup();
    const { id, hash, approval } = await s.approved();
    let ghBeforeComplete = false;
    s.h.port.onWrite = () => void (ghBeforeComplete = s.runner.calls.some((c) => c.cmd === "gh" && c.args[0] === "pr" && c.args[1] === "create"));
    const res = await s.apply(id, approval);

    expect(ghBeforeComplete).toBe(true);
    expect(res.codeChange?.prUrl).toBe("https://github.com/example/shop/pull/7");
    const branch = landBranchName("checkout_cta", id);
    expect(git(s.repo, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe(branch);
    expect(git(s.repo, "status", "--porcelain").trim()).toBe("");
    const message = git(s.repo, "log", "-1", "--format=%B");
    expect(message).toContain("Land checkout_cta: ship get-everyones-times");
    expect(message).not.toMatch(/claude|anthropic|co-authored|generated/i);
    expect(readFileSync(join(s.repo, "src/components/CheckoutButton.tsx"), "utf8")).not.toContain("useVariant");

    const calls = s.runner.calls;
    const at = (p: (c: (typeof calls)[number]) => boolean) => calls.findIndex(p);
    const iTest = at((c) => c.cmd === "pnpm");
    const iPush = at((c) => c.cmd === "git" && c.args[0] === "push");
    const iGh = at((c) => c.cmd === "gh");
    expect(iTest).toBeGreaterThan(-1);
    expect(iTest).toBeLessThan(iPush);
    expect(iPush).toBeLessThan(iGh);
    expect(calls[iPush]?.args).toEqual(["push", "-u", "origin", branch]);
    const gh = calls[iGh]?.args ?? [];
    expect(gh.slice(0, 3)).toEqual(["pr", "create", "--draft"]);
    expect(gh).toEqual(expect.arrayContaining(["--base", "main", "--head", branch, "--title", "Land checkout_cta: ship get-everyones-times"]));
    const bodyFile = gh[gh.indexOf("--body-file") + 1] as string;
    expect(bodyFile.endsWith(join(id, "pr.md"))).toBe(true);
    const body = readFileSync(bodyFile, "utf8");
    expect(body).toContain(hash);
    expect(body).toContain("Decision brief");
    expect(body).not.toContain(STAGING_KEY);
    expect(body).not.toMatch(/claude|co-authored/i);

    const entries = s.h.journal.readAll();
    expect(types(s.h)).toEqual(["approval", "code_started", "code_done", "apply_started", "step_done", "apply_done"]);
    const done = entries.find((e) => e.type === "code_done");
    expect(done?.data["prUrl"]).toBe("https://github.com/example/shop/pull/7");
    expect(body).toContain(entries[0]?.id as string);
    expect(s.h.journal.verify().ok).toBe(true);
    expect(s.h.port.writes).toEqual([`complete:1:variant`]);
  });

  it("a flag edited while the code stage ran stops before complete: PR open, Flagsmith untouched, journal says why", async () => {
    const s = setup();
    const { id, approval } = await s.approved();
    const runner = (async (cmd: string, args: string[], o?: { cwd?: string }) => {
      if (cmd === "pnpm") s.h.port.flag = { ...s.h.port.flag, enabled: false };
      return s.runner(cmd, args, o);
    }) as typeof s.runner;
    const err = await applyPlan(id, approval, { port: s.h.port, store: s.h.store, journal: s.h.journal, envKey: s.h.ctx.envKey, clock: s.h.ctx.clock, code: { repoPath: s.repo, runner, log: () => undefined } }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DriftDetected);
    expect((err as Error).message).toMatch(/NOT completed/);
    expect(s.h.port.writes).toEqual([]);
    expect(types(s.h)).toEqual(["approval", "code_started", "code_done", "code_stopped"]);
    expect(s.h.journal.verify().ok).toBe(true);
  });

  it("a dirty working tree is refused before any branch exists, and nothing is completed", async () => {
    const s = setup();
    const { id, approval } = await s.approved();
    writeFileSync(join(s.repo, "scratch.txt"), "my uncommitted work");
    await expect(s.apply(id, approval)).rejects.toThrow(/not clean/);
    expect(git(s.repo, "branch", "--list").trim()).toBe("* main");
    expect(s.h.port.writes).toEqual([]);
    expect(types(s.h)).toEqual(["approval", "code_started", "code_failed"]);
  });

  it("failing tests: stop, leave the branch, no push, no PR, no complete", async () => {
    const s = setup({ testsPass: false });
    const { id, approval } = await s.approved();
    const err = await s.apply(id, approval).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CodeChangeFailed);
    expect((err as CodeChangeFailed).stage).toBe("tests");
    expect((err as Error).message).toContain("1 failed");
    expect(git(s.repo, "branch", "--list").trim()).toContain(landBranchName("checkout_cta", id));
    expect(s.runner.calls.some((c) => c.cmd === "gh" || (c.cmd === "git" && c.args[0] === "push"))).toBe(false);
    expect(s.h.port.writes).toEqual([]);
    expect(types(s.h)).not.toContain("apply_started");
    expect(types(s.h)).toContain("code_failed");
  });

  it("residue left behind: stop before the tests even run", async () => {
    const s = setup({}, { "src/config.json": '{ "flag": "checkout_cta" }\n' });
    const { id, approval } = await s.approved();
    const err = await s.apply(id, approval).catch((e: unknown) => e);
    expect((err as CodeChangeFailed).stage).toBe("residue");
    expect((err as Error).message).toContain("src/config.json:1");
    expect(s.runner.calls.some((c) => c.cmd === "pnpm" || c.cmd === "gh")).toBe(false);
    expect(s.h.port.writes).toEqual([]);
  });

  it("no remote: stops after the local commit with a clear message, and does not complete", async () => {
    const s = setup({ remote: false });
    const { id, approval } = await s.approved();
    const err = await s.apply(id, approval).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CodeStageStopped);
    expect((err as Error).message).toMatch(/no git remote "origin"/);
    expect((err as Error).message).toMatch(/NOT completed/);
    expect(git(s.repo, "log", "-1", "--format=%s").trim()).toBe("Land checkout_cta: ship get-everyones-times");
    expect(s.runner.calls.some((c) => c.cmd === "gh" || (c.cmd === "git" && c.args[0] === "push"))).toBe(false);
    expect(s.h.port.writes).toEqual([]);
    expect(types(s.h)).toEqual(["approval", "code_started", "code_stopped"]);
  });

  it("a failed push or a failed gh call leaves Flagsmith untouched", async () => {
    for (const o of [{ pushFails: true }, { ghFails: true }]) {
      const s = setup(o);
      const { id, approval } = await s.approved();
      await expect(s.apply(id, approval)).rejects.toThrow(CodeChangeFailed);
      expect(s.h.port.writes).toEqual([]);
      expect(types(s.h)).not.toContain("apply_started");
    }
  });

  it("refuses to start from a branch other than the base, from an old base, or when the landing branch exists", async () => {
    const a = setup();
    const ap = await a.approved();
    git(a.repo, "switch", "-q", "-c", "feature/mine");
    await expect(a.apply(ap.id, ap.approval)).rejects.toThrow(/not on the base branch/);

    const b = setup({ behind: 2 });
    const bp = await b.approved();
    await expect(b.apply(bp.id, bp.approval)).rejects.toThrow(/2 commit\(s\) behind/);

    const c = setup();
    const cp = await c.approved();
    git(c.repo, "branch", landBranchName("checkout_cta", cp.id));
    await expect(c.apply(cp.id, cp.approval)).rejects.toThrow(/already exists/);
    for (const s of [a, b, c]) expect(s.h.port.writes).toEqual([]);
  });

  it("refuses when the repo changed after the plan was made (file hash differs)", async () => {
    const s = setup();
    const { id, approval } = await s.approved();
    const file = join(s.repo, "src/components/CheckoutButton.tsx");
    writeFileSync(file, `${readFileSync(file, "utf8")}\n// edited after planning\n`);
    git(s.repo, "commit", "-q", "-am", "edit after plan");
    await expect(s.apply(id, approval)).rejects.toThrow(/hash differs/);
    expect(git(s.repo, "branch", "--list").trim()).toBe("* main");
    expect(s.h.port.writes).toEqual([]);
  });

  it("a plan with code edits is not applied without a repo, and an edited plan file is refused", async () => {
    const s = setup();
    const { id, approval } = await s.approved();
    await expect(s.apply(id, approval, false)).rejects.toThrow(/no target repo is configured/);
    expect(s.h.port.writes).toEqual([]);

    const t = setup();
    const tp = await t.approved();
    const f = t.h.store.file(tp.id);
    const raw = JSON.parse(readFileSync(f, "utf8")) as { plan: { codeEdits: { newString: string }[] } };
    (raw.plan.codeEdits[0] as { newString: string }).newString += "// injected\n";
    writeFileSync(f, JSON.stringify(raw));
    await expect(t.apply(tp.id, tp.approval)).rejects.toThrow(PlanTampered);
    expect(t.runner.calls.length).toBe(0);
  });

  it("a plan without code edits still completes with no git or gh call (flag-only landing)", async () => {
    const h = harness({ port: new FakePort(SHOP_WINNER) });
    const b = await buildLandPlan({ port: h.port, envName: "staging", envKey: h.ctx.envKey, protectedEnv: false, flag: "checkout_cta", clock: h.ctx.clock });
    expect(b.plan.codeEdits).toEqual([]);
    expect(b.plan.code).toBeUndefined();
    expect(b.plan.brief).toContain("No code changes are part of this plan.");
  });
});

describe.skipIf(!SHOP_PRESENT)("lander retire (gate checks, dry run)", () => {
  async function landed(opts: StubOptions = {}) {
    const s = setup(opts);
    const { id, approval } = await s.approved();
    await s.apply(id, approval);
    return s;
  }
  const run = (s: Setup, repoPath: string | null = s.repo) =>
    runRetireChecks("checkout_cta", { port: s.h.port, envName: "staging", envKey: s.h.ctx.envKey, journal: s.h.journal, repoPath, runner: s.runner });
  const status = (r: Awaited<ReturnType<typeof run>>, id: string) => r.checks.find((c) => c.id === id)?.status;

  it("passes when the experiment is completed, the PR is merged and nothing refers to the flag", async () => {
    const s = await landed();
    const r = await run(s);
    expect(r.checks.map((c) => `${c.id}:${c.status}`)).toEqual([
      "experiment:pass",
      "landed:pass",
      "other_environments:info",
      "pr_merged:pass",
      "references:pass",
      "archive:info",
    ]);
    expect(r.ready).toBe(true);
    expect(renderRetire(r)).toContain("dry run");
    expect(s.runner.calls.some((c) => c.cmd === "gh" && c.args[1] === "view" && c.args[2] === "https://github.com/example/shop/pull/7")).toBe(true);
  });

  it("is read only: no Flagsmith write, no journal entry, only gh pr view", async () => {
    const s = await landed();
    const writes = [...s.h.port.writes];
    const lines = s.h.journal.readAll().length;
    const before = s.runner.calls.length;
    await run(s);
    expect(s.h.port.writes).toEqual(writes);
    expect(s.h.journal.readAll().length).toBe(lines);
    expect(s.runner.calls.slice(before).map((c) => `${c.cmd} ${c.args.slice(0, 2).join(" ")}`)).toEqual(["gh pr view"]);
  });

  it("fails while the PR is open", async () => {
    const s = await landed({ prState: "OPEN" });
    const r = await run(s);
    expect(status(r, "pr_merged")).toBe("fail");
    expect(r.ready).toBe(false);
  });

  it("fails when code still refers to the flag", async () => {
    const s = await landed();
    writeFileSync(join(s.repo, "src/back.ts"), 'export const old = "checkout_cta";\n');
    const r = await run(s);
    expect(status(r, "references")).toBe("fail");
    expect(r.ready).toBe(false);
  });

  it("fails when the flag was edited after the landing, when an experiment is still running, or when nothing was landed", async () => {
    const s = await landed();
    s.h.port.flag = { ...s.h.port.flag, value: "something-else" };
    expect(status(await run(s), "landed")).toBe("fail");

    const fresh = setup();
    const r = await run(fresh);
    expect(status(r, "experiment")).toBe("fail");
    expect(status(r, "landed")).toBe("fail");
    expect(status(r, "references")).toBe("fail");
    expect(r.ready).toBe(false);
  });

  it("cannot pass the reference check without a repo", async () => {
    const s = await landed();
    expect(status(await run(s, null), "references")).toBe("unknown");
  });
});

// Captured when this file loads, before any test runs: the project folder may be a real git checkout, and the tests
// must neither create nor remove its .git.
const realGitAtStart = existsSync(join(process.cwd(), ".git"));

describe("never touches the real folders", () => {
  it("test helpers refuse a folder outside the OS temp dir", () => {
    expect(() => git(join(process.cwd()), "status")).toThrow(/throwaway/);
    expect(() => assertTemp(`${tmpdir()}2${sep}x`)).toThrow(/throwaway/);
    expect(() => assertTemp(tmpdir())).toThrow(/throwaway/);
    expect(existsSync(join(process.cwd(), ".git"))).toBe(realGitAtStart);
  });
});
