import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTipFloor, getTipDistribution, congestionScore, type TipFloorRow } from '../src/tip/tipOracle.js';

// Real-shape row from the dossier (values are SOL).
const ROW: TipFloorRow = {
  landed_tips_25th_percentile: 6.001e-6,
  landed_tips_50th_percentile: 1e-5,
  landed_tips_75th_percentile: 3.61965e-5,
  landed_tips_95th_percentile: 0.0014479055,
  landed_tips_99th_percentile: 0.010007999,
};

test('parseTipFloor mints SOL→lamports per percentile', () => {
  const d = parseTipFloor([ROW], 0.3, 1000);
  assert.equal(d.floor, 6_001); // round(6.001e-6 * 1e9)
  assert.equal(d.p50, 10_000);
  assert.equal(d.p75, 36_197); // round(3.61965e-5 * 1e9)
  assert.equal(d.max, 10_007_999); // 99th
  assert.equal(d.source, 'tip_floor');
  assert.equal(d.at, 1000);
});

test('parseTipFloor throws on empty response', () => {
  assert.throws(() => parseTipFloor([], 0, 0));
});

test('getTipDistribution: success path', async () => {
  const d = await getTipDistribution({
    fetchTipFloor: async () => [ROW],
    recentFees: async () => [1_000, 2_000, 3_000],
    slotFullness: () => 0.5,
    now: 42,
  });
  assert.equal(d.source, 'tip_floor');
  assert.equal(d.p50, 10_000);
  assert.ok(d.congestion >= 0 && d.congestion <= 1);
});

test('getTipDistribution: degraded fallback caps at p50', async () => {
  const lastGood = parseTipFloor([ROW], 0.2, 1);
  const d = await getTipDistribution({
    fetchTipFloor: async () => {
      throw new Error('network');
    },
    recentFees: async () => [],
    slotFullness: () => 0,
    lastGood,
    now: 99,
  });
  assert.equal(d.source, 'last_good_degraded');
  assert.equal(d.max, lastGood.p50);
  assert.equal(d.at, 99);
});

test('getTipDistribution: fail-closed with no last-good', async () => {
  await assert.rejects(
    getTipDistribution({
      fetchTipFloor: async () => {
        throw new Error('network');
      },
      recentFees: async () => [],
      slotFullness: () => 0,
      now: 0,
    }),
  );
});

test('congestionScore stays in [0,1] and saturates', () => {
  assert.equal(congestionScore([], 0), 0);
  assert.equal(congestionScore([1e9], 1), 1);
  const s = congestionScore([20_000, 40_000], 0.4);
  assert.ok(s >= 0 && s <= 1);
});
