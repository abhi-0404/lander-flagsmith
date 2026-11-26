import { z } from "zod";

/**
 * Typed parsing of the Flagsmith experiment payloads. Shapes come from the real fixtures captured on a
 * self-hosted Flagsmith 2.295.2 (see fixtures/real). Objects are loose: unknown fields are kept, never fatal.
 * Optional or nullable fields are those the real API was seen to omit or null.
 */

export const experimentStatusSchema = z.enum(["created", "running", "paused", "completed"]);
export type ExperimentStatus = z.infer<typeof experimentStatusSchema>;

export const mvOptionSchema = z.looseObject({
  id: z.number(),
  key: z.string().nullable().optional(),
  string_value: z.string().nullable().optional(),
  integer_value: z.number().nullable().optional(),
  boolean_value: z.boolean().nullable().optional(),
  default_percentage_allocation: z.number().optional(),
});
export type MvOption = z.infer<typeof mvOptionSchema>;

export const experimentFeatureSchema = z.looseObject({
  id: z.number(),
  name: z.string(),
  type: z.string().optional(),
  initial_value: z.string().nullable().optional(),
  multivariate_options: z.array(mvOptionSchema).default([]),
});

export const experimentMetricSchema = z.looseObject({
  id: z.number().optional(),
  metric: z.union([z.number(), z.string()]).optional(),
  metric_name: z.string().optional(),
  aggregation: z.string().optional(),
  direction: z.string().optional(),
  expected_direction: z.string().optional(),
});
export type ExperimentMetric = z.infer<typeof experimentMetricSchema>;

export const experimentRolloutSchema = z.looseObject({
  enabled: z.boolean().optional(),
  rollout_percentage: z.number().optional(),
  multivariate_feature_state_values: z
    .array(
      z.looseObject({
        multivariate_feature_option: z.number(),
        percentage_allocation: z.number(),
      }),
    )
    .default([]),
});

export const experimentSchema = z.looseObject({
  id: z.number(),
  feature: experimentFeatureSchema,
  name: z.string(),
  hypothesis: z.string().nullable().optional(),
  status: experimentStatusSchema,
  metrics: z.array(experimentMetricSchema).default([]),
  experiment_rollout: experimentRolloutSchema.optional(),
  created_at: z.string().optional(),
  started_at: z.string().nullable().optional(),
  ended_at: z.string().nullable().optional(),
  rollout_decision: z.string().nullable().optional(),
  rollout_variant: z.number().nullable().optional(),
});
export type Experiment = z.infer<typeof experimentSchema>;

export const experimentListPageSchema = z.looseObject({
  count: z.number().optional(),
  next: z.string().nullable().optional(),
  previous: z.string().nullable().optional(),
  results: z.array(experimentSchema),
});

const perVariantCounts = z.record(z.string(), z.number());

export const timeseriesSchema = z.looseObject({
  granularity: z.string().optional(),
  points: z
    .array(
      z.looseObject({
        bucket: z.string(),
        new_identities: perVariantCounts.optional(),
        converted_identities: perVariantCounts.optional(),
      }),
    )
    .default([]),
});

export const variantInferenceSchema = z.looseObject({
  lift: z.number().nullable().optional(),
  ci_low: z.number().nullable().optional(),
  ci_high: z.number().nullable().optional(),
  chance_to_win: z.number().nullable().optional(),
});
export type VariantInference = z.infer<typeof variantInferenceSchema>;

export const metricResultSchema = z.looseObject({
  metric_id: z.number().optional(),
  variants: z.record(
    z.string(),
    z.looseObject({ n: z.number(), sum: z.number(), sum_squares: z.number().optional() }),
  ),
  /** Control has no entry. Absent until enough data. */
  inference: z.record(z.string(), variantInferenceSchema).default({}),
  conversions_timeseries: timeseriesSchema.optional(),
});
export type MetricResult = z.infer<typeof metricResultSchema>;

export const resultsSchema = z.looseObject({
  as_of: z.string().nullable().optional(),
  last_error_at: z.string().nullable().optional(),
  refresh_requested_at: z.string().nullable().optional(),
  is_final: z.boolean().optional(),
  payload: z.looseObject({
    metrics: z.array(metricResultSchema).default([]),
    /** null in every real response seen, even with 1,530 exposures: compute SRM ourselves. */
    srm_p_value: z.number().nullable().optional(),
    exposures_timeseries: timeseriesSchema.optional(),
  }),
});
export type ExperimentResults = z.infer<typeof resultsSchema>;
/** GET .../results/ answers {"results": null} before the first refresh. */
export const resultsEnvelopeSchema = z.looseObject({ results: resultsSchema.nullable() });

export const exposuresSchema = z.looseObject({
  as_of: z.string().nullable().optional(),
  last_error_at: z.string().nullable().optional(),
  is_final: z.boolean().optional(),
  payload: z.looseObject({
    timeseries: timeseriesSchema.optional(),
    excluded_identities: z.number().optional(),
  }),
});
export type ExperimentExposures = z.infer<typeof exposuresSchema>;
export const exposuresEnvelopeSchema = z.looseObject({ exposures: exposuresSchema.nullable() });

/** Feature list items, only what scan needs to spot flags that have no experiment ("not mine"). */
export const featureSummarySchema = z.looseObject({
  id: z.number(),
  name: z.string(),
  type: z.string().optional(),
  is_archived: z.boolean().optional(),
  default_enabled: z.boolean().optional(),
});
export type FeatureSummary = z.infer<typeof featureSummarySchema>;
export const featureListPageSchema = z.looseObject({
  next: z.string().nullable().optional(),
  results: z.array(featureSummarySchema),
});

/** Parse with a readable error naming the payload that failed. */
export function parseWith<T>(schema: z.ZodType<T>, data: unknown, what: string): T {
  const r = schema.safeParse(data);
  if (r.success) return r.data;
  const lines = r.error.issues.slice(0, 5).map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`);
  throw new Error(`Unexpected Flagsmith payload for ${what}:\n${lines.join("\n")}`);
}
