import type { PlanVerdict, RolloutDecision } from "./types.js";

/**
 * Deterministic decision brief (markdown), built only from the verdict numbers and the rollout decision. No model is involved,
 * so the same inputs always give the same text. `--explain` may rewrite it in plain words but never changes the decision.
 */
export interface BriefInput {
  flag: string;
  environment: string;
  experiment: { id: number; name: string; status: string };
  verdict: PlanVerdict;
  rollout: RolloutDecision;
  /** Number of files the code change touches (0: the flag is landed alone). */
  codeFiles?: number;
}

const pct = (x: number | null, digits = 1): string => (x === null ? "n/a" : `${(x * 100).toFixed(digits)}%`);
const signed = (x: number | null): string => (x === null ? "n/a" : `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}%`);

export function renderBrief(b: BriefInput): string {
  const v = b.verdict;
  const out: string[] = [];
  out.push(`# Decision brief: ${b.flag} in ${b.environment}`);
  out.push("");
  out.push(`**Verdict: ${v.label}** (${v.decision}, ${v.kind})`);
  out.push("");
  out.push(
    `Experiment ${b.experiment.id} "${b.experiment.name}" is ${b.experiment.status}. Primary metric: ${v.metricName ?? "n/a"}. Results as of ${v.asOf ?? "n/a"}.`,
  );
  out.push("");
  out.push("## Numbers");
  out.push("");
  out.push("| Arm | Exposures | Conversions | Rate | Relative lift vs control | 95% interval (relative) | Chance to beat control |");
  out.push("|---|---|---|---|---|---|---|");
  for (const a of v.arms) {
    const interval = a.isControl ? "-" : `${signed(a.ciLow)} to ${signed(a.ciHigh)}`;
    out.push(
      `| ${a.key} | ${a.exposures} | ${a.conversions} | ${pct(a.rate, 2)} | ${a.isControl ? "-" : signed(a.lift)} | ${interval} | ${a.isControl ? "-" : pct(a.chanceToWin)} |`,
    );
  }
  out.push("");
  out.push(`Sample ratio check: ${v.srmPValue === null ? "not computed" : `p = ${v.srmPValue.toPrecision(3)} (refused below 0.001)`}.`);
  out.push("");
  out.push("## Why");
  out.push("");
  for (const r of v.reasons) out.push(`- ${r.message}`);
  out.push("");
  out.push("## What landing does");
  out.push("");
  if (b.rollout.decision === "variant") {
    out.push(
      `- Ends experiment ${b.experiment.id} and rolls out variant \`${b.rollout.variantKey}\` (multivariate option ${b.rollout.variantOptionId}) in ${b.environment}.`,
    );
  } else {
    out.push(`- Ends experiment ${b.experiment.id} and keeps control in ${b.environment}; the variants stop being served.`);
  }
  out.push(
    "- This step is irreversible: Flagsmith cannot reopen a completed experiment. `lander rollback` restores only the flag value, enabled state and weights.",
  );
  if (b.codeFiles && b.codeFiles > 0) {
    out.push(
      `- First opens a draft pull request (${b.codeFiles} file${b.codeFiles === 1 ? "" : "s"}) that hard-codes the winner and deletes the losing branches and the flag read; the experiment is completed only after that PR exists and the repo tests pass.`,
    );
  } else {
    out.push("- No code changes are part of this plan.");
  }
  out.push("");
  return out.join("\n");
}
