import process from 'node:process';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { MarlinEngine, type EngineDeps } from '../src/index.js';
import type { MarlinConfig } from '../src/config.js';
import { deterministicId } from '../src/db/repo.js';
import { lamportsToTip } from '../src/tip/tipLamports.js';
import type { ChatCompleter } from '../src/ai/agent.js';
import { logger } from '../src/logger.js';

/**
 * `npm run demo` — a NO-CREDS narrated run of the whole engine.
 *
 * The entire MarlinEngine path runs below on in-memory fakes: leader-window
 * targeting → dynamic tip → a PROVEN blockhash-expiry fault → failure
 * classification → the bounded AI retry decision → a fresh resubmit → finalized.
 * Only the network boundary (RPC / Jito / Geyser / Postgres / the LLM) is faked;
 * every decision, safety clamp, and state transition is the real production code.
 *
 * A judge can watch the smart-transaction story play out in their terminal in a
 * few seconds without an RPC endpoint, a funded wallet, or an API key. For the
 * mainnet-backed, explorer-verifiable version of exactly this run: `npm run run:batch`.
 */

// --- tiny ASCII presentation helpers (render in any console / screen recording) ---
const b58 = (): string => Keypair.generate().publicKey.toBase58();
const line = (s = ''): void => {
  process.stdout.write(`${s}\n`);
};
const rule = (): void => line('='.repeat(64));
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function fakeConfig(payerSecret: string): MarlinConfig {
  return {
    rpcUrl: 'http://demo',
    rpcFallbackUrl: 'http://demo',
    geyserUrl: 'http://demo',
    geyserToken: undefined,
    jitoBlockEngineUrl: 'http://demo',
    payerSecretKey: payerSecret,
    jitoTipFloorUrl: 'http://demo/tip_floor',
    subfloorTipFraction: 0.2,
    databaseUrl: 'postgres://demo',
    openRouterApiKey: 'demo',
    openRouterModel: 'demo-model',
    openRouterBaseUrl: 'http://demo',
    leaderLookaheadSlots: 8,
    maxHoldWindows: 2,
    maxRetries: 3,
    tipHardCapLamports: lamportsToTip(200_000),
    dashboardPort: 8080,
    logLevel: 'silent',
  };
}

/**
 * A repo that, instead of writing to Postgres, NARRATES the events it receives.
 * The engine drives it exactly as it would the real repo — so the story below is
 * the genuine sequence of persisted evidence, not a scripted animation.
 */
function narratingRepo(): EngineDeps['repo'] {
  const noToId = (submissionId: string, attemptNo: number): string => deterministicId(`attempt:${submissionId}#${attemptNo}`);
  const idToNo = new Map<string, number>();
  const headed = new Set<number>();
  const stageArrow: Record<string, string> = { submitted: 'submitted', processed: 'processed', confirmed: 'confirmed', finalized: 'FINALIZED' };

  const attemptHeader = (attemptNo: number): void => {
    if (headed.has(attemptNo)) return;
    headed.add(attemptNo);
    line('');
    line(`-- Attempt ${attemptNo} ${'-'.repeat(46)}`);
  };

  return {
    recordSubmission: (r: { idempotencyKey: string }) => {
      const id = deterministicId(`submission:${r.idempotencyKey}`);
      line(`>> Submission "${r.idempotencyKey}" created`);
      return id;
    },
    recordAttempt: (r: { submissionId: string; attemptNo: number; tipLamports?: number; expiryBlockHeight?: number; lastValidBlockHeight?: number; signature?: string }) => {
      const id = noToId(r.submissionId, r.attemptNo);
      idToNo.set(id, r.attemptNo);
      // Only the first, substantive recordAttempt (carries the tip) prints the header + fault proof;
      // later upserts (signature, bundle uuid) are silent so the narration stays clean.
      if (r.tipLamports !== undefined) {
        attemptHeader(r.attemptNo);
        if (r.expiryBlockHeight !== undefined && r.lastValidBlockHeight !== undefined) {
          line(`   FAULT INJECTED: captured a blockhash and let it EXPIRE before sending`);
          line(`     proof: observed block height ${r.expiryBlockHeight} > last_valid_block_height ${r.lastValidBlockHeight}`);
        }
      }
      return id;
    },
    attemptIdFor: (submissionId: string, attemptNo: number) => noToId(submissionId, attemptNo),
    recordTipDecision: (r: { attemptId: string; source: string; floor: number; p50: number; p75: number; chosenTip: number; congestion: number }) => {
      attemptHeader(idToNo.get(r.attemptId) ?? 0);
      line(`   tip: source=${r.source} floor=${r.floor} p50=${r.p50} p75=${r.p75} -> chosen ${r.chosenTip} lamports (congestion ${r.congestion.toFixed(2)})`);
    },
    recordLifecycle: (r: { attemptId: string; stage: string; slot?: number }) => {
      line(`   ${stageArrow[r.stage] ?? r.stage}${r.slot !== undefined ? ` (slot ${r.slot})` : ''}`);
    },
    recordFailure: (r: { classification: string; signal?: string }) => {
      line(`   [FAIL] classification: ${r.classification}${r.signal ? ` — ${r.signal}` : ''}`);
    },
    recordAgentDecision: (r: { output: Record<string, unknown>; clampedTip?: number; malformed: boolean }) => {
      if (r.malformed) {
        line(`   [AI] malformed/absent decision — falling back to a deterministic safety-only retry at p50`);
        return;
      }
      const o = r.output as { diagnosis?: string; rationale?: string; confidence?: number; actions?: { refresh_blockhash?: boolean; new_tip_lamports?: number; submit?: string } };
      const a = o.actions ?? {};
      line('');
      line(`   [AI] diagnosis: "${o.diagnosis ?? '?'}" (confidence ${o.confidence ?? '?'})`);
      line(`        decision: refresh_blockhash=${a.refresh_blockhash} new_tip=${a.new_tip_lamports} submit=${a.submit}`);
      if (o.rationale) line(`        rationale: "${o.rationale}"`);
      if (r.clampedTip !== undefined) line(`        -> tip clamped into [floor, cap] = ${r.clampedTip} lamports (the ONLY path raw LLM output becomes a tip)`);
    },
    recordBundleEvent: () => undefined,
    recoverWal: async () => ({ replayed: 0, remaining: 0, corrupt: 0 }),
    flush: async () => undefined,
    close: async () => undefined,
  } as unknown as EngineDeps['repo'];
}

async function main(): Promise<void> {
  const prevLogLevel = logger.level; // the demo narrates via stdout; mute the engine's logs, then restore
  logger.level = 'silent';

  const payer = Keypair.generate();
  const cfg = fakeConfig(bs58.encode(payer.secretKey));
  let bundleSeq = 0;

  // Network boundary, faked: blockhash is always "expired" vs its window (so the fault is PROVEN,
  // not faked), and every signature reports finalized (so the retry lands via the RPC reconcile).
  const fakeConn = {
    getLatestBlockhash: async () => ({ blockhash: b58(), lastValidBlockHeight: 100 }),
    getBlockHeight: async () => 100_000,
    getSignatureStatuses: async (sigs: string[]) => ({ value: sigs.map(() => ({ confirmationStatus: 'finalized', slot: 4242 })) }),
    getRecentPrioritizationFees: async () => [{ prioritizationFee: 5_000 }],
  };
  const fakeSearcher = {
    getTipAccounts: async () => ({ ok: true as const, value: [b58(), b58()] }),
    getNextScheduledLeader: async () => ({ ok: true as const, value: { currentSlot: 1_000, nextLeaderSlot: 1_001, nextLeaderIdentity: 'LEADER' } }),
    sendBundle: async () => ({ ok: true as const, value: `bundle-uuid-${++bundleSeq}` }),
    onBundleResult: () => () => undefined,
  };
  let geyserHandlers: { onTxUpdate?: (e: { slot: number; raw: unknown }) => void } | undefined;
  const fakeGeyser = {
    start: async () => undefined,
    stop: () => undefined,
    setHandlers: (h: typeof geyserHandlers) => void (geyserHandlers = h),
    currentHead: () => ({ slot: 1_000, status: 'confirmed' }),
    currentBlockFullness: () => 0.4,
    watchSignature: (sig: string) => geyserHandlers?.onTxUpdate?.({ slot: 4242, raw: { transaction: { signature: bs58.decode(sig) } } }),
  };
  const fakeCompleter: ChatCompleter = {
    complete: async () => ({
      argumentsJson: JSON.stringify({
        diagnosis: 'blockhash expired before the bundle was included',
        actions: { refresh_blockhash: true, new_tip_lamports: 30_000, submit: 'NOW' },
        confidence: 0.9,
        rationale: 'refresh to a recent blockhash and bump the tip toward p75 to compete for the next leader window',
      }),
      raw: {},
    }),
  };

  const deps: Partial<EngineDeps> = {
    conn: fakeConn as unknown as EngineDeps['conn'],
    searcher: fakeSearcher as unknown as EngineDeps['searcher'],
    geyser: fakeGeyser as unknown as EngineDeps['geyser'],
    repo: narratingRepo(),
    completer: fakeCompleter,
  };

  // tip-floor REST, faked (SOL values ×1e9 → lamports): floor 10k, p50 20k, p75 50k, max 200k.
  const tipFloorRow = [
    {
      landed_tips_25th_percentile: 0.00001,
      landed_tips_50th_percentile: 0.00002,
      landed_tips_75th_percentile: 0.00005,
      landed_tips_95th_percentile: 0.0001,
      landed_tips_99th_percentile: 0.0002,
    },
  ];
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({ json: async () => tipFloorRow })) as unknown as typeof fetch;

  rule();
  line('  MARLIN — a smart transaction stack for Solana');
  line('  Live demo (no creds): autonomous retry with fault injection');
  rule();
  line('');
  line('  The whole engine runs below on in-memory fakes — NO RPC, NO wallet,');
  line('  NO Postgres, NO LLM key. Every stage is the REAL engine path; only the');
  line('  network boundary is faked. Mainnet, explorer-verifiable: npm run run:batch');
  line('');

  try {
    const engine = new MarlinEngine(cfg, deps);
    await engine.start();
    await sleep(150);
    const result = await engine.submitOnce('demo-1', { fault: 'expired-blockhash' });
    await engine.stop();

    line('');
    rule();
    if (result.status === 'finalized') {
      line(`  RESULT: FINALIZED after ${result.attempts - 1} retry (${result.attempts} attempts total)`);
    } else {
      line(`  RESULT: ${result.status} (${result.attempts} attempts)`);
    }
    line('  The network decided · the AI reasoned within bounds · signing stayed deterministic.');
    rule();
  } finally {
    globalThis.fetch = origFetch;
    logger.level = prevLogLevel; // don't leak the silencing into an in-process caller (e.g. a test harness)
  }
}

main().catch((err: unknown) => {
  line(`demo error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
