/**
 * Deterministic failure classification.
 *
 * Dual-canonical: the Geyser stream is canonical for *commitment progression*,
 * but Jito's `onBundleResult` is first-class and canonical for *bundle
 * acceptance/drop*. This module fuses both into one of four classes.
 *
 * The narrowing Codex required: `rejected`/`dropped` does NOT automatically mean
 * `FeeTooLow` — it can be a malformed bundle, bad tx, invalid tip account, auth
 * issue, or sim failure. We classify `FeeTooLow` ONLY when there is explicit
 * tip-below-live-floor evidence; everything else falls through to
 * `BundleFailure` with the raw Jito result persisted for audit.
 */

export type FailureClass = 'ExpiredBlockhash' | 'FeeTooLow' | 'ComputeExceeded' | 'BundleFailure';

/** A narrowed projection of jito-ts `BundleResult` (the part we classify on). */
export interface JitoSignal {
  /** `unknown` = no recognized oneof field (an unexpected API shape — never treated as progress). */
  kind: 'accepted' | 'rejected' | 'processed' | 'finalized' | 'dropped' | 'unknown';
  /** Present when kind === 'dropped'. */
  droppedReason?: 'BlockhashExpired' | 'PartiallyProcessed' | 'NotFinalized';
  /** Raw rejected reason/category when kind === 'rejected' (free-form). */
  rejectedReason?: string;
  /** The raw onBundleResult JSON — persisted on failure for the audit trail. */
  raw: unknown;
}

export interface ClassifyInput {
  /** Deterministic block-height expiry: currentBlockHeight > lastValidBlockHeight. */
  blockhashExpired?: boolean;
  /** Raw RPC / simulation error text, if any (e.g. "BlockhashNotFound"). */
  rpcError?: string;
  /** CU limit hit in simulation or landing. */
  computeUnitsExceeded?: boolean;
  /** First-class Jito bundle-result signal. */
  jito?: JitoSignal;
  /** The only thing that justifies FeeTooLow: chosen tip < live floor at submit. */
  tipBelowFloor?: boolean;
}

export interface Classification {
  class: FailureClass;
  signal: string;
  /** Raw Jito result, carried through so the failure is auditable (Codex r2). */
  rawBundleResult?: unknown;
}

const EXPIRY_RE = /blockhash\s*not\s*found|block\s*height\s*exceeded|blockhashnotfound|expired/i;
const COMPUTE_RE = /compute|exceeded.*(units|cus)|computebudget|insufficient compute/i;

/**
 * Priority order matters: a mandatory-safety failure (expiry, compute) is
 * identified first because the orchestrator applies a deterministic fix for it;
 * the discretionary classes come after.
 */
export function classifyFailure(input: ClassifyInput): Classification {
  const raw = input.jito?.raw;

  // 1. Expired blockhash — deterministic (block-height), RPC error, or Jito drop reason.
  if (
    input.blockhashExpired ||
    (input.rpcError && EXPIRY_RE.test(input.rpcError)) ||
    input.jito?.droppedReason === 'BlockhashExpired'
  ) {
    return { class: 'ExpiredBlockhash', signal: 'blockhash past 150-block validity window', rawBundleResult: raw };
  }

  // 2. Compute exceeded — deterministic or from the error text.
  if (input.computeUnitsExceeded || (input.rpcError && COMPUTE_RE.test(input.rpcError))) {
    return { class: 'ComputeExceeded', signal: 'compute-unit limit hit', rawBundleResult: raw };
  }

  // 3. FeeTooLow — ONLY with tip-below-floor evidence AND a non-landing Jito outcome.
  if (input.tipBelowFloor && (input.jito?.kind === 'dropped' || input.jito?.kind === 'rejected')) {
    return { class: 'FeeTooLow', signal: 'tip below live floor; bundle not selected', rawBundleResult: raw };
  }

  // 4. Everything else (unknown rejected, dropped.NotFinalized/PartiallyProcessed, leader skip, ...).
  const why =
    input.jito?.kind === 'dropped'
      ? `bundle dropped: ${input.jito.droppedReason ?? 'unknown'}`
      : input.jito?.kind === 'rejected'
        ? `bundle rejected: ${input.jito.rejectedReason ?? 'unknown'}`
        : (input.rpcError ?? 'bundle did not land');
  return { class: 'BundleFailure', signal: why, rawBundleResult: raw };
}
