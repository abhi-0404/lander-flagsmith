import { createHash } from "node:crypto";

/** Canonical JSON: object keys sorted recursively, no whitespace. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

/** SHA-256 of the canonical JSON, hex encoded (safety finding S4). */
export function planHash(plan: unknown): string {
  return createHash("sha256").update(canonicalJson(plan)).digest("hex");
}

/** Characters of the hash a human types to approve. */
export const APPROVAL_PREFIX_LENGTH = 8;
/** Plan directory name and journal reference. */
export const PLAN_ID_LENGTH = 12;

export const approvalPrefix = (hash: string): string => hash.slice(0, APPROVAL_PREFIX_LENGTH);
export const planIdOf = (hash: string): string => hash.slice(0, PLAN_ID_LENGTH);
