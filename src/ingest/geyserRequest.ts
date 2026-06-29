import { CommitmentLevel, type SubscribeRequest } from '@triton-one/yellowstone-grpc';

/**
 * Yellowstone 1.3.0 SubscribeRequest builders. The 1.3.0 type requires ALL
 * map/array fields to be present even when empty, so `emptySubscribeRequest`
 * seeds them and the builders fill in only what we use.
 */
export function emptySubscribeRequest(): SubscribeRequest {
  return {
    accounts: {},
    slots: {},
    transactions: {},
    transactionsStatus: {},
    blocks: {},
    blocksMeta: {},
    entry: {},
    accountsDataSlice: [],
  };
}

export interface GeyserSubscribeOpts {
  watchedSignatures: string[];
  commitment?: CommitmentLevel;
}

/**
 * Slots use `filterByCommitment:false` so ONE stream emits every status
 * transition (PROCESSED→CONFIRMED→FINALIZED); the request-level `commitment`
 * gates the transaction subscription only. blocksMeta is enabled for slot
 * fullness → congestion.
 */
export function buildSubscribeRequest(opts: GeyserSubscribeOpts): SubscribeRequest {
  const req = emptySubscribeRequest();
  req.slots = { slots: { filterByCommitment: false } };
  req.blocksMeta = { meta: {} };
  for (const sig of opts.watchedSignatures) {
    req.transactions[`tx-${sig}`] = {
      signature: sig,
      vote: false,
      failed: false,
      accountInclude: [],
      accountExclude: [],
      accountRequired: [],
    };
  }
  req.commitment = opts.commitment ?? CommitmentLevel.CONFIRMED;
  return req;
}

/**
 * Per-commitment slots request — the fallback when the single-stream probe fails.
 * Pass `includeBlocksMeta` on exactly ONE of the three fallback streams so
 * slot-fullness congestion data keeps flowing after fallback.
 */
export function buildPerCommitmentSlotsRequest(commitment: CommitmentLevel, includeBlocksMeta = false): SubscribeRequest {
  const req = emptySubscribeRequest();
  req.slots = { slots: { filterByCommitment: true } };
  if (includeBlocksMeta) req.blocksMeta = { meta: {} };
  req.commitment = commitment;
  return req;
}

/** Slots-only (single-stream, all statuses) + blocksMeta — the slot subscription on its own stream. */
export function buildSlotsRequest(commitment?: CommitmentLevel): SubscribeRequest {
  const req = emptySubscribeRequest();
  req.slots = { slots: { filterByCommitment: false } };
  req.blocksMeta = { meta: {} };
  req.commitment = commitment ?? CommitmentLevel.CONFIRMED;
  return req;
}

/** Transaction-status subscription for a (mutable) set of watched signatures. */
export function buildTxRequest(signatures: string[], commitment?: CommitmentLevel): SubscribeRequest {
  const req = emptySubscribeRequest();
  for (const sig of signatures) {
    req.transactions[`tx-${sig}`] = {
      signature: sig,
      vote: false,
      failed: false,
      accountInclude: [],
      accountExclude: [],
      accountRequired: [],
    };
  }
  req.commitment = commitment ?? CommitmentLevel.CONFIRMED;
  return req;
}

export function commitmentName(c: CommitmentLevel): 'processed' | 'confirmed' | 'finalized' | 'other' {
  switch (c) {
    case CommitmentLevel.PROCESSED:
      return 'processed';
    case CommitmentLevel.CONFIRMED:
      return 'confirmed';
    case CommitmentLevel.FINALIZED:
      return 'finalized';
    default:
      return 'other';
  }
}
