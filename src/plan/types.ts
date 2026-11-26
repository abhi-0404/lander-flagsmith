import { z } from "zod";

/** Plan data model (Phase 2). The plan is the exact thing a human approves; its canonical JSON is hashed (S4). */

/** The part of a flag's state Lander can read back and restore. Normalized from `flagsmith flag get --json`. */
export const flagStateSchema = z.object({
  enabled: z.boolean().nullable(),
  value: z.union([z.string(), z.number(), z.boolean()]).nullable(),
  valueType: z.string().nullable(),
  /** multivariate option id (or key) to percentage */
  weights: z.record(z.string(), z.number()).nullable(),
});
export type FlagState = z.infer<typeof flagStateSchema>;

/** What `POST .../complete/` is asked to roll out. */
export const rolloutDecisionSchema = z.discriminatedUnion("decision", [
  z.object({ decision: z.literal("variant"), variantOptionId: z.number().int(), variantKey: z.string() }),
  z.object({ decision: z.literal("control") }),
]);
export type RolloutDecision = z.infer<typeof rolloutDecisionSchema>;

export const planStepSchema = z.object({
  kind: z.literal("complete_experiment"),
  irreversible: z.literal(true),
  method: z.literal("POST"),
  /** Path relative to the Flagsmith API host, with the environment key replaced by `{env}`. */
  path: z.string(),
  body: z.record(z.string(), z.unknown()),
});
export type PlanStep = z.infer<typeof planStepSchema>;

/**
 * One exact-match edit in the target repo (B6). `oldString` must occur exactly once in the file at apply time. The hashes bind the
 * edit to the file the human saw: `baseSha256` is the file before ALL edits of that path, `resultSha256` the file after them (LF
 * normalized). `delete` removes the whole file (`oldString` is its full content, `newString` is empty).
 */
export const codeEditSchema = z.object({
  path: z.string(),
  oldString: z.string(),
  newString: z.string(),
  reason: z.string(),
  baseSha256: z.string().regex(/^[0-9a-f]{64}$/),
  resultSha256: z.string().regex(/^[0-9a-f]{64}$/),
  delete: z.literal(true).optional(),
});
export type CodeEdit = z.infer<typeof codeEditSchema>;

const armSchema = z.object({
  key: z.string(),
  isControl: z.boolean(),
  exposures: z.number(),
  conversions: z.number(),
  rate: z.number().nullable(),
  lift: z.number().nullable(),
  ciLow: z.number().nullable(),
  ciHigh: z.number().nullable(),
  chanceToWin: z.number().nullable(),
});

export const planVerdictSchema = z.object({
  decision: z.enum(["SHIP", "KEEP_RUNNING", "REFUSE"]),
  kind: z.string(),
  label: z.string(),
  winner: z.object({ variant: z.string().nullable(), optionId: z.number().nullable() }).nullable(),
  metricName: z.string().nullable(),
  asOf: z.string().nullable(),
  srmPValue: z.number().nullable(),
  reasons: z.array(z.object({ code: z.string(), severity: z.string(), message: z.string() })),
  arms: z.array(armSchema),
});
export type PlanVerdict = z.infer<typeof planVerdictSchema>;

export const landPlanSchema = z.object({
  schema: z.literal(1),
  createdAt: z.string(),
  expiresAt: z.string(),
  /** "fixtures" plans are dry-run only and can never be applied. */
  source: z.enum(["live", "fixtures"]),
  environment: z.object({
    name: z.string(),
    /** Short SHA-256 of the environment key. The key itself is never stored in the plan. */
    keyFingerprint: z.string(),
    protected: z.boolean(),
  }),
  experiment: z.object({ id: z.number().int(), name: z.string(), status: z.string() }),
  flag: z.object({ name: z.string(), featureId: z.number().int() }),
  verdict: planVerdictSchema,
  rollout: rolloutDecisionSchema,
  /** Flag state read at plan time; `apply` aborts when the live state differs (drift check). */
  flagBefore: flagStateSchema,
  steps: z.array(planStepSchema),
  /** B6: exact-match code edits (inside the hash). Empty when the flag has no code references or code changes are switched off. */
  codeEdits: z.array(codeEditSchema),
  /** Set only when there are code edits: where the PR goes, and what must not be left in the repo (residue check, B6 step 3). */
  code: z
    .object({
      baseBranch: z.string(),
      /** Variant keys (and the control value) whose branches are deleted. */
      losingKeys: z.array(z.string()),
      /** Property names that held the flag key (e.g. checkoutCta in FLAG_KEYS.checkoutCta). */
      props: z.array(z.string()),
    })
    .optional(),
  /** Deterministic decision brief (markdown), built from the verdict. */
  brief: z.string(),
});
export type LandPlan = z.infer<typeof landPlanSchema>;

/** `.lander/plans/<id>/plan.json`: the plan plus its content hash. */
export const planFileSchema = z.object({ hash: z.string().regex(/^[0-9a-f]{64}$/), plan: landPlanSchema });
export type PlanFile = z.infer<typeof planFileSchema>;

/** Approval proof handed to the executor. Only `approve()` produces one in the CLI. */
export interface Approval {
  planHash: string;
  environment: string;
  user: string;
  at: string;
  /** What the human typed to approve: the hash prefix, plus the environment name when it is protected. */
  typed: { hashPrefix: string; environment?: string };
}
