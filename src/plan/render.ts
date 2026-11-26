import { bold, green, red, yellow } from "../output/colors.js";
import { landBranchName } from "../executor/git.js";
import { unifiedDiff } from "../repo/diff.js";
import { approvalPrefix, planIdOf } from "./hash.js";
import { editStats } from "./prBody.js";
import type { FlagState, LandPlan } from "./types.js";

export const fmtFlagState = (s: FlagState): string => {
  const parts: string[] = [];
  if (s.value !== null) parts.push(`value ${JSON.stringify(s.value)}`);
  if (s.enabled !== null) parts.push(s.enabled ? "enabled" : "disabled");
  if (s.weights)
    parts.push(
      `weights ${Object.entries(s.weights)
        .map(([k, v]) => `${k}=${v}`)
        .join("/")}`,
    );
  return parts.length > 0 ? parts.join(", ") : "(not readable)";
};

/** Terraform-style plan for the terminal. Everything shown here is inside the hash. */
export function renderPlan(plan: LandPlan, hash: string): string {
  const v = plan.verdict;
  const out: string[] = [];
  const winnerTxt = plan.rollout.decision === "variant" ? `"${plan.rollout.variantKey}"` : "control";
  out.push(bold(`Verdict: ${green(v.label)}`) + `  (${v.metricName ?? "n/a"}, results as of ${v.asOf ?? "n/a"})`);
  for (const a of v.arms.filter((x) => !x.isControl)) {
    const chance = a.chanceToWin === null ? "n/a" : `${(a.chanceToWin * 100).toFixed(1)}%`;
    out.push(`  ${a.key}: chance to beat control ${chance}, ${a.exposures} exposures`);
  }
  out.push("");
  out.push(
    bold(`Plan ${approvalPrefix(hash)} (hash ${hash}) for environment: ${plan.environment.name}${plan.environment.protected ? " (PROTECTED)" : ""}`),
  );
  out.push(`  source: ${plan.source}, created ${plan.createdAt}, expires ${plan.expiresAt}`);
  for (const s of plan.steps) {
    out.push(`  ~ experiment ${plan.experiment.id} "${plan.experiment.name}"  ${plan.experiment.status} -> completed, roll out ${winnerTxt}`);
    out.push(`      ${s.method} ${s.path}  ${JSON.stringify(s.body)}`);
    out.push(`      ${red("IRREVERSIBLE")}: Flagsmith cannot reopen a completed experiment`);
  }
  out.push(`  ~ flag ${plan.flag.name}  now: ${fmtFlagState(plan.flagBefore)}  (restorable with lander rollback)`);
  if (plan.codeEdits.length === 0) {
    out.push("  . code: no edits in this plan (no code in the target repo refers to this flag, or code changes are switched off)");
  } else {
    const stats = editStats(plan.codeEdits);
    const added = stats.reduce((n, s) => n + s.added, 0);
    const removed = stats.reduce((n, s) => n + s.removed, 0);
    out.push(
      `  + branch ${landBranchName(plan.flag.name, planIdOf(hash))} from ${plan.code?.baseBranch ?? "?"} (${stats.length} file${stats.length === 1 ? "" : "s"}, ${green(`+${added}`)} ${red(`-${removed}`)})`,
    );
    out.push("      order: repo tests and residue check, push, draft PR, THEN complete the experiment (the irreversible step is last)");
    for (const s of stats) out.push(`      ~ ${s.path}${s.deleted ? " (deleted)" : ` +${s.added} -${s.removed}`}`);
    out.push("");
    out.push(bold("  Code diff (exact edits, inside the plan hash):"));
    const paths = [...new Set(plan.codeEdits.map((e) => e.path))];
    for (const p of paths) {
      const mine = plan.codeEdits.filter((e) => e.path === p);
      out.push(`  --- a/${p}`);
      out.push(`  +++ ${mine.some((e) => e.delete) ? "/dev/null" : `b/${p}`}`);
      for (const e of mine) {
        out.push(`  # ${e.reason}`);
        for (const l of unifiedDiff(e.oldString, e.newString, 2, false)) out.push("  " + (l.startsWith("+") ? green(l) : l.startsWith("-") ? red(l) : l));
      }
    }
    out.push("");
  }
  if (plan.environment.protected) out.push(yellow("  ! risk: protected environment write, typed confirmation required"));
  return out.join("\n");
}
