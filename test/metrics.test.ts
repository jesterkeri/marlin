import { test } from 'node:test';
import assert from 'node:assert/strict';
import { landRate, percentile, tipEfficiency } from '../src/obs/metrics.js';

test('landRate', () => {
  assert.equal(landRate([]), 0);
  assert.equal(landRate([true, true, false, true]), 0.75);
});

test('percentile (nearest-rank)', () => {
  assert.equal(percentile([], 50), 0);
  assert.equal(percentile([10, 20, 30, 40], 50), 20);
  assert.equal(percentile([10, 20, 30, 40], 95), 40);
  assert.equal(percentile([5], 50), 5);
});

test('tipEfficiency', () => {
  assert.equal(tipEfficiency(10_000, 10_000), 1);
  assert.equal(tipEfficiency(20_000, 10_000), 2);
  assert.equal(tipEfficiency(10_000, 0), 1); // unknown floor
});
