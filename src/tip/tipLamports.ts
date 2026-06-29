import { LAMPORTS_PER_SOL } from '@solana/web3.js';

/**
 * Branded lamports-as-tip type.
 *
 * The ONLY constructors for a `TipLamports` live in this file. Everywhere else,
 * `as TipLamports` is banned by lint (and code review). The point: a chosen/new
 * tip can never be a bare numeric literal — `addTipTx(..., 50000, ...)` or
 * `const t = 50000; addTipTx(..., t)` is a *compile error*, because `addTipTx`
 * accepts only `TipLamports`. This is the primary defense behind the bounty's
 * "no hardcoded tips, ever" requirement; the lint is the backup.
 */
export type TipLamports = number & { readonly __brand: 'TipLamports' };

/** The single internal brand point. Validates the invariant (non-negative integer). */
function brand(n: number): TipLamports {
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
    throw new Error(`[tip] invalid lamports value: ${n}`);
  }
  return n as TipLamports;
}

/**
 * Mint from a SOL float. The Jito tip-floor REST feed reports values in SOL, so
 * this `× LAMPORTS_PER_SOL` (1e9) is the single most consequential unit in the
 * stack — get it wrong and every tip is off by 1e9.
 */
export function tipFromSol(sol: number): TipLamports {
  return brand(Math.round(sol * LAMPORTS_PER_SOL));
}

/** Mint from an integer lamports value (oracle percentile math, RPC fallback, the env cap). */
export function lamportsToTip(lamports: number): TipLamports {
  return brand(Math.round(lamports));
}

/**
 * The ONLY path from raw LLM JSON to an executable tip.
 *
 * The agent returns `new_tip_lamports` as an untyped number in a JSON blob; it
 * is not `TipLamports` and cannot reach `addTipTx` directly. `clampAgentTip`
 * clamps it into the deterministic envelope `[floor, cap]` and mints the brand.
 * Garbage (NaN/Infinity) collapses to the floor — the model can never invent a
 * tip outside the market-derived, hard-capped envelope.
 */
export function clampAgentTip(raw: number, envelope: { floor: TipLamports; cap: TipLamports }): TipLamports {
  const n = Number.isFinite(raw) ? Math.round(raw) : envelope.floor;
  return brand(Math.min(Math.max(n, envelope.floor), envelope.cap));
}

/** Comparison helpers (kept here so callers never unwrap the brand by hand). */
export const minTip = (a: TipLamports, b: TipLamports): TipLamports => (a <= b ? a : b);
export const maxTip = (a: TipLamports, b: TipLamports): TipLamports => (a >= b ? a : b);
