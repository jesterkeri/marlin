import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
// jito-ts re-exports block-engine as namespaces: `searcher` (searcherClient, SearcherClient)
// and `bundle` (the Bundle class).
import { searcher, bundle } from 'jito-ts';
import type { TipLamports } from '../tip/tipLamports.js';
import type { JitoSignal } from '../track/failures.js';

export type SearcherClient = searcher.SearcherClient;
export type JitoBundle = bundle.Bundle;

/**
 * Deterministic bundle construction + submission. No AI in this path. The tip is
 * a `TipLamports` (minted only by the oracle / clampAgentTip), so a hardcoded tip
 * cannot reach `addTipTx`.
 */

/** Build the trivial self-transfer v0 payload (the bounty payload). Pure — testable. */
export function buildSelfTransferTx(opts: {
  payer: PublicKey;
  blockhash: string;
  lamports?: number;
  computeUnitLimit?: number;
  computeUnitPriceMicroLamports?: number;
}): VersionedTransaction {
  const instructions = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: opts.computeUnitLimit ?? 10_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: opts.computeUnitPriceMicroLamports ?? 1 }),
    SystemProgram.transfer({ fromPubkey: opts.payer, toPubkey: opts.payer, lamports: opts.lamports ?? 1 }),
  ];
  const message = new TransactionMessage({
    payerKey: opts.payer,
    recentBlockhash: opts.blockhash,
    instructions,
  }).compileToV0Message();
  return new VersionedTransaction(message);
}

/**
 * Build the Jito bundle = signed payload tx + a tip-transfer to a real Jito tip
 * account. `addTipTx` returns `Bundle | Error` (NOT a Result) — callers must
 * `instanceof Error`-check. web3.js must be deduped to one copy or the keypair/tx
 * will fail `instanceof` inside jito-ts.
 */
export function buildBundle(opts: {
  payer: Keypair;
  tx: VersionedTransaction;
  tip: TipLamports;
  tipAccount: PublicKey;
  blockhash: string;
}): JitoBundle | Error {
  opts.tx.sign([opts.payer]);
  const b = new bundle.Bundle([opts.tx], 5); // mainnet bundle max = 5 incl. tip
  return b.addTipTx(opts.payer, opts.tip, opts.tipAccount, opts.blockhash);
}

export interface SubmitResult {
  bundleUuid?: string;
  error?: string;
}

/** Submit a bundle; unwrap the jito-ts `Result`. Network. */
export async function sendBundle(client: SearcherClient, b: JitoBundle): Promise<SubmitResult> {
  const res = await client.sendBundle(b);
  return res.ok ? { bundleUuid: res.value } : { error: res.error.message };
}

/**
 * Mainnet searcher client — no auth keypair required. jito-ts hands the URL straight to
 * the gRPC channel, whose DNS resolver chokes on an `https://`/`http://` scheme ("Failed
 * to parse DNS address dns:https://…"), so strip the scheme + trailing slash and pass the
 * bare host (gRPC applies TLS on :443 itself).
 */
export function makeSearcherClient(blockEngineUrl: string): SearcherClient {
  let host = blockEngineUrl.trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  if (!/:\d+$/.test(host)) host += ':443'; // grpc-js dns target needs an explicit port
  return searcher.searcherClient(host);
}

/**
 * Structural projection of jito-ts `BundleResult` (a deep gen-path import doesn't
 * resolve under NodeNext, so we type only the shape we read). Exactly one of the
 * oneof fields is set per streamed event.
 */
export interface RawBundleResult {
  bundleId: string;
  accepted?: unknown;
  rejected?:
    | {
        stateAuctionBidRejected?: { msg?: string } | undefined;
        winningBatchBidRejected?: { msg?: string } | undefined;
        simulationFailure?: { msg?: string; txSignature?: string } | undefined;
        internalError?: { msg?: string } | undefined;
        droppedBundle?: { msg?: string } | undefined;
      }
    | undefined;
  finalized?: unknown;
  processed?: unknown;
  dropped?: { reason: number } | undefined;
}

// jito-ts DroppedReason enum (proto): 0 = BlockhashExpired, 1 = PartiallyProcessed, 2 = NotFinalized.
function droppedReasonName(reason: number): JitoSignal['droppedReason'] {
  switch (reason) {
    case 0:
      return 'BlockhashExpired';
    case 1:
      return 'PartiallyProcessed';
    case 2:
      return 'NotFinalized';
    default:
      return undefined;
  }
}

function rejectedReasonText(rej: NonNullable<RawBundleResult['rejected']>): string {
  if (rej.simulationFailure) return `simulationFailure: ${rej.simulationFailure.msg ?? rej.simulationFailure.txSignature ?? 'unknown'}`;
  if (rej.stateAuctionBidRejected) return `stateAuctionBidRejected: ${rej.stateAuctionBidRejected.msg ?? 'bid too low'}`;
  if (rej.winningBatchBidRejected) return `winningBatchBidRejected: ${rej.winningBatchBidRejected.msg ?? 'excluded from winners'}`;
  if (rej.internalError) return `internalError: ${rej.internalError.msg ?? 'unknown'}`;
  if (rej.droppedBundle) return `droppedBundle: ${rej.droppedBundle.msg ?? 'no upcoming leader'}`;
  return 'unknown rejection';
}

/**
 * Map a jito-ts `BundleResult` into the narrowed `JitoSignal` the classifier
 * consumes. Pure — testable. An empty/unrecognized oneof maps to `unknown` (NOT
 * `processed`): an unexpected API shape must never be mistaken for benign
 * progress — the caller logs it.
 */
export function mapBundleResult(r: RawBundleResult): { bundleId: string; signal: JitoSignal } {
  let kind: JitoSignal['kind'] = 'unknown';
  let droppedReason: JitoSignal['droppedReason'];
  let rejectedReason: string | undefined;
  if (r.finalized) kind = 'finalized';
  else if (r.accepted) kind = 'accepted';
  else if (r.processed) kind = 'processed';
  else if (r.dropped) {
    kind = 'dropped';
    droppedReason = droppedReasonName(r.dropped.reason);
  } else if (r.rejected) {
    kind = 'rejected';
    rejectedReason = rejectedReasonText(r.rejected);
  }
  return { bundleId: r.bundleId, signal: { kind, droppedReason, rejectedReason, raw: r } };
}

/**
 * Subscribe to the searcher's bundle-result stream. Jito's `onBundleResult` is
 * first-class/canonical for accept/drop/reject (the Geyser stream is canonical
 * only for commitment progression). Returns an unsubscribe fn.
 */
export function subscribeBundleResults(
  client: SearcherClient,
  onSignal: (bundleId: string, signal: JitoSignal) => void,
  onError: (e: Error) => void,
): () => void {
  return client.onBundleResult((r) => {
    const { bundleId, signal } = mapBundleResult(r as RawBundleResult);
    onSignal(bundleId, signal);
  }, onError);
}
