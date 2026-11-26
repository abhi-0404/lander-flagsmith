// Gate 3 (S11): retire a landed flag only when everything says it is safe. Read only: this release prints the gate checks
// (cut list item 6) and does not archive anything.
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { assertFlagKey } from "../flagsmith/cli.js";
import { sameFlagState } from "../flagsmith/flagState.js";
import type { LandPort } from "../flagsmith/landPort.js";
import { bold, green, red, yellow } from "../output/colors.js";
import { flagStateSchema } from "../plan/types.js";
import { discoverAliases } from "../repo/edits.js";
import { findHits } from "../repo/search.js";
import { prState } from "./github.js";
import type { Journal, JournalEntry } from "./journal.js";
import type { Runner } from "./runner.js";

export type CheckStatus = "pass" | "fail" | "unknown" | "info";

export interface RetireCheck {
  id: "experiment" | "landed" | "other_environments" | "pr_merged" | "references" | "archive";
  title: string;
  status: CheckStatus;
  detail: string;
}

export interface RetireReport {
  flag: string;
  environment: string;
  checks: RetireCheck[];
  /** True only when every gate passed (unknown counts as not passed). */
  ready: boolean;
}

export interface RetireDeps {
  port: LandPort;
  envName: string;
  envKey: string;
  journal: Journal;
  /** Target repo, or null when none is configured (the reference check then cannot pass). */
  repoPath: string | null;
  runner: Runner;
}

const str = (x: unknown): string => (typeof x === "string" ? x : "");

/** The last journal entry of `type` for this flag in this environment (via the plan's apply_started entry). */
function lastFor(entries: JournalEntry[], type: JournalEntry["type"], flag: string, env: string): JournalEntry | undefined {
  const plans = new Set(
    entries.filter((e) => e.type === "apply_started" && e.data["flag"] === flag && (e.data["environment"] as { name?: string } | undefined)?.name === env).map((e) => e.planId),
  );
  return [...entries].reverse().find((e) => e.type === type && e.planId !== null && plans.has(e.planId));
}

export async function runRetireChecks(flagKey: string, deps: RetireDeps): Promise<RetireReport> {
  const flag = assertFlagKey(flagKey);
  const checks: RetireCheck[] = [];
  const add = (c: RetireCheck): void => void checks.push(c);
  const entries = deps.journal.readAll();

  // 1. The experiment on the flag is completed and nothing is still running.
  const exps = (await deps.port.listExperiments(deps.envKey)).filter((e) => e.feature.name === flag);
  const live = exps.filter((e) => e.status !== "completed");
  add({
    id: "experiment",
    title: "every experiment on the flag is completed",
    status: exps.length === 0 || live.length > 0 ? "fail" : "pass",
    detail: exps.length === 0 ? "no experiment found on this flag" : live.length > 0 ? `${live.map((e) => `#${e.id} is ${e.status}`).join(", ")}` : `${exps.map((e) => `#${e.id}`).join(", ")} completed`,
  });

  // 2. Lander landed it here, and the flag still serves what the landing left (S11).
  const done = lastFor(entries, "apply_done", flag, deps.envName);
  if (!done) {
    add({ id: "landed", title: `Lander landed the flag in ${deps.envName}`, status: "fail", detail: "no finished landing for this flag in the journal" });
  } else {
    const expected = flagStateSchema.safeParse(done.data["after"]);
    const now = await deps.port.readFlagState(deps.envKey, flag);
    const same = expected.success && sameFlagState(now.state, expected.data);
    add({
      id: "landed",
      title: `the flag in ${deps.envName} still serves the landed state`,
      status: same ? "pass" : "fail",
      detail: same ? `landed by plan ${done.planId} (journal ${done.id}) and unchanged since` : "the flag differs from the state the landing left (someone edited it, or the landing record is unreadable)",
    });
  }
  add({
    id: "other_environments",
    title: "no other environment serves a different state",
    status: "info",
    detail: `only ${deps.envName} is read by this command; check the other environments in the Flagsmith dashboard before archiving`,
  });

  // 3. The cleanup PR is merged.
  const code = lastFor(entries, "code_done", flag, deps.envName);
  if (!code) {
    add({ id: "pr_merged", title: "the cleanup PR is merged", status: "pass", detail: "no code PR was recorded (landed without a code change); the reference check below decides" });
  } else {
    const url = str(code.data["prUrl"]);
    const state = await prState(deps.runner, deps.repoPath ?? process.cwd(), url);
    add({
      id: "pr_merged",
      title: "the cleanup PR is merged",
      status: state === "MERGED" ? "pass" : state === "UNKNOWN" ? "unknown" : "fail",
      detail: `${url} is ${state}`,
    });
  }

  // 4. Nothing in the repo refers to the flag any more.
  if (!deps.repoPath || !existsSync(resolve(deps.repoPath))) {
    add({ id: "references", title: "no code refers to the flag", status: "unknown", detail: "no target repo (set LANDER_REPO_PATH)" });
  } else {
    const root = resolve(deps.repoPath);
    const losing = Array.isArray(code?.data["losingKeys"]) ? (code?.data["losingKeys"] as unknown[]).map(str).filter(Boolean) : [];
    const props = Array.isArray(code?.data["props"]) ? (code?.data["props"] as unknown[]).map(str).filter(Boolean) : discoverAliases(root, flag).props;
    const hits = findHits(root, [flag, ...losing], props);
    add({
      id: "references",
      title: "no code refers to the flag",
      status: hits.length === 0 ? "pass" : "fail",
      detail: hits.length === 0 ? `0 references in ${root}` : `${hits.length} reference(s), first: ${hits[0]?.path}:${hits[0]?.line} (is the merged PR pulled into the checkout?)`,
    });
  }

  add({
    id: "archive",
    title: "typed confirmation, then archive",
    status: "info",
    detail: `dry run only in this release: archiving is not implemented. It would run \`flagsmith feature update ${flag} --archive\` after you type the flag name.`,
  });

  return { flag, environment: deps.envName, checks, ready: checks.filter((c) => c.status !== "info").every((c) => c.status === "pass") };
}

export function renderRetire(r: RetireReport): string {
  const mark = (s: CheckStatus): string => (s === "pass" ? green("PASS   ") : s === "fail" ? red("FAIL   ") : s === "unknown" ? yellow("UNKNOWN") : "INFO   ");
  const out = [bold(`Retire ${r.flag} in ${r.environment}: gate checks (dry run, nothing is changed)`), ""];
  for (const c of r.checks) out.push(`  ${mark(c.status)} ${c.title}`, `          ${c.detail}`);
  out.push("");
  out.push(r.ready ? green("All gates pass. Archiving is not implemented yet: archive the flag in the Flagsmith dashboard.") : red("Not ready to retire: fix the FAIL and UNKNOWN lines first."));
  return out.join("\n");
}
