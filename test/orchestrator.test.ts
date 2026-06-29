import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lamportsToTip } from '../src/tip/tipLamports.js';
import { runSubmission, type OrchestratorDeps, type TipEnvelope } from '../src/exec/orchestrator.js';
import type { ChatCompleter } from '../src/ai/agent.js';

const env: TipEnvelope = {
  floor: lamportsToTip(10_000),
  p50: lamportsToTip(20_000),
  p75: lamportsToTip(50_000),
  max: lamportsToTip(200_000),
  congestion: 0.3,
};

const completerReturning = (argumentsJson: string | null): ChatCompleter => ({
  complete: async () => ({ argumentsJson, raw: {} }),
});

const decision = (tip: number, submit: 'NOW' | 'HOLD_ONE_WINDOW' = 'NOW'): string =>
  JSON.stringify({ diagnosis: 'd', actions: { refresh_blockhash: true, new_tip_lamports: tip, submit }, confidence: 0.8, rationale: 'r' });

function deps(over: Partial<OrchestratorDeps> = {}): OrchestratorDeps {
  return {
    maxRetries: 3,
    maxHoldWindows: 2,
    tipCap: lamportsToTip(200_000),
    model: 'test',
    completer: completerReturning(decision(30_000)),
    getTip: async () => env,
    submit: async () => ({ landed: true, signature: 'SIG' }),
    ...over,
  };
}

test('lands first attempt → finalized', async () => {
  const r = await runSubmission(deps());
  assert.equal(r.status, 'finalized');
  if (r.status === 'finalized') assert.equal(r.attempts, 1);
});

test('forced expiry → AI retry (refresh + clamped tip 30k) → lands', async () => {
  const seen: { tip: number; refresh: boolean }[] = [];
  let n = 0;
  const r = await runSubmission(
    deps({
      submit: async (i) => {
        n++;
        seen.push({ tip: i.tip, refresh: i.refreshBlockhash });
        return n === 1 ? { landed: false, classification: { class: 'ExpiredBlockhash', signal: 'x' } } : { landed: true, signature: 'S2' };
      },
    }),
  );
  assert.equal(r.status, 'finalized');
  assert.equal(seen[1]!.refresh, true);
  assert.equal(seen[1]!.tip, 30_000);
});

test('AI tip clamped to cap', async () => {
  let last = 0;
  let n = 0;
  await runSubmission(
    deps({
      completer: completerReturning(decision(999_999_999)),
      submit: async (i) => {
        n++;
        last = i.tip;
        return n === 1 ? { landed: false, classification: { class: 'FeeTooLow', signal: 'x' } } : { landed: true };
      },
    }),
  );
  assert.equal(last, 200_000);
});

test('malformed AI → deterministic p50 retry (not garbage), records malformed without a clamped tip', async () => {
  const tips: number[] = [];
  const rec: { ok: boolean; attemptNo: number; clamped: number | undefined }[] = [];
  const r = await runSubmission(
    deps({
      maxRetries: 1,
      completer: completerReturning('not json{'),
      onAgentDecision: (res, attemptNo, clamped) => rec.push({ ok: res.ok, attemptNo, clamped }),
      submit: async (i) => {
        tips.push(i.tip);
        return { landed: false, classification: { class: 'BundleFailure', signal: 'x' } };
      },
    }),
  );
  assert.equal(r.status, 'failed');
  assert.equal(tips[1], 20_000); // oracle p50, NOT an AI-derived value
  assert.equal(rec[0]!.ok, false);
  assert.equal(rec[0]!.attemptNo, 1); // the failing attempt the decision belongs to
  assert.equal(rec[0]!.clamped, undefined); // malformed → no clamped tip
});

test('observedOnChain → terminal status:observed, no retry, no onFailure/AI (prevents double-send)', async () => {
  let onFailureCalled = false;
  let completerCalled = false;
  let submits = 0;
  const r = await runSubmission(
    deps({
      maxRetries: 3,
      completer: {
        complete: async () => {
          completerCalled = true;
          return { argumentsJson: null, raw: {} };
        },
      },
      onFailure: () => {
        onFailureCalled = true;
      },
      submit: async () => {
        submits++;
        return { landed: false, observedOnChain: true, signature: 'SOBS' };
      },
    }),
  );
  assert.equal(r.status, 'observed');
  if (r.status === 'observed') {
    assert.equal(r.attempts, 1); // terminal on the first attempt
    assert.equal(r.signature, 'SOBS');
  }
  assert.equal(submits, 1); // not resubmitted
  assert.equal(onFailureCalled, false); // short-circuits BEFORE onFailure
  assert.equal(completerCalled, false); // AI never consulted
});

test('streamObservedPendingRpc → terminal status:indeterminate, no retry, no onFailure/AI (avoids double-send)', async () => {
  let onFailureCalled = false;
  let completerCalled = false;
  let submits = 0;
  const r = await runSubmission(
    deps({
      maxRetries: 3,
      completer: {
        complete: async () => {
          completerCalled = true;
          return { argumentsJson: null, raw: {} };
        },
      },
      onFailure: () => {
        onFailureCalled = true;
      },
      submit: async () => {
        submits++;
        return { landed: false, streamObservedPendingRpc: true, signature: 'SPEND' };
      },
    }),
  );
  assert.equal(r.status, 'indeterminate');
  if (r.status === 'indeterminate') {
    assert.equal(r.attempts, 1); // terminal on the first attempt
    assert.equal(r.signature, 'SPEND');
  }
  assert.equal(submits, 1); // not resubmitted — a possibly-landed tx must not be double-sent
  assert.equal(onFailureCalled, false); // short-circuits BEFORE onFailure
  assert.equal(completerCalled, false); // AI never consulted
});

test('HOLD bounded by maxHoldWindows', async () => {
  let waits = 0;
  const r = await runSubmission(
    deps({
      maxRetries: 10,
      maxHoldWindows: 1,
      completer: completerReturning(decision(30_000, 'HOLD_ONE_WINDOW')),
      waitForNextWindow: async () => void waits++,
      submit: async () => ({ landed: false, classification: { class: 'BundleFailure', signal: 'x' } }),
    }),
  );
  assert.equal(r.status, 'failed');
  if (r.status === 'failed') assert.equal(r.reason, 'max_holds');
  assert.ok(waits >= 1);
});
