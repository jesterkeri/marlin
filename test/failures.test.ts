import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyFailure } from '../src/track/failures.js';

test('ExpiredBlockhash: deterministic block-height', () => {
  assert.equal(classifyFailure({ blockhashExpired: true }).class, 'ExpiredBlockhash');
});

test('ExpiredBlockhash: RPC error text', () => {
  assert.equal(classifyFailure({ rpcError: 'BlockhashNotFound' }).class, 'ExpiredBlockhash');
});

test('ExpiredBlockhash: Jito dropped reason', () => {
  assert.equal(
    classifyFailure({ jito: { kind: 'dropped', droppedReason: 'BlockhashExpired', raw: {} } }).class,
    'ExpiredBlockhash',
  );
});

test('ComputeExceeded: flag and error text', () => {
  assert.equal(classifyFailure({ computeUnitsExceeded: true }).class, 'ComputeExceeded');
  assert.equal(classifyFailure({ rpcError: 'transaction exceeded CUs' }).class, 'ComputeExceeded');
});

test('FeeTooLow: ONLY with tip-below-floor evidence + non-landing', () => {
  assert.equal(
    classifyFailure({ tipBelowFloor: true, jito: { kind: 'dropped', raw: {} } }).class,
    'FeeTooLow',
  );
});

test('narrowed taxonomy → BundleFailure (Codex r2/r3), raw result carried through', () => {
  // unknown rejected
  const r = classifyFailure({ jito: { kind: 'rejected', rejectedReason: 'SimulationFailure', raw: { id: 1 } } });
  assert.equal(r.class, 'BundleFailure');
  assert.deepEqual(r.rawBundleResult, { id: 1 });
  // dropped.NotFinalized / PartiallyProcessed (no expiry, no tip evidence)
  assert.equal(classifyFailure({ jito: { kind: 'dropped', droppedReason: 'NotFinalized', raw: {} } }).class, 'BundleFailure');
  assert.equal(classifyFailure({ jito: { kind: 'dropped', droppedReason: 'PartiallyProcessed', raw: {} } }).class, 'BundleFailure');
  // rejected WITHOUT tip-below-floor evidence is NOT FeeTooLow
  assert.equal(classifyFailure({ jito: { kind: 'rejected', rejectedReason: 'auth', raw: {} } }).class, 'BundleFailure');
});

test('expiry takes priority over tip-below-floor', () => {
  // both signals present → mandatory-safety (expiry) wins
  assert.equal(
    classifyFailure({ blockhashExpired: true, tipBelowFloor: true, jito: { kind: 'dropped', raw: {} } }).class,
    'ExpiredBlockhash',
  );
});
