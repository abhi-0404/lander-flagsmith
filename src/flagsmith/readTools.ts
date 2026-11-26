/**
 * ALLOWLIST of Flagsmith MCP tools the model may see (safety finding S1).
 * This is an allowlist of names, never a denylist: a new tool on the server stays hidden.
 * test/safety.test.ts asserts the model's tool list equals this list exactly.
 */
export const READ_TOOL_ALLOWLIST = [
  "get_experiment",
  "get_experiment_exposures",
  "get_experiment_results",
  "get_feature_code_references",
  "get_feature_evaluation_data",
  "get_feature_lifecycle_counts",
  "list_experiments",
  "list_feature_multivariate_options",
  "list_project_environments",
  "list_projects_in_organization",
] as const;

export type ReadToolName = (typeof READ_TOOL_ALLOWLIST)[number];

export function isAllowedReadTool(name: string): name is ReadToolName {
  return (READ_TOOL_ALLOWLIST as readonly string[]).includes(name);
}
