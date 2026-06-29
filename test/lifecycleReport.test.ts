import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assembleReport, renderTable, renderJson, type RawTables } from '../src/report/lifecycleReport.js';

function tables(): RawTables {
  return {
    submissions: [{ id: 'sub-1', idempotencyKey: 'batch-0' }],
    attempts: [
      { id: 'att-1', submissionId: 'sub-1', attemptNo: 1, signature: 'SIG1', tipLamports: 20_000, blockhash: 'BH1', lastValidBlockHeight: 100, expiryBlockHeight: 100_000 },
      { id: 'att-2', submissionId: 'sub-1', attemptNo: 2, signature: 'SIG2', tipLamports: 30_000, blockhash: 'BH2', lastValidBlockHeight: 200, expiryBlockHeight: null },
    ],
    stages: [
      // attempt 2 landed: submitted → processed → confirmed → finalized
      { attemptId: 'att-2', stage: 'submitted', slot: 1000, ts: '2026-06-28T00:00:00.000Z', latencyDeltaMs: null },
      { attemptId: 'att-2', stage: 'processed', slot: 1001, ts: '2026-06-28T00:00:00.400Z', latencyDeltaMs: 400 },
      { attemptId: 'att-2', stage: 'confirmed', slot: 1002, ts: '2026-06-28T00:00:01.200Z', latencyDeltaMs: 800 },
      { attemptId: 'att-2', stage: 'finalized', slot: 1034, ts: '2026-06-28T00:00:14.000Z', latencyDeltaMs: 12_800 },
    ],
    failures: [{ attemptId: 'att-1', classification: 'ExpiredBlockhash', signal: 'past validity window', slot: null }],
    bundleEvents: [{ attemptId: 'att-2', kind: 'finalized', droppedReason: null, rejectedReason: null }],
    tipDecisions: [
      { attemptId: 'att-1', source: 'tip_floor', floorLamports: 10_000, chosenTipLamports: 20_000 }, // 2.0× floor
      { attemptId: 'att-2', source: 'tip_floor', floorLamports: 10_000, chosenTipLamports: 30_000 }, // 3.0× floor
    ],
  };
}

test('assembleReport: nests attempts, classifies landed vs failed, computes deltas', () => {
  const r = assembleReport(tables(), '2026-06-28T01:00:00.000Z');
  assert.equal(r.summary.submissions, 1);
  assert.equal(r.summary.attempts, 2);
  assert.equal(r.summary.landed, 1);
  assert.equal(r.summary.failedAttempts, 1);

  const [a1, a2] = r.submissions[0]!.attempts;
  // attempt 1 = the forced expiry: failed, expiry proof present, no explorer link
  assert.equal(a1!.failure?.classification, 'ExpiredBlockhash');
  assert.equal(a1!.landed, false);
  assert.equal(a1!.explorer, undefined);
  assert.equal(a1!.expiry?.expiryBlockHeight, 100_000);

  // attempt 2 = landed: deltas computed, explorer link present
  assert.equal(a2!.landed, true);
  assert.equal(a2!.deltas.processedToConfirmedMs, 800); // the Q1 metric
  assert.equal(a2!.deltas.confirmedToFinalizedMs, 12_800);
  assert.equal(a2!.explorer, 'https://solscan.io/tx/SIG2');
});

test('assembleReport: attempts are ordered by attemptNo', () => {
  const t = tables();
  t.attempts.reverse(); // feed out of order
  const r = assembleReport(t, 'now');
  assert.deepEqual(
    r.submissions[0]!.attempts.map((a) => a.attemptNo),
    [1, 2],
  );
});

test('renderTable: includes the slots judges cross-reference + the explorer link', () => {
  const table = renderTable(assembleReport(tables(), 'now'));
  assert.match(table, /1034/); // finalized slot
  assert.match(table, /ExpiredBlockhash/);
  assert.match(table, /solscan\.io\/tx\/SIG2/);
});

test('renderJson: round-trips to valid JSON with the summary', () => {
  const parsed = JSON.parse(renderJson(assembleReport(tables(), 'now'))) as { summary: { landed: number } };
  assert.equal(parsed.summary.landed, 1);
});

test('scorecard: land rate, Q1 latency percentiles, and tip efficiency vs floor', () => {
  const sc = assembleReport(tables(), 'now').scorecard;
  // One submission, landed (attempt 2 finalized) → 100% land rate, 2 attempts.
  assert.equal(sc.landRate, 1);
  assert.equal(sc.landedSubmissions, 1);
  assert.equal(sc.avgAttemptsPerSubmission, 2);
  // The forced expiry is counted in the failure-class breakdown.
  assert.equal(sc.failureClassCounts.ExpiredBlockhash, 1);
  // processed→confirmed delta (the Q1 metric) = 800 ms, single sample → p50 = p95 = 800.
  assert.equal(sc.latencyMs.processedToConfirmed.p50, 800);
  assert.equal(sc.latencyMs.processedToConfirmed.n, 1);
  // Tip efficiency = mean(20000/10000, 30000/10000) = mean(2, 3) = 2.5× floor.
  assert.equal(sc.tip.avgEfficiency, 2.5);
  assert.equal(sc.tip.avgFloorLamports, 10_000);
});

test('renderTable: surfaces the scorecard up top', () => {
  const table = renderTable(assembleReport(tables(), 'now'));
  assert.match(table, /## Scorecard/);
  assert.match(table, /Land rate:/);
  assert.match(table, /Tip efficiency:/);
});
