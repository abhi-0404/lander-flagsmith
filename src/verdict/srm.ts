// Chi-square sample ratio mismatch (SRM) check from per-arm exposure counts. No dependencies.
// Flagsmith returns payload.srm_p_value = null even with 1,530 exposures (Phase 0 fact), so we compute it ourselves.

/** ln(Gamma(x)) by the Lanczos approximation (g = 7, n = 9), accurate to about 1e-15 for x > 0. */
function lnGamma(x: number): number {
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
    12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ] as const;
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lnGamma(1 - x);
  const xm = x - 1;
  let a: number = c[0];
  const t = xm + 7.5;
  for (let i = 1; i < 9; i++) a += (c[i] as number) / (xm + i);
  return 0.5 * Math.log(2 * Math.PI) + (xm + 0.5) * Math.log(t) - t + Math.log(a);
}

/** Regularized upper incomplete gamma Q(a, x) (series for x < a + 1, continued fraction otherwise). */
function gammaQ(a: number, x: number): number {
  if (x <= 0) return 1;
  const gln = lnGamma(a);
  if (x < a + 1) {
    let ap = a;
    let sum = 1 / a;
    let del = sum;
    for (let n = 0; n < 500; n++) {
      ap += 1;
      del *= x / ap;
      sum += del;
      if (Math.abs(del) < Math.abs(sum) * 1e-15) break;
    }
    return 1 - sum * Math.exp(-x + a * Math.log(x) - gln);
  }
  const tiny = 1e-300;
  let b = x + 1 - a;
  let c = 1 / tiny;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i < 500; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < tiny) d = tiny;
    c = b + an / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-15) break;
  }
  return Math.exp(-x + a * Math.log(x) - gln) * h;
}

/** P(X >= stat) for a chi-square distribution with df degrees of freedom. */
export function chiSquarePValue(stat: number, df: number): number {
  if (df <= 0) return 1;
  return Math.min(1, Math.max(0, gammaQ(df / 2, stat / 2)));
}

export interface SrmArm {
  key: string;
  observed: number;
  expected: number;
  observedShare: number;
  expectedShare: number;
}

export interface SrmResult {
  chiSquare: number;
  df: number;
  pValue: number;
  total: number;
  arms: SrmArm[];
}

/**
 * Goodness of fit of observed exposure counts to the allocation weights (equal split when none given).
 * Returns null when there is nothing to test (fewer than two arms or no exposures).
 */
export function srmCheck(observed: Record<string, number>, weights?: Record<string, number>): SrmResult | null {
  const keys = Object.keys(observed);
  if (keys.length < 2) return null;
  const total = keys.reduce((s, k) => s + (observed[k] as number), 0);
  if (total <= 0) return null;
  let w = keys.map((k) => weights?.[k] ?? 0);
  if (!weights || w.some((x) => !(x > 0))) w = keys.map(() => 1);
  const wsum = w.reduce((s, x) => s + x, 0);
  let chi = 0;
  const arms: SrmArm[] = keys.map((key, i) => {
    const expectedShare = (w[i] as number) / wsum;
    const expected = total * expectedShare;
    const o = observed[key] as number;
    chi += (o - expected) ** 2 / expected;
    return { key, observed: o, expected, observedShare: o / total, expectedShare };
  });
  const df = keys.length - 1;
  return { chiSquare: chi, df, pValue: chiSquarePValue(chi, df), total, arms };
}
