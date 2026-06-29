import type { SearcherClient } from '../exec/bundle.js';

/**
 * Jito leader-window source. The trigger is the Block Engine's own
 * `getNextScheduledLeader()` (NOT `getLeaderSchedule`, which lists all Solana
 * leaders, not the Jito-connected ones). Alignment math is pure + testable; the
 * fetch is network.
 */

export interface NextLeader {
  currentSlot: number;
  nextLeaderSlot: number;
  nextLeaderIdentity: string;
}

/** Slots until the next Jito leader window (negative if it has passed). */
export function slotsUntilLeader(currentSlot: number, nextLeaderSlot: number): number {
  return nextLeaderSlot - currentSlot;
}

/** Submit now iff the next leader window is within `lookaheadSlots` and not yet passed. */
export function shouldSubmitNow(currentSlot: number, nextLeaderSlot: number, lookaheadSlots: number): boolean {
  const until = slotsUntilLeader(currentSlot, nextLeaderSlot);
  return until >= 0 && until <= lookaheadSlots;
}

export async function getNextLeader(searcher: SearcherClient): Promise<NextLeader | { error: string }> {
  const res = await searcher.getNextScheduledLeader();
  if (!res.ok) return { error: res.error.message };
  return {
    currentSlot: res.value.currentSlot,
    nextLeaderSlot: res.value.nextLeaderSlot,
    nextLeaderIdentity: res.value.nextLeaderIdentity,
  };
}

export async function getTipAccounts(searcher: SearcherClient): Promise<string[] | { error: string }> {
  const res = await searcher.getTipAccounts();
  return res.ok ? res.value : { error: res.error.message };
}
