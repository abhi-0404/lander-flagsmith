# Verdict rules

Implemented in `src/verdict/engine.ts` (pure, no I/O) and `src/verdict/srm.ts`. The LLM never decides; it only explains.

Decision: `SHIP` (landing allowed), `KEEP_RUNNING` (wait), `REFUSE` (untrustworthy or blocked). Each verdict also has a `kind`,
a label and a list of reasons (`block`, `wait`, `info`).

Rules run in this order, first match wins. Primary metric = the experiment's first metric, other metrics are guardrails.

| # | Condition | Decision | Kind |
|---|---|---|---|
| 1 | Experiment status completed | REFUSE | COMPLETED |
| 2 | Experiment status created (not started) | KEEP_RUNNING | NOT_STARTED |
| 3 | No results yet (`results: null`) or no metric | KEEP_RUNNING | COLLECTING |
| 4 | Any arm under 50 exposures, or under 5 conversions on the primary metric | KEEP_RUNNING | COLLECTING (with an ETA from the exposure rate) |
| 5 | SRM chi-square p < 0.001 against the allocation, or Flagsmith's own `srm_p_value` < 0.001, or excluded identities above 1 percent | REFUSE | DO_NOT_TRUST |
| 6 | Results older than 60 minutes (not `is_final`) or no `as_of` | REFUSE | STALE |
| 6b | Primary metric or any guardrail without a readable direction (`expected_direction`/`direction` missing, unknown or contradictory) | REFUSE | DO_NOT_TRUST |
| 7 | A variant at 95 percent or more chance to beat control with an interval that excludes zero, but it is likely worse (under 5 percent) on a guardrail | REFUSE | GUARDRAIL_HARM |
| 8 | Same winner, guardrails fine (best variant if several) | SHIP | SHIP_VARIANT (carries the MV option id) |
| 9 | Every variant under 5 percent chance to beat control | SHIP | SHIP_CONTROL |
| 10 | Anything else | KEEP_RUNNING | KEEP_RUNNING (names the best arm and what is needed) |

Paused experiments are judged like running ones, with an info reason.

Fail-closed details (reviewer pass, 2026-11-26):
- A winner needs BOTH a chance to beat control of 95 percent or more AND a raw interval on the good side of zero (above zero for
  increase metrics, below zero for decrease metrics). If `chance_to_win` were oriented the other way, the two would disagree and
  nothing ships. SHIP CONTROL likewise needs every variant's lift to have moved the bad way.
- Guardrail harm: chance under 5 percent OR a raw interval entirely on the harmful side (so harm is caught under either orientation).
  A guardrail with no inference for the winner gives KEEP_RUNNING (`GUARDRAIL_PENDING`).
- If the results carry metric ids and none matches the experiment's first metric, there is no primary (`PRIMARY_METRIC_MISSING`,
  KEEP_RUNNING); a guardrail is never judged as the primary.
- A winning arm that maps to no multivariate option is refused (`UNMAPPED_WINNER`), so SHIP_VARIANT always carries an option id.

## Why the SRM is computed in code

Flagsmith returns `payload.srm_p_value: null` even with 1,530 exposures (observed on self-hosted 2.295.2). Lander runs a chi-square
goodness of fit on the exposure counts per arm against the experiment's allocation (`experiment_rollout`, control is the remainder,
equal split when the allocation is unknown). Exposure counts come from `exposures` first, then the results timeseries, then the
metric's `variants[].n`.

## Assumptions to confirm on Flagsmith Cloud

- `chance_to_win` is oriented toward the metric's expected direction (high means better). The guardrail check relies on it.
- The 0.001 SRM threshold and 60 minute freshness limit are Lander's choices, not Flagsmith documented values.
- The 50 identity and 5 conversion floors are from the Flagsmith statistics doc as cited in the idea document.
- All thresholds are overridable through `VerdictConfig` (`DEFAULT_VERDICT_CONFIG`).
