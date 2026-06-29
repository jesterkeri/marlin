import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CommitmentLevel } from '@triton-one/yellowstone-grpc';
import { buildSubscribeRequest, buildSlotsRequest, buildTxRequest, buildPerCommitmentSlotsRequest, commitmentName } from '../src/ingest/geyserRequest.js';
import { GeyserIngestor, blockFullnessFrom, FULL_BLOCK_TX_REFERENCE, isNonRetryableGrpcError } from '../src/ingest/geyser.js';
import {
  SlotDeduper,
  LatestWins,
  BoundedLifecycleQueue,
  commitmentProbe,
  reorgDegraded,
  type SlotUpdate,
} from '../src/ingest/slotDedupe.js';

test('buildSubscribeRequest: slots filterByCommitment=false, all maps present', () => {
  const req = buildSubscribeRequest({ watchedSignatures: ['SIG1'] });
  assert.equal(req.slots['slots']?.filterByCommitment, false);
  for (const k of ['accounts', 'transactionsStatus', 'blocks', 'entry'] as const) {
    assert.deepEqual((req as unknown as Record<string, unknown>)[k], {});
  }
  assert.ok(req.blocksMeta['meta']); // blockMeta stream enabled
  assert.equal(req.commitment, CommitmentLevel.CONFIRMED);
  const f = req.transactions['tx-SIG1']!;
  assert.equal(f.signature, 'SIG1');
  assert.deepEqual([f.accountInclude, f.accountExclude, f.accountRequired], [[], [], []]);
});

test('commitmentName maps the enum', () => {
  assert.equal(commitmentName(CommitmentLevel.PROCESSED), 'processed');
  assert.equal(commitmentName(CommitmentLevel.CONFIRMED), 'confirmed');
  assert.equal(commitmentName(CommitmentLevel.FINALIZED), 'finalized');
  assert.equal(commitmentName(CommitmentLevel.DEAD), 'other');
});

test('SlotDeduper: exact dupe dropped; status-advance + fork kept', () => {
  const d = new SlotDeduper();
  const base: SlotUpdate = { slot: 100, parent: 99, status: 'processed' };
  assert.equal(d.accept(base), true);
  assert.equal(d.accept({ ...base }), false); // exact (slot,parent,status) dupe
  assert.equal(d.accept({ ...base, status: 'confirmed' }), true); // same slot advances status
  assert.equal(d.accept({ ...base, status: 'finalized' }), true);
  assert.equal(d.accept({ slot: 100, parent: 88, status: 'processed' }), true); // fork: different parent
});

test('SlotDeduper: parent-absent falls back to (slot,status) + reorgDegraded', () => {
  const d = new SlotDeduper();
  const u: SlotUpdate = { slot: 5, status: 'processed' };
  assert.equal(reorgDegraded(u), true);
  assert.equal(d.accept(u), true);
  assert.equal(d.accept({ slot: 5, status: 'processed' }), false);
});

test('LatestWins keeps only the newest', () => {
  const lw = new LatestWins<number>();
  lw.set(1);
  lw.set(2);
  lw.set(3);
  assert.equal(lw.get(), 3);
});

test('BoundedLifecycleQueue: degraded past soft cap, hard cap sheds oldest', () => {
  let degradedAt = 0;
  let shedCount = 0;
  const q = new BoundedLifecycleQueue<number>({
    softCap: 2,
    hardCap: 4,
    onDegraded: (n) => void (degradedAt = n),
    onShed: (n) => void (shedCount = n),
  });
  q.push(1);
  q.push(2);
  assert.equal(q.degraded, false);
  q.push(3); // > softCap → degraded
  assert.equal(q.degraded, true);
  assert.equal(degradedAt, 3);
  q.push(4); // == hardCap, no shed
  assert.equal(q.size, 4);
  q.push(5); // > hardCap → shed oldest (1)
  assert.equal(q.size, 4);
  assert.equal(q.shed, 1);
  assert.equal(shedCount, 1);
  assert.deepEqual(q.drain(), [2, 3, 4, 5]); // 1 was shed (recovered via RPC reconcile)
  assert.equal(q.degraded, false);
});

test('buildSlotsRequest: slots-only (filterByCommitment=false) + blocksMeta, no tx', () => {
  const req = buildSlotsRequest();
  assert.equal(req.slots['slots']?.filterByCommitment, false);
  assert.ok(req.blocksMeta['meta']);
  assert.deepEqual(req.transactions, {});
});

test('buildTxRequest: tx filters for the signature set, slots empty', () => {
  const req = buildTxRequest(['A', 'B']);
  assert.deepEqual(req.slots, {});
  assert.equal(req.transactions['tx-A']?.signature, 'A');
  assert.equal(req.transactions['tx-B']?.signature, 'B');
});

test('buildPerCommitmentSlotsRequest: filterByCommitment=true; blocksMeta only when requested', () => {
  const a = buildPerCommitmentSlotsRequest(CommitmentLevel.CONFIRMED);
  assert.equal(a.slots['slots']?.filterByCommitment, true);
  assert.equal(a.commitment, CommitmentLevel.CONFIRMED);
  assert.deepEqual(a.blocksMeta, {}); // no congestion stream by default
  const b = buildPerCommitmentSlotsRequest(CommitmentLevel.CONFIRMED, true);
  assert.ok(b.blocksMeta['meta']); // congestion preserved on the one stream that opts in
});

test('commitmentProbe ok only with confirmed + finalized', () => {
  assert.equal(commitmentProbe(['processed']).ok, false);
  assert.equal(commitmentProbe(['processed', 'confirmed']).ok, false);
  assert.equal(commitmentProbe(['processed', 'confirmed', 'finalized']).ok, true);
});

test('watchSignature: a throwing reconcile hook is isolated (backstop never disrupts the watch)', () => {
  // Constructing the ingestor opens no network; watchSignature only updates the set + reconcile hook.
  let called = 0;
  const g = new GeyserIngestor({
    endpoint: 'http://localhost:1',
    onReconcileNeeded: () => {
      called++;
      throw new Error('boom');
    },
  });
  assert.doesNotThrow(() => g.watchSignature('SIG'));
  assert.equal(called, 1);
  assert.doesNotThrow(() => g.watchSignature('SIG')); // already-watched path also reconciles, still isolated
  assert.equal(called, 2);
});

test('isNonRetryableGrpcError: auth/balance codes stop the ingestor; transient codes retry', () => {
  assert.equal(isNonRetryableGrpcError({ code: 7 }), true); // PERMISSION_DENIED (incl. "insufficient balance")
  assert.equal(isNonRetryableGrpcError({ code: 16 }), true); // UNAUTHENTICATED
  assert.equal(isNonRetryableGrpcError({ code: 14 }), false); // UNAVAILABLE — retryable
  assert.equal(isNonRetryableGrpcError({ code: 1 }), false); // CANCELLED — retryable
  assert.equal(isNonRetryableGrpcError(new Error('boom')), false); // no code → retryable
  assert.equal(isNonRetryableGrpcError(undefined), false);
  assert.equal(isNonRetryableGrpcError(null), false);
});

test('blockFullnessFrom: clamps executed-tx count to 0..1 against the reference', () => {
  assert.equal(blockFullnessFrom('0'), 0);
  assert.equal(blockFullnessFrom(String(FULL_BLOCK_TX_REFERENCE / 2)), 0.5);
  assert.equal(blockFullnessFrom(String(FULL_BLOCK_TX_REFERENCE)), 1);
  assert.equal(blockFullnessFrom(String(FULL_BLOCK_TX_REFERENCE * 3)), 1); // clamped
  assert.equal(blockFullnessFrom('not-a-number'), 0); // safe fallback
  assert.equal(blockFullnessFrom('-5'), 0);
});
