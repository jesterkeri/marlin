import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyStage,
  isFinalized,
  stageDelta,
  LifecycleTracker,
  type LifecycleState,
  type StageRecord,
} from '../src/track/lifecycle.js';

const empty = (sig = 'S'): LifecycleState => ({ signature: sig, records: [] });

test('applyStage: monotonic progression with latency deltas', () => {
  let s = empty();
  s = applyStage(s, 'submitted', undefined, 1000).state;
  s = applyStage(s, 'processed', 10, 1100).state;
  s = applyStage(s, 'confirmed', 11, 1250).state;
  s = applyStage(s, 'finalized', 20, 1800).state;
  assert.deepEqual(
    s.records.map((r) => [r.stage, r.latencyDeltaMs]),
    [
      ['submitted', undefined],
      ['processed', 100],
      ['confirmed', 150],
      ['finalized', 550],
    ],
  );
  assert.equal(isFinalized(s), true);
  assert.equal(stageDelta(s, 'processed', 'confirmed'), 150);
});

test('applyStage: duplicate and out-of-order events are ignored', () => {
  let s = empty();
  s = applyStage(s, 'submitted', undefined, 1).state;
  s = applyStage(s, 'confirmed', 5, 2).state;
  const dupe = applyStage(s, 'confirmed', 5, 3);
  assert.equal(dupe.record, undefined); // duplicate
  const back = applyStage(s, 'processed', 4, 3);
  assert.equal(back.record, undefined); // out-of-order (processed after confirmed)
});

test('LifecycleTracker: track + observe fire onStage / onFinalized', () => {
  const stages: StageRecord[] = [];
  let finalized = false;
  const t = new LifecycleTracker({ onStage: (_s, r) => stages.push(r), onFinalized: () => void (finalized = true) });
  t.track('SIG', 1000);
  t.observe('SIG', 'processed', 10, 1100);
  t.observe('SIG', 'finalized', 20, 1900);
  assert.deepEqual(stages.map((r) => r.stage), ['submitted', 'processed', 'finalized']);
  assert.equal(finalized, true);
  // observing an untracked signature is a no-op
  t.observe('UNKNOWN', 'processed', 1, 1);
  assert.equal(t.get('UNKNOWN'), undefined);
});
