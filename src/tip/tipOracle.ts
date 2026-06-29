import { tipFromSol, type TipLamports } from './tipLamports.js';

/**
 * Dynamic tip oracle. NO hardcoded tip values — every field is minted from live
 * data through the `tipLamports` helpers (which is the only place lamports
 * become `TipLamports`).
 *
 * Phase-1 live source: the Jito tip-floor REST feed (landed-tip percentiles, in
 * SOL). Degraded fallback: reuse the last-good distribution with the agent
 * capped at p50. The on-chain tip-account inflow reconstruction is Phase 2.
 *
 * All effectful inputs (fetch, recent fees, slot fullness, clock) are injected,
 * so the whole module is unit-testable offline.
 */

export interface TipDistribution {
  floor: TipLamports;
  p50: TipLamports;
  p75: TipLamports;
  max: TipLamports;
  /** 0..1 heuristic congestion signal handed to the agent (never a tip multiplier). */
  congestion: number;
  source: 'tip_floor' | 'last_good_degraded';
  /** Unix ms, injected (not read from the clock here — keeps the module pure). */
  at: number;
}

/** One row of `GET /api/v1/bundles/tip_floor` (array of one). Values are in SOL. */
export interface TipFloorRow {
  landed_tips_25th_percentile: number;
  landed_tips_50th_percentile: number;
  landed_tips_75th_percentile: number;
  landed_tips_95th_percentile: number;
  landed_tips_99th_percentile: number;
  ema_landed_tips_50th_percentile?: number;
}

const clamp01 = (n: number): number => Math.min(Math.max(n, 0), 1);

/**
 * Heuristic congestion in [0,1] from recent prioritization fees (micro-lamports
 * per CU) and slot fullness (0..1). Uncalibrated, so it only ever informs the
 * agent — it is never used to amplify a tip above the oracle envelope.
 */
export function congestionScore(recentFeesMicroLamports: number[], slotFullness: number): number {
  const fees = recentFeesMicroLamports.filter((f) => Number.isFinite(f) && f >= 0).sort((a, b) => a - b);
  const median = fees.length ? fees[Math.floor(fees.length / 2)]! : 0;
  // Reference scale: ~50k micro-lamports/CU is already heavy priority demand.
  const FEE_REFERENCE_MICROLAMPORTS = 50_000;
  const feeSignal = clamp01(median / FEE_REFERENCE_MICROLAMPORTS);
  return clamp01(0.5 * clamp01(slotFullness) + 0.5 * feeSignal);
}

/** Build the live distribution from a tip-floor response. */
export function parseTipFloor(rows: TipFloorRow[], congestion: number, at: number): TipDistribution {
  const r = rows[0];
  if (!r) throw new Error('[tipOracle] empty tip_floor response');
  return {
    floor: tipFromSol(r.landed_tips_25th_percentile),
    p50: tipFromSol(r.landed_tips_50th_percentile),
    p75: tipFromSol(r.landed_tips_75th_percentile),
    max: tipFromSol(r.landed_tips_99th_percentile),
    congestion: clamp01(congestion),
    source: 'tip_floor',
    at,
  };
}

/** Degraded mode: reuse last-good, cap the agent at p50, retag + restamp. */
export function degradedFrom(lastGood: TipDistribution, at: number): TipDistribution {
  return { ...lastGood, max: lastGood.p50, source: 'last_good_degraded', at };
}

export interface TipOracleDeps {
  fetchTipFloor: () => Promise<TipFloorRow[]>;
  recentFees: () => Promise<number[]>;
  slotFullness: () => number;
  lastGood?: TipDistribution | undefined;
  now: number;
}

/**
 * Get the current tip distribution, falling back to last-good (degraded) if the
 * tip-floor feed is unreachable. Throws only when there is no feed AND no
 * last-good distribution (fail-closed — never invent a tip).
 */
export async function getTipDistribution(deps: TipOracleDeps): Promise<TipDistribution> {
  try {
    const rows = await deps.fetchTipFloor();
    const fees = await deps.recentFees().catch(() => [] as number[]);
    return parseTipFloor(rows, congestionScore(fees, deps.slotFullness()), deps.now);
  } catch (err) {
    if (deps.lastGood) return degradedFrom(deps.lastGood, deps.now);
    throw new Error(`[tipOracle] tip_floor unavailable and no last-good distribution: ${(err as Error).message}`);
  }
}
