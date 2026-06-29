/**
 * Observability metrics — pure functions over recorded outcomes. Land rate,
 * p50/p95 latencies, tip efficiency (tip paid vs. the minimum landed tip that
 * block). All unit-testable; the dashboard reads these over the persisted data.
 */

export function landRate(landed: boolean[]): number {
  return landed.length ? landed.filter(Boolean).length / landed.length : 0;
}

/** Nearest-rank percentile (p in [0,100]). Returns 0 for an empty set. */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  const idx = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[idx]!;
}

/**
 * Tip efficiency = tip paid / minimum landed tip that block. 1.0 = paid exactly
 * the floor; > 1 = overpaid; an unknown floor returns 1.
 */
export function tipEfficiency(paidLamports: number, minLandedTipLamports: number): number {
  return minLandedTipLamports > 0 ? paidLamports / minLandedTipLamports : 1;
}
