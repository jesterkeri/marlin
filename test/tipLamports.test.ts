import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tipFromSol, lamportsToTip, clampAgentTip } from '../src/tip/tipLamports.js';

test('tipFromSol: SOL → lamports (the load-bearing ×1e9)', () => {
  // Dossier fixtures from the live tip-floor feed (values are SOL):
  assert.equal(tipFromSol(5e-5), 50_000); // 0.00005 SOL = 50k lamports
  assert.equal(tipFromSol(1e-5), 10_000); // p50 example
  assert.equal(tipFromSol(0.010007999), 10_007_999); // p99 example
});

test('clampAgentTip: raw LLM output is clamped into [floor, cap]', () => {
  const floor = lamportsToTip(10_000);
  const cap = lamportsToTip(200_000);
  assert.equal(clampAgentTip(50_000, { floor, cap }), 50_000); // in-range passes through
  assert.equal(clampAgentTip(5_000, { floor, cap }), 10_000); // below floor → floor
  assert.equal(clampAgentTip(999_999, { floor, cap }), 200_000); // above cap → cap
  assert.equal(clampAgentTip(Number.NaN, { floor, cap }), 10_000); // garbage → floor
  assert.equal(clampAgentTip(Number.POSITIVE_INFINITY, { floor, cap }), 10_000);
});

test('lamportsToTip: rejects negative / non-finite / non-integer', () => {
  assert.throws(() => lamportsToTip(-1));
  assert.throws(() => lamportsToTip(Number.POSITIVE_INFINITY));
  // rounds fractional lamports rather than throwing (RPC sums can be fractional)
  assert.equal(lamportsToTip(42.4), 42);
});
