import type { Connection } from '@solana/web3.js';

/**
 * Deliberate fault injection for the demo: force an expired-blockhash failure.
 *
 * A blockhash is valid for ~150 blocks. We capture one, then (in the orchestrator)
 * submit only after the chain's block height has passed `lastValidBlockHeight` —
 * a real, explorer-consistent expiry, not a fabricated error. The expiry check is
 * block-height based (NOT slot), which is the whole point of §Q2.
 */

export interface CapturedBlockhash {
  blockhash: string;
  lastValidBlockHeight: number;
}

/** Pure: is this blockhash expired given the current BLOCK height (not slot)? */
export function isBlockhashExpired(currentBlockHeight: number, lastValidBlockHeight: number): boolean {
  return currentBlockHeight > lastValidBlockHeight;
}

/** Capture a blockhash to later submit (deliberately) after it has expired. Network. */
export async function captureBlockhash(conn: Connection): Promise<CapturedBlockhash> {
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
  return { blockhash, lastValidBlockHeight };
}

/** Wait until the captured blockhash is provably expired (polls block height). Network. */
export async function waitUntilExpired(conn: Connection, captured: CapturedBlockhash, pollMs = 2_000, maxWaitMs = 120_000): Promise<boolean> {
  const deadline = maxWaitMs;
  let waited = 0;
  for (;;) {
    const height = await conn.getBlockHeight('confirmed');
    if (isBlockhashExpired(height, captured.lastValidBlockHeight)) return true;
    if (waited >= deadline) return false;
    await new Promise((r) => setTimeout(r, pollMs));
    waited += pollMs;
  }
}
