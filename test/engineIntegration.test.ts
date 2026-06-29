import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { MarlinEngine, type EngineDeps } from '../src/index.js';
import type { MarlinConfig } from '../src/config.js';
import { deterministicId } from '../src/db/repo.js';
import { lamportsToTip } from '../src/tip/tipLamports.js';
import type { ChatCompleter } from '../src/ai/agent.js';

/**
 * End-to-end integration test for the engine wiring (index.ts), run entirely with
 * in-memory fakes — NO network, NO Postgres, NO live creds. It exercises the real
 * orchestrator + lifecycle tracker + repo recording + doSubmit/awaitOutcome path
 * through one autonomous "retry with fault injection" cycle:
 *
 *   attempt 1: forced blockhash expiry (proven) → ExpiredBlockhash classification
 *   orchestrator: mandatory refresh + AI decision (injected completer)
 *   attempt 2: fresh blockhash → lands → finalized (driven by the RPC reconcile)
 *
 * This proves the integration glue actually works before a single mainnet cred is
 * spent — the layer that, until now, only typechecked.
 */

// A valid 32-byte base58 string (web3.js needs real blockhashes / pubkeys to compile + sign).
const b58 = (): string => Keypair.generate().publicKey.toBase58();

function fakeConfig(payerSecret: string): MarlinConfig {
  return {
    rpcUrl: 'http://fake',
    rpcFallbackUrl: 'http://fake',
    geyserUrl: 'http://fake',
    geyserToken: undefined,
    jitoBlockEngineUrl: 'http://fake',
    payerSecretKey: payerSecret,
    jitoTipFloorUrl: 'http://fake/tip_floor',
    subfloorTipFraction: 0.2,
    databaseUrl: 'postgres://fake',
    openRouterApiKey: 'fake',
    openRouterModel: 'fake-model',
    openRouterBaseUrl: 'http://fake',
    leaderLookaheadSlots: 8,
    maxHoldWindows: 2,
    maxRetries: 3,
    tipHardCapLamports: lamportsToTip(200_000),
    dashboardPort: 8080,
    logLevel: 'silent',
  };
}

interface Rec {
  kind: string;
  row: Record<string, unknown>;
}

test('engine integration: forced expiry → AI retry → finalized (fakes, no network)', async () => {
  const payer = Keypair.generate();
  const cfg = fakeConfig(bs58.encode(payer.secretKey));
  const records: Rec[] = [];
  let bundleSeq = 0;

  // --- fake Connection: blockhash always "expired" relative to its validity window,
  //     and every signature reports finalized (so the retry lands via reconcile). ---
  const fakeConn = {
    getLatestBlockhash: async () => ({ blockhash: b58(), lastValidBlockHeight: 100 }),
    getBlockHeight: async () => 100_000, // >> lastValidBlockHeight → waitUntilExpired proves expiry at once
    getSignatureStatuses: async (sigs: string[]) => ({ value: sigs.map(() => ({ confirmationStatus: 'finalized', slot: 4242 })) }),
    getRecentPrioritizationFees: async () => [{ prioritizationFee: 5_000 }],
  };

  // --- fake SearcherClient: in-window leader, accepts the bundle, returns a uuid. ---
  const fakeSearcher = {
    getTipAccounts: async () => ({ ok: true as const, value: [b58(), b58()] }),
    getNextScheduledLeader: async () => ({ ok: true as const, value: { currentSlot: 1_000, nextLeaderSlot: 1_001, nextLeaderIdentity: 'LEADER' } }),
    sendBundle: async () => ({ ok: true as const, value: `bundle-uuid-${++bundleSeq}` }),
    onBundleResult: () => () => undefined,
  };

  // --- fake Geyser: a stable in-window chain head. `setHandlers` captures the engine's
  //     handlers (the DI seam), and `watchSignature` simulates the PROCESSED tx stream
  //     delivering that signature — exercising onTxUpdate → tracker → 'processed' lifecycle.
  //     confirmed/finalized still come from the RPC reconcile (never from slot numbers). ---
  let geyserHandlers: { onTxUpdate?: (e: { slot: number; raw: unknown }) => void } | undefined;
  const fakeGeyser = {
    start: async () => undefined,
    stop: () => undefined,
    setHandlers: (h: typeof geyserHandlers) => void (geyserHandlers = h),
    currentHead: () => ({ slot: 1_000, status: 'confirmed' }),
    currentBlockFullness: () => 0.4,
    watchSignature: (sig: string) => geyserHandlers?.onTxUpdate?.({ slot: 1_000, raw: { transaction: { signature: bs58.decode(sig) } } }),
  };

  // --- fake Repo: record every write so we can assert the evidence trail. ---
  const fakeRepo = {
    recordSubmission: (r: { idempotencyKey: string }) => {
      const id = deterministicId(`submission:${r.idempotencyKey}`);
      records.push({ kind: 'submission', row: { id, ...r } });
      return id;
    },
    recordAttempt: (r: { submissionId: string; attemptNo: number }) => {
      const id = deterministicId(`attempt:${r.submissionId}#${r.attemptNo}`);
      records.push({ kind: 'attempt', row: { id, ...r } });
      return id;
    },
    attemptIdFor: (submissionId: string, attemptNo: number) => deterministicId(`attempt:${submissionId}#${attemptNo}`),
    recordLifecycle: (r: Record<string, unknown>) => void records.push({ kind: 'lifecycle', row: r }),
    recordFailure: (r: Record<string, unknown>) => void records.push({ kind: 'failure', row: r }),
    recordAgentDecision: (r: Record<string, unknown>) => void records.push({ kind: 'agent', row: r }),
    recordBundleEvent: (r: Record<string, unknown>) => void records.push({ kind: 'bundle_event', row: r }),
    recordTipDecision: (r: Record<string, unknown>) => void records.push({ kind: 'tip', row: r }),
    recoverWal: async () => ({ replayed: 0, remaining: 0, corrupt: 0 }),
    flush: async () => undefined,
    close: async () => undefined,
  };

  // --- fake AI completer: a real, schema-valid decision (refresh + bumped tip). ---
  const fakeCompleter: ChatCompleter = {
    complete: async () => ({
      argumentsJson: JSON.stringify({
        diagnosis: 'blockhash expired',
        actions: { refresh_blockhash: true, new_tip_lamports: 30_000, submit: 'NOW' },
        confidence: 0.9,
        rationale: 'refresh the blockhash and bump the tip toward p75',
      }),
      raw: {},
    }),
  };

  const deps: Partial<EngineDeps> = {
    conn: fakeConn as unknown as EngineDeps['conn'],
    searcher: fakeSearcher as unknown as EngineDeps['searcher'],
    geyser: fakeGeyser as unknown as EngineDeps['geyser'],
    repo: fakeRepo as unknown as EngineDeps['repo'],
    completer: fakeCompleter,
  };

  const tipFloorRow = [
    {
      landed_tips_25th_percentile: 0.00001, // 10_000 lamports → floor
      landed_tips_50th_percentile: 0.00002, // 20_000 → p50 (initial tip)
      landed_tips_75th_percentile: 0.00005,
      landed_tips_95th_percentile: 0.0001,
      landed_tips_99th_percentile: 0.0002, // 200_000 → max
    },
  ];
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({ json: async () => tipFloorRow })) as unknown as typeof fetch;

  try {
    const engine = new MarlinEngine(cfg, deps);
    await engine.start();
    const result = await engine.submitOnce('itest-1', { fault: 'expired-blockhash' });

    // Landed on the SECOND attempt (attempt 1 was the forced expiry).
    assert.equal(result.status, 'finalized');
    if (result.status === 'finalized') assert.equal(result.attempts, 2);

    // Attempt 1 was classified ExpiredBlockhash (drives the mandatory refresh).
    const failures = records.filter((r) => r.kind === 'failure');
    assert.ok(failures.length >= 1, 'expected a recorded failure');
    assert.equal(failures[0]!.row.classification, 'ExpiredBlockhash');

    // The AI made a real, schema-valid decision (not malformed).
    const agent = records.filter((r) => r.kind === 'agent');
    assert.ok(agent.some((a) => a.row.malformed === false), 'expected a valid AI decision recorded');

    // The forced-expiry proof was persisted on the attempt.
    const attempts = records.filter((r) => r.kind === 'attempt');
    assert.ok(attempts.some((a) => a.row.expiryBlockHeight !== undefined), 'expected expiry-block-height proof persisted');

    // The finalized lifecycle stage was recorded for the landed attempt.
    const lifecycles = records.filter((r) => r.kind === 'lifecycle');
    assert.ok(lifecycles.some((l) => l.row.stage === 'finalized'), 'expected a finalized lifecycle event');

    // The PROCESSED stage came from the tx stream (validates the DI handler wiring + onTxUpdate path,
    // not just the RPC reconcile that drives confirmed/finalized).
    assert.ok(lifecycles.some((l) => l.row.stage === 'processed'), 'expected a processed lifecycle event from the tx stream');

    // A tip decision was persisted per attempt (the live distribution + the chosen tip).
    const tips = records.filter((r) => r.kind === 'tip');
    assert.ok(tips.length >= 1, 'expected a recorded tip decision');
    assert.equal(tips[0]!.row.source, 'tip_floor');
    assert.equal(typeof tips[0]!.row.chosenTip, 'number');

    await engine.stop();
  } finally {
    globalThis.fetch = origFetch;
  }
});
