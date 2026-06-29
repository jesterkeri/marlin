import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, VersionedTransaction } from '@solana/web3.js';
import { buildSelfTransferTx, buildBundle, mapBundleResult } from '../src/exec/bundle.js';
import { lamportsToTip } from '../src/tip/tipLamports.js';

test('buildSelfTransferTx: v0 self-transfer with compute-budget instructions', () => {
  const payer = Keypair.generate();
  const blockhash = Keypair.generate().publicKey.toBase58(); // valid 32-byte base58
  const tx = buildSelfTransferTx({ payer: payer.publicKey, blockhash });
  assert.ok(tx instanceof VersionedTransaction);
  assert.equal(tx.message.compiledInstructions.length, 3); // CU limit + CU price + transfer
});

test('buildBundle: returns a Bundle (not Error); the deduped web3.js keypair is accepted', () => {
  const payer = Keypair.generate();
  const tipAccount = Keypair.generate().publicKey;
  const blockhash = Keypair.generate().publicKey.toBase58();
  const tx = buildSelfTransferTx({ payer: payer.publicKey, blockhash });
  const bundle = buildBundle({ payer, tx, tip: lamportsToTip(50_000), tipAccount, blockhash });
  assert.ok(!(bundle instanceof Error));
});

test('mapBundleResult: dropped.BlockhashExpired (reason 0) → dropped + droppedReason', () => {
  const { bundleId, signal } = mapBundleResult({ bundleId: 'b1', dropped: { reason: 0 } });
  assert.equal(bundleId, 'b1');
  assert.equal(signal.kind, 'dropped');
  assert.equal(signal.droppedReason, 'BlockhashExpired');
});

test('mapBundleResult: dropped reasons 1/2 map to PartiallyProcessed/NotFinalized', () => {
  assert.equal(mapBundleResult({ bundleId: 'b', dropped: { reason: 1 } }).signal.droppedReason, 'PartiallyProcessed');
  assert.equal(mapBundleResult({ bundleId: 'b', dropped: { reason: 2 } }).signal.droppedReason, 'NotFinalized');
});

test('mapBundleResult: rejected carries a human-readable reason', () => {
  const { signal } = mapBundleResult({ bundleId: 'b2', rejected: { simulationFailure: { msg: 'boom' } } });
  assert.equal(signal.kind, 'rejected');
  assert.match(signal.rejectedReason ?? '', /simulationFailure: boom/);
});

test('mapBundleResult: accepted / processed / finalized kinds', () => {
  assert.equal(mapBundleResult({ bundleId: 'b', accepted: {} }).signal.kind, 'accepted');
  assert.equal(mapBundleResult({ bundleId: 'b', processed: {} }).signal.kind, 'processed');
  assert.equal(mapBundleResult({ bundleId: 'b', finalized: {} }).signal.kind, 'finalized');
});

test('mapBundleResult: raw evidence is carried through for the audit trail', () => {
  const input = { bundleId: 'b3', dropped: { reason: 2 } };
  assert.deepEqual(mapBundleResult(input).signal.raw, input);
});

test('mapBundleResult: empty/unrecognized oneof → unknown (NOT processed)', () => {
  assert.equal(mapBundleResult({ bundleId: 'b4' }).signal.kind, 'unknown');
});
