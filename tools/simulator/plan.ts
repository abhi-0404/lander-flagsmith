import { EXPERIMENT_FLAGS, type DemoExperimentFlag } from "../demoFlags.js";

/** mulberry32: tiny deterministic PRNG, returns floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Everything about one simulated visitor that does not depend on which variant the server picks. */
export interface PlannedIdentity {
  flag: string;
  identity: string;
  /** Uniform draw: converts when draw < the rate of the arm the identity landed in. */
  convertDraw: number;
  /** Uniform draw: exposed when draw < the variant exposure rate (variant arm only). */
  exposeDraw: number;
  /** Milliseconds before "now" at which the exposure happens. */
  exposureAgoMs: number;
  /** Delay between exposure and the conversion event. */
  conversionDelayMs: number;
}

export const TWO_DAYS_MS = 48 * 60 * 60 * 1000;
export const DEFAULT_SEED = 20261125;

/**
 * Deterministic traffic plan: same seed, same output. Exposures fall inside the
 * last `spanMs` (default 2 days; events older than 10 days are rejected by Flagsmith).
 * Ordered oldest first, so batches replay in time order.
 */
export function planTraffic(
  seed: number = DEFAULT_SEED,
  opts: { scale?: number; spanMs?: number; flags?: readonly DemoExperimentFlag[] } = {},
): PlannedIdentity[] {
  const scale = opts.scale ?? 1;
  const spanMs = opts.spanMs ?? TWO_DAYS_MS;
  const flags = opts.flags ?? EXPERIMENT_FLAGS;
  const out: PlannedIdentity[] = [];
  flags.forEach((f, flagIndex) => {
    // Independent stream per flag, so changing one flag's size never shifts another's data.
    const rand = mulberry32(seed + flagIndex * 7919);
    const n = Math.max(1, Math.round(f.identities * scale));
    for (let i = 0; i < n; i++) {
      out.push({
        flag: f.name,
        identity: `${f.name}-user-${String(i + 1).padStart(5, "0")}`,
        convertDraw: rand(),
        exposeDraw: rand(),
        exposureAgoMs: Math.floor(rand() * spanMs),
        conversionDelayMs: 60_000 + Math.floor(rand() * 29 * 60_000),
      });
    }
  });
  return out.sort((a, b) => b.exposureAgoMs - a.exposureAgoMs);
}

export interface Decision {
  exposed: boolean;
  converted: boolean;
}

/** Given the arm the server assigned, decide what the simulated visitor does. Pure. */
export function decide(p: PlannedIdentity, flag: DemoExperimentFlag, isVariant: boolean): Decision {
  if (isVariant && p.exposeDraw >= flag.variantExposureRate) {
    // Tracking bug: no exposure, and the visitor's conversion is lost with it.
    return { exposed: false, converted: false };
  }
  const rate = isVariant ? flag.variantRate : flag.controlRate;
  return { exposed: true, converted: p.convertDraw < rate };
}
