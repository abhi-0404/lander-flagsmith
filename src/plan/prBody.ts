import { diffStat, diffLines } from "../repo/diff.js";
import { redactSecrets, stripAnsi } from "../repo/fsGuard.js";
import type { CodeEdit, LandPlan } from "./types.js";

/** Pull request title and commit subject: plain words, no attribution. */
export function prTitle(plan: LandPlan): string {
  return plan.rollout.decision === "variant" ? `Land ${plan.flag.name}: ship ${plan.rollout.variantKey}` : `Land ${plan.flag.name}: keep control`;
}

const lines = (s: string): string[] => (s === "" ? [] : s.replace(/\n$/, "").split("\n"));

export function editStats(edits: CodeEdit[]): { path: string; added: number; removed: number; deleted: boolean }[] {
  const byPath = new Map<string, { added: number; removed: number; deleted: boolean }>();
  for (const e of edits) {
    const st = diffStat(diffLines(lines(e.oldString), lines(e.newString)));
    const cur = byPath.get(e.path) ?? { added: 0, removed: 0, deleted: false };
    byPath.set(e.path, { added: cur.added + st.added, removed: cur.removed + st.removed, deleted: cur.deleted || e.delete === true });
  }
  return [...byPath].map(([path, v]) => ({ path, ...v }));
}

export interface PrBodyInput {
  plan: LandPlan;
  hash: string;
  planId: string;
  /** Id of the journal `approval` entry for this plan. */
  journalId: string;
  testCommand: string;
  /** Last lines of the test output. */
  testTail: string;
  /** Extra literals to scrub (the environment key). */
  redact?: string[];
}

/** The PR description: the decision brief, the code change, the checks, and the audit references. */
export function renderPrBody(i: PrBodyInput): string {
  const out: string[] = [i.plan.brief.trimEnd(), "", "## Code change", ""];
  for (const s of editStats(i.plan.codeEdits)) out.push(`- \`${s.path}\`: ${s.deleted ? "deleted" : `+${s.added} -${s.removed}`}`);
  const reasons = [...new Set(i.plan.codeEdits.map((e) => e.reason))];
  out.push("", "Why each edit:", ...reasons.map((r) => `- ${r}`));
  out.push("", "## Checks", "");
  out.push(`- \`${i.testCommand}\`: passed.`);
  out.push(`- Residue check: no mention of \`${i.plan.flag.name}\`${i.plan.code?.losingKeys.length ? ` or of ${i.plan.code.losingKeys.map((k) => `\`${k}\``).join(", ")}` : ""} is left in the repo.`);
  const tail = redactSecrets(stripAnsi(i.testTail), i.redact ?? []).trim();
  if (tail) out.push("", "```", tail, "```");
  out.push("", "## Audit", "");
  out.push(`- Plan ${i.planId} (hash \`${i.hash}\`), environment ${i.plan.environment.name}.`);
  out.push(`- Journal entry \`${i.journalId}\` (the approval); the PR URL is journaled next to it.`);
  out.push("- This pull request was opened as a draft before the experiment was completed. Review it like any other change.");
  out.push("");
  return redactSecrets(out.join("\n"), i.redact ?? []);
}
