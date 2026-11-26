import { assertFlagKey } from "./cli.js";
import type { FlagState } from "../plan/types.js";

/**
 * Flag state read and restore through `flagsmith flag get|update` (docs/cli-facts.md).
 * The `flag get --json` shape is UNVERIFIED (Phase 0 spike), so the normalizer accepts the likely spellings and the journal
 * always keeps the raw response next to the normalized state.
 */

const asObject = (x: unknown): Record<string, unknown> | null =>
  x && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>) : null;

function pickScalar(x: unknown): { value: string | number | boolean | null; type: string | null } {
  const o = asObject(x);
  if (o && "value" in o) {
    const inner = pickScalar(o["value"]);
    const t = typeof o["type"] === "string" ? o["type"] : inner.type;
    return { value: inner.value, type: t };
  }
  if (typeof x === "string") return { value: x, type: "string" };
  if (typeof x === "number") return { value: x, type: Number.isInteger(x) ? "integer" : "float" };
  if (typeof x === "boolean") return { value: x, type: "boolean" };
  return { value: null, type: null };
}

export function normalizeFlagState(raw: unknown): FlagState {
  const first = Array.isArray(raw) ? raw[0] : raw;
  const o = asObject(first) ?? {};
  const nested = asObject(o["feature_state"]) ?? asObject(o["state"]) ?? {};
  const get = (k: string): unknown => (k in o ? o[k] : nested[k]);

  const enabledRaw = get("enabled");
  const enabled = typeof enabledRaw === "boolean" ? enabledRaw : null;

  const valueRaw = ["feature_state_value", "value", "state_value"].map(get).find((v) => v !== undefined);
  const scalar = pickScalar(valueRaw);
  const typeRaw = ["value_type", "type"].map(get).find((v) => typeof v === "string");
  const valueType = scalar.value === null ? null : ((typeof typeRaw === "string" && typeRaw !== "FLAG" ? typeRaw : null) ?? scalar.type);

  const rows = ["multivariate_feature_state_values", "variants", "weights"].map(get).find((v) => Array.isArray(v)) as
    | unknown[]
    | undefined;
  let weights: Record<string, number> | null = null;
  if (rows) {
    weights = {};
    for (const r of rows) {
      const ro = asObject(r);
      if (!ro) continue;
      const id = ro["multivariate_feature_option"] ?? ro["id"] ?? ro["key"];
      const pct = ro["percentage_allocation"] ?? ro["weight"];
      if ((typeof id === "number" || typeof id === "string") && typeof pct === "number") weights[String(id)] = pct;
    }
  }
  return { enabled, value: scalar.value, valueType, weights };
}

/** True when nothing in the state can be restored through `flag update`. */
export const isEmptyFlagState = (s: FlagState): boolean => s.enabled === null && s.value === null && s.weights === null;

/** `flag get` argument list (global flags are added by `flagsmithJson`). */
export const flagGetArgs = (flag: string): string[] => ["flag", "get", assertFlagKey(flag)];

/**
 * `flag update` arguments that put a flag back to `state`. `=` forms keep a value that starts with "-" from being read
 * as an option. Pure, so it is unit-testable. Throws when there is nothing to restore.
 */
export function flagRestoreArgs(flag: string, state: FlagState): string[] {
  if (isEmptyFlagState(state)) throw new Error("the recorded flag state has nothing Lander can restore (empty value, enabled and weights)");
  const args = ["flag", "update", assertFlagKey(flag)];
  if (state.value !== null) {
    args.push(`--value=${String(state.value)}`);
    if (state.valueType && /^(string|integer|boolean)$/.test(state.valueType)) args.push(`--type=${state.valueType}`);
  }
  if (state.enabled === true) args.push("--enable");
  if (state.enabled === false) args.push("--disable");
  for (const [id, pct] of Object.entries(state.weights ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    args.push(`--weight=${id}=${pct}`);
  }
  return args;
}

/** Equality used for the drift checks. */
export function sameFlagState(a: FlagState, b: FlagState): boolean {
  return JSON.stringify(sortState(a)) === JSON.stringify(sortState(b));
}
function sortState(s: FlagState): unknown {
  return {
    enabled: s.enabled,
    value: s.value,
    valueType: s.valueType,
    weights: s.weights ? Object.fromEntries(Object.entries(s.weights).sort(([a], [b]) => a.localeCompare(b))) : null,
  };
}
