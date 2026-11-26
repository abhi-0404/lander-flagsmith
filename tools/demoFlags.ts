/**
 * The demo flags, shared by seed.ts and simulate.ts and kept in step with
 * lander-demo-shop/src/flagKeys.ts. Variant values equal variant keys so the demo
 * shop can branch on `variant === "<key>"`.
 */

export interface DemoExperimentFlag {
  /** Flag name, also the experiment name prefix. */
  name: string;
  /** Value served for the control arm (the flag's default value). */
  controlValue: string;
  /** Variant key and value. Control is the remainder of the weights. */
  variantKey: string;
  /** Percentage allocation of the variant (control gets the rest). */
  variantWeight: number;
  hypothesis: string;
  /** Simulator: identities, conversion rates per arm. */
  identities: number;
  controlRate: number;
  variantRate: number;
  /** Simulator: fraction of variant identities that are exposed (SRM scenario only). */
  variantExposureRate: number;
  scenario: "ship" | "keep-running" | "srm";
}

export const METRIC = {
  name: "checkout_completed",
  aggregation: "occurrence",
  direction: "up",
  event: "checkout_completed",
} as const;

export const EXPERIMENT_FLAGS: readonly DemoExperimentFlag[] = [
  {
    name: "checkout_cta",
    controlValue: "copy-invite",
    variantKey: "get-everyones-times",
    variantWeight: 50,
    hypothesis: "A call to action that asks for everyone's times converts more checkouts.",
    identities: 1500,
    controlRate: 0.1,
    variantRate: 0.14,
    variantExposureRate: 1,
    scenario: "ship",
  },
  {
    name: "pricing_banner",
    controlValue: "no-banner",
    variantKey: "savings-banner",
    variantWeight: 50,
    hypothesis: "A savings banner on the pricing page lifts checkouts.",
    identities: 400,
    controlRate: 0.1,
    variantRate: 0.115,
    variantExposureRate: 1,
    scenario: "keep-running",
  },
  {
    name: "signup_steps",
    controlValue: "three-step",
    variantKey: "one-step",
    variantWeight: 50,
    hypothesis: "A one step signup form finishes more signups than the three step form.",
    identities: 1000,
    controlRate: 0.1,
    variantRate: 0.12,
    // A tracking bug drops 40 percent of variant users: a 50/50 test shows about 62/38.
    variantExposureRate: 0.6,
    scenario: "srm",
  },
];

/** The kill switch: a standard flag with no experiment, which Lander must leave alone. */
export const KILL_SWITCH = {
  name: "maintenance_mode",
  description: "Kill switch. No experiment. Lander must report it as not managed by Lander.",
} as const;

export type EnvName = "staging" | "production";

export function parseEnvName(value: string | undefined): EnvName {
  if (value === "staging" || value === "production") return value;
  throw new Error(`--env must be staging or production, got ${JSON.stringify(value)}`);
}
