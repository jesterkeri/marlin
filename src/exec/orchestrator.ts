import { clampAgentTip, type TipLamports } from '../tip/tipLamports.js';
import type { Classification } from '../track/failures.js';
import { runAgent, type AgentContext, type AgentResult, type ChatCompleter } from '../ai/agent.js';

/**
 * Per-submission state machine: Deciding → Submitting → Tracking →
 * (Finalized | Retrying → Deciding | Failed), bounded by MAX_RETRIES /
 * MAX_HOLD_WINDOWS.
 *
 * The deterministic/AI split is enforced here: on failure the classifier result
 * drives the MANDATORY safety action (expired → refresh) in code; the AI owns
 * only the discretionary tip/timing. The AI's `new_tip_lamports` reaches an
 * executable tip ONLY through `clampAgentTip` (the sole mint). A malformed/absent
 * AI decision is never dressed up as an "AI retry": it is recorded, the next
 * attempt (if the machine still allows one) is a deterministic safety-only retry
 * at the oracle p50, and only a later valid decision counts as a real AI retry.
 *
 * All effects (submit, tip oracle, the LLM completer, window waits) are injected,
 * so the whole machine is unit-testable offline.
 */

export interface SubmitInput {
  tip: TipLamports;
  refreshBlockhash: boolean;
  attemptNo: number;
}
export interface SubmitOutcome {
  /** Truly finalized on-chain. */
  landed: boolean;
  /**
   * Observed on-chain (processed/confirmed) by the AUTHORITATIVE RPC reconcile but
   * finalization was not seen in the window. Terminal and non-retryable (retrying
   * would double-send a tx that can still finalize) — but NOT reported as finalized.
   */
  observedOnChain?: boolean;
  /**
   * The tx-stream saw `processed` but the RPC reconcile never confirmed it within the
   * window. Genuinely indeterminate: it may have landed (RPC merely lagged) or forked
   * away. Terminal and non-retryable — retrying a possibly-landed tx risks a double-send
   * once a later attempt refreshes the blockhash — and honestly NOT claimed as on-chain.
   */
  streamObservedPendingRpc?: boolean;
  classification?: Classification;
  bundleUuid?: string;
  signature?: string;
  slot?: number;
}

export interface TipEnvelope {
  floor: TipLamports;
  p50: TipLamports;
  p75: TipLamports;
  max: TipLamports;
  congestion: number;
}

export interface OrchestratorDeps {
  maxRetries: number;
  maxHoldWindows: number;
  tipCap: TipLamports;
  model: string;
  completer: ChatCompleter;
  submit: (input: SubmitInput) => Promise<SubmitOutcome>;
  getTip: () => Promise<TipEnvelope>;
  leaderWindow?: () => 'imminent' | 'next' | 'unknown';
  waitForNextWindow?: () => Promise<void>;
  onAgentDecision?: (r: AgentResult, attemptNo: number, clampedTip?: TipLamports) => void;
  onFailure?: (c: Classification, attemptNo: number) => void;
}

export type RunResult =
  | { status: 'finalized'; attempts: number; signature?: string }
  | { status: 'observed'; attempts: number; signature?: string } // RPC-confirmed on-chain, finalization not seen in-window; not retried
  | { status: 'indeterminate'; attempts: number; signature?: string } // stream saw processed, RPC never confirmed; not retried (avoid double-send)
  | { status: 'failed'; attempts: number; reason: string };

function buildAgentContext(
  c: Classification,
  env: TipEnvelope,
  attemptNo: number,
  maxRetries: number,
  leaderWindow: 'imminent' | 'next' | 'unknown',
  slot: number,
): AgentContext {
  return {
    classification: c.class,
    slot,
    tip: { floor: env.floor, p50: env.p50, p75: env.p75, max: env.max, congestion: env.congestion },
    leaderWindow,
    attemptNo,
    maxRetries,
  };
}

export async function runSubmission(deps: OrchestratorDeps): Promise<RunResult> {
  const leaderWindow = deps.leaderWindow ?? ((): 'unknown' => 'unknown');
  let attemptNo = 0;
  let holds = 0;
  let refresh = false;
  const first = await deps.getTip();
  let tip: TipLamports = first.p50; // initial tip = oracle p50 (branded — never a literal)

  for (;;) {
    attemptNo++;
    const outcome = await deps.submit({ tip, refreshBlockhash: refresh, attemptNo });
    if (outcome.landed) return { status: 'finalized', attempts: attemptNo, signature: outcome.signature };
    // RPC-confirmed on-chain but not finalized in-window: terminal, do NOT retry (would double-send).
    if (outcome.observedOnChain) return { status: 'observed', attempts: attemptNo, signature: outcome.signature };
    // Stream saw processed but RPC never confirmed: indeterminate, do NOT retry (a possibly-landed
    // tx + a later blockhash-refreshed retry could double-send) and do NOT claim it landed.
    if (outcome.streamObservedPendingRpc) return { status: 'indeterminate', attempts: attemptNo, signature: outcome.signature };

    const cls = outcome.classification;
    if (!cls) return { status: 'failed', attempts: attemptNo, reason: 'unclassified_failure' };
    deps.onFailure?.(cls, attemptNo);

    if (attemptNo > deps.maxRetries) return { status: 'failed', attempts: attemptNo, reason: 'max_retries' };

    // Mandatory safety (deterministic, NOT AI): an expired blockhash is always refreshed.
    refresh = cls.class === 'ExpiredBlockhash';

    // Discretionary AI decision.
    const env = await deps.getTip();
    const ctx = buildAgentContext(cls, env, attemptNo, deps.maxRetries, leaderWindow(), outcome.slot ?? 0);
    const result = await runAgent(deps.completer, deps.model, ctx);

    if (!result.ok) {
      // Malformed-AI policy: record it, do NOT resubmit as an "AI retry". The next attempt is a
      // deterministic safety-only retry at the oracle p50 (mandatory refresh already set above).
      deps.onAgentDecision?.(result, attemptNo);
      tip = env.p50;
      continue;
    }

    // Valid decision: clamp the tip (the ONLY mint path), combine mandatory ∨ AI refresh, apply timing.
    const clamped = clampAgentTip(result.decision.actions.new_tip_lamports, { floor: env.floor, cap: deps.tipCap });
    deps.onAgentDecision?.(result, attemptNo, clamped);
    tip = clamped;
    refresh = refresh || result.decision.actions.refresh_blockhash;

    if (result.decision.actions.submit === 'HOLD_ONE_WINDOW') {
      holds++;
      if (holds > deps.maxHoldWindows) return { status: 'failed', attempts: attemptNo, reason: 'max_holds' };
      await (deps.waitForNextWindow?.() ?? Promise.resolve());
    }
  }
}
