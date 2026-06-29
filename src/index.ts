import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import process from 'node:process';
import express from 'express';
import bs58 from 'bs58';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { loadConfig, type MarlinConfig } from './config.js';
import { logger } from './logger.js';
import { Repo } from './db/repo.js';
import { GeyserIngestor, type TxLifecycleEvent } from './ingest/geyser.js';
import { LifecycleTracker, isFinalized } from './track/lifecycle.js';
import { classifyFailure, type JitoSignal, type Classification } from './track/failures.js';
import { getTipDistribution, type TipDistribution, type TipFloorRow } from './tip/tipOracle.js';
import { type TipLamports } from './tip/tipLamports.js';
import {
  makeSearcherClient,
  buildSelfTransferTx,
  buildBundle,
  sendBundle,
  subscribeBundleResults,
  type SearcherClient,
  type SubmitResult,
} from './exec/bundle.js';
import { getTipAccounts, getNextLeader, shouldSubmitNow, slotsUntilLeader, type NextLeader } from './ingest/leaderSchedule.js';
import { captureBlockhash, waitUntilExpired } from './faultInjection.js';
import { makeOpenRouterCompleter, type AgentResult, type ChatCompleter } from './ai/agent.js';
import { runSubmission, type OrchestratorDeps, type SubmitOutcome, type TipEnvelope, type RunResult } from './exec/orchestrator.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Reject after `ms` if `p` hasn't settled — bounds a network call that might hang. Clears its timer on settle. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), ms);
  });
  return Promise.race([p, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/** Deliberate fault injection for the demo (the "with Fault Injection" half of the AI decision). */
export type FaultMode = 'expired-blockhash';

/** Maps a bundle uuid back to its attempt, so a late `onBundleResult` can persist raw evidence. */
interface AttemptRef {
  submissionId: string;
  attemptNo: number;
  attemptId: string;
}

/**
 * Injectable collaborators. Production builds them from config (the default); the
 * offline integration test passes fakes so the whole engine path — leader window,
 * fault injection, classification, AI retry, lifecycle, persistence — runs without
 * any network. Every field is optional; an omitted one is constructed from config.
 */
export interface EngineDeps {
  conn: Connection;
  searcher: SearcherClient;
  geyser: GeyserIngestor;
  repo: Repo;
  completer: ChatCompleter;
}

/** Load the payer from a base58 secret or a JSON byte-array. */
function loadPayer(secret: string): Keypair {
  const s = secret.trim();
  if (s.startsWith('[')) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(s) as number[]));
  return Keypair.fromSecretKey(bs58.decode(s));
}

/**
 * Wires every layer into one engine. This is integration glue — it needs live
 * creds (SolInfra RPC+Geyser, a funded payer, OpenRouter) to actually run; the
 * pure decision logic underneath is unit-tested.
 *
 * Lifecycle is keyed by the transaction SIGNATURE (what the Geyser tx-stream and
 * RPC `getSignatureStatuses` actually carry); a `signature -> attemptId` map
 * translates every stream/RPC event to a DB attempt id before persisting, so the
 * tracker never writes a row whose foreign key has no parent.
 */
export class MarlinEngine {
  private readonly conn: Connection;
  private readonly searcher: SearcherClient;
  private readonly geyser: GeyserIngestor;
  private readonly repo: Repo;
  private readonly tracker: LifecycleTracker;
  private readonly payer: Keypair;
  private readonly injectedCompleter: ChatCompleter | undefined;
  private lastGoodTip: TipDistribution | undefined;
  private cachedTipAccounts: string[] | undefined; // Jito tip accounts are static — fetch once, reuse (the public block engine rate-limits to 1 req/s)
  private lastNextLeader: NextLeader | undefined;
  private lastLeaderFetchAt = 0;
  private bundleUnsub: (() => void) | undefined;
  private readonly recentOutcomes: { landed: boolean; reason?: string; at: number }[] = [];
  /** Throttle for `getNextScheduledLeader` (the chain head advances locally between fetches). */
  private static readonly LEADER_REFRESH_MS = 2_000;
  private static readonly LEADER_FETCH_TIMEOUT_MS = 3_000;
  /** Per-RPC bound on a reconcile's `getSignatureStatuses` so a hung call can't leak its promise. */
  private static readonly RECONCILE_RPC_TIMEOUT_MS = 4_000;
  /** signature -> attempt id (the DB FK target). Populated before tracking begins. */
  private readonly attemptBySignature = new Map<string, string>();
  /**
   * Signatures the AUTHORITATIVE RPC reconcile has seen on-chain (any commitment). Gates the
   * no-retry `observed` terminal: a stream-only `processed` can be an orphaned fork, so it must
   * NOT suppress a retry — only an RPC-confirmed on-chain presence does (RPC reflects the node's
   * canonical bank, so a tx it reports can still finalize → retrying would risk a double-send).
   */
  private readonly rpcSeenOnChain = new Set<string>();
  /**
   * In-flight RPC reconcile promises. `quiesce()` awaits these (bounded) so their lifecycle
   * writes land BEFORE a strict export flush; once quiesced, a late reconcile must not persist.
   */
  private readonly inflightReconciles = new Set<Promise<void>>();
  /** Signatures with a reconcile currently in flight — collapses the 1.5s-interval duplicates into one RPC. */
  private readonly reconcilingSignatures = new Set<string>();
  private quiesced = false;
  /**
   * bundle uuid -> attempt ref, so a streamed bundle result can persist raw
   * evidence + settle the attempt. Not evicted (a late/duplicate result must
   * still find its attempt); bounded by the run's attempt count. Phase-2: TTL.
   */
  private readonly attemptByBundleUuid = new Map<string, AttemptRef>();
  /** bundle uuid -> waiter that resolves a doSubmit on a terminal Jito result (dropped/rejected). */
  private readonly bundleWaiters = new Map<string, (signal: JitoSignal) => void>();
  /**
   * bundle uuid -> results that arrived BEFORE the attempt/waiter were registered
   * (the result stream can deliver for a uuid in the gap after sendBundle resolves
   * but before doSubmit wires it up). Drained at registration so no evidence is lost
   * and a terminal drop/reject can't silently degrade into a timeout.
   */
  private readonly pendingBundleSignals = new Map<string, JitoSignal[]>();

  constructor(
    private readonly cfg: MarlinConfig,
    deps: Partial<EngineDeps> = {},
  ) {
    this.conn = deps.conn ?? new Connection(cfg.rpcUrl, 'confirmed');
    this.searcher = deps.searcher ?? makeSearcherClient(cfg.jitoBlockEngineUrl);
    this.payer = loadPayer(cfg.payerSecretKey);
    this.repo = deps.repo ?? new Repo({ databaseUrl: cfg.databaseUrl, walPath: './data/wal/marlin-wal.jsonl' });
    this.injectedCompleter = deps.completer;
    this.tracker = new LifecycleTracker({
      onStage: (sig, r) => {
        const attemptId = this.attemptBySignature.get(sig);
        if (!attemptId) return; // no FK target yet — skip rather than write an orphan row
        this.repo.recordLifecycle({ attemptId, stage: r.stage, slot: r.slot, ts: new Date(r.ts).toISOString(), latencyDeltaMs: r.latencyDeltaMs });
      },
    });
    // Tx stream gives the EARLIEST observation (processed_at) precisely; confirmed/finalized
    // are NOT derived from slot numbers (a slot can finalize on a fork that didn't include the
    // tx) — they come only from the authoritative per-signature RPC reconcile.
    const handlers = { onTxUpdate: (e: TxLifecycleEvent) => this.onTxUpdate(e) };
    if (deps.geyser) {
      this.geyser = deps.geyser;
      this.geyser.setHandlers(handlers); // wire the engine's handlers onto an injected ingestor (DI/tests)
    } else {
      this.geyser = new GeyserIngestor({
        endpoint: cfg.geyserUrl,
        token: cfg.geyserToken,
        handlers,
        onReconcileNeeded: (sig) => void this.reconcile(sig),
        onFatal: (err) =>
          logger.error({ err: err.message }, '[engine] Geyser stream fatally rejected (auth/balance) — check GEYSER_TOKEN and the provider balance/credits'),
      });
    }
  }

  async start(): Promise<void> {
    this.quiesced = false; // re-enable reconcile persistence if this engine is restarted after a quiesce()
    await this.geyser.start();
    // Jito bundle results are first-class for accept/drop/reject — subscribe once, globally.
    this.bundleUnsub = subscribeBundleResults(
      this.searcher,
      (id, signal) => this.onBundleSignal(id, signal),
      (err) => logger.error({ err }, '[engine] bundle-result stream error'),
    );
    await this.refreshNextLeader(true).catch((err: unknown) => logger.warn({ err }, '[engine] initial leader fetch failed'));
    await this.repo.recoverWal().catch((err: unknown) => logger.warn({ err }, '[engine] WAL recovery failed'));
    logger.info('[engine] started');
  }

  /**
   * RPC backstop: pull the signature's status and feed the tracker (drives the progression to
   * finalized). Registered in `inflightReconciles` so `quiesce()` can drain it before an export;
   * a reconcile that resolves AFTER quiesce must NOT persist (it would race the strict flush).
   */
  private reconcile(sig: string): Promise<void> {
    if (this.reconcilingSignatures.has(sig)) return Promise.resolve(); // a reconcile for this sig is already running
    this.reconcilingSignatures.add(sig);
    const work = (async (): Promise<void> => {
      try {
        // Bound the RPC: a hung getSignatureStatuses would otherwise never settle, leaking its
        // promise into inflightReconciles and growing the set across a long run.
        const { value } = await withTimeout(this.conn.getSignatureStatuses([sig]), MarlinEngine.RECONCILE_RPC_TIMEOUT_MS);
        const st = value[0];
        if (st?.confirmationStatus && !this.quiesced) {
          this.rpcSeenOnChain.add(sig); // authoritative: this signature is on the node's canonical chain
          this.tracker.observe(sig, st.confirmationStatus as 'processed' | 'confirmed' | 'finalized', st.slot, Date.now());
        }
      } catch (err) {
        logger.debug({ err, sig }, '[engine] reconcile failed');
      }
    })();
    this.inflightReconciles.add(work);
    void work.finally(() => {
      this.inflightReconciles.delete(work);
      this.reconcilingSignatures.delete(sig);
    });
    return work;
  }

  /**
   * Tx stream (PROCESSED commitment) → precise `processed_at`. We record ONLY the
   * `processed` stage here: it's the earliest observation and the tx event carries
   * its own slot. Confirmed/finalized are deliberately NOT inferred from the slot
   * stream — a slot can reach finalized on a fork that did not include this signature,
   * so advancing commitment by slot number alone would falsely "finalize" a tx that
   * never landed. Those stages come only from the authoritative RPC reconcile
   * (`getSignatureStatuses`, which returns the signature's real confirmationStatus).
   */
  private onTxUpdate(e: TxLifecycleEvent): void {
    const sigBytes = e.raw?.transaction?.signature;
    if (!sigBytes) return;
    const sig = bs58.encode(sigBytes);
    if (!this.attemptBySignature.has(sig)) return; // only our watched signatures
    this.tracker.observe(sig, 'processed', e.slot, Date.now());
  }

  /**
   * A streamed bundle result. If the attempt isn't registered yet (the result beat
   * `registerBundle`), buffer it so registration can drain it — otherwise persist the
   * evidence and feed any waiter. An `unknown` kind is an unexpected API shape: logged,
   * never treated as progress.
   */
  private onBundleSignal(bundleId: string, signal: JitoSignal): void {
    if (signal.kind === 'unknown') logger.warn({ bundleId, raw: signal.raw }, '[engine] unrecognized bundle-result shape');
    const ref = this.attemptByBundleUuid.get(bundleId);
    const waiter = this.bundleWaiters.get(bundleId);
    if (!ref && !waiter) {
      const buf = this.pendingBundleSignals.get(bundleId) ?? [];
      buf.push(signal);
      this.pendingBundleSignals.set(bundleId, buf);
      return;
    }
    if (ref) this.persistBundleSignal(ref, bundleId, signal);
    waiter?.(signal);
  }

  /** Append the bundle-result to the history table + snapshot the latest onto the attempt. */
  private persistBundleSignal(ref: AttemptRef, bundleId: string, signal: JitoSignal): void {
    const ts = new Date().toISOString();
    this.repo.recordBundleEvent({
      attemptId: ref.attemptId,
      bundleUuid: bundleId,
      kind: signal.kind,
      droppedReason: signal.droppedReason,
      rejectedReason: signal.rejectedReason,
      raw: signal.raw,
      ts,
    });
    this.repo.recordAttempt({ submissionId: ref.submissionId, attemptNo: ref.attemptNo, bundleUuid: bundleId, rawBundleResult: signal.raw, resultReceivedAt: ts });
  }

  /** Register an attempt for a bundle uuid and drain any results that arrived before it. */
  private registerBundle(bundleId: string, ref: AttemptRef): void {
    this.attemptByBundleUuid.set(bundleId, ref);
    this.repo.recordAttempt({ submissionId: ref.submissionId, attemptNo: ref.attemptNo, bundleUuid: bundleId });
    const pending = this.pendingBundleSignals.get(bundleId);
    if (pending) for (const s of pending) this.persistBundleSignal(ref, bundleId, s); // persist now; the waiter drains for terminal signals
  }

  /** Live tip distribution (tip-floor REST primary, last-good degraded fallback). */
  private async tip(): Promise<TipDistribution> {
    const d = await getTipDistribution({
      fetchTipFloor: async () => {
        const r = await fetch(this.cfg.jitoTipFloorUrl);
        return (await r.json()) as TipFloorRow[];
      },
      recentFees: async () => (await this.conn.getRecentPrioritizationFees()).map((f) => f.prioritizationFee),
      slotFullness: () => this.geyser.currentBlockFullness() ?? 0, // live slot fullness from Geyser blockMeta
      lastGood: this.lastGoodTip,
      now: Date.now(),
    });
    if (d.source === 'tip_floor') this.lastGoodTip = d;
    return d;
  }

  private envelope(d: TipDistribution): TipEnvelope {
    return { floor: d.floor, p50: d.p50, p75: d.p75, max: d.max, congestion: d.congestion };
  }

  private tipBelowFloor(tip: TipLamports): boolean {
    return this.lastGoodTip !== undefined && tip < this.lastGoodTip.floor;
  }

  // --- Jito leader-window targeting -----------------------------------------

  /**
   * Refresh the next-leader cache, throttled to LEADER_REFRESH_MS and bounded by a
   * per-fetch timeout so a hung `getNextScheduledLeader` can never stall a submission
   * (the chain head advances locally from the Geyser stream between fetches).
   */
  private async refreshNextLeader(force = false): Promise<void> {
    const now = Date.now();
    if (!force && now - this.lastLeaderFetchAt < MarlinEngine.LEADER_REFRESH_MS) return;
    this.lastLeaderFetchAt = now;
    const nl = await withTimeout(getNextLeader(this.searcher), MarlinEngine.LEADER_FETCH_TIMEOUT_MS).catch(
      (): { error: string } => ({ error: 'leader fetch timeout' }),
    );
    if (!('error' in nl)) this.lastNextLeader = nl;
  }

  /** Synchronous label for the AI context: is the Jito leader window imminent, later, or unknown? */
  private leaderWindowLabel(): 'imminent' | 'next' | 'unknown' {
    const nl = this.lastNextLeader;
    const head = this.geyser.currentHead();
    if (!nl || !head) return 'unknown';
    const until = slotsUntilLeader(head.slot, nl.nextLeaderSlot);
    if (until < 0) return 'unknown';
    return until <= this.cfg.leaderLookaheadSlots ? 'imminent' : 'next';
  }

  /**
   * Block until the next Jito leader window is within lookahead (so the bundle
   * actually has a leader to land in). Hard-bounded by `maxWaitMs` on EVERY path
   * (including missing telemetry), and the leader fetch is throttled + timed out, so
   * a submission can never hang here and we don't hammer the Block Engine.
   */
  private async waitForLeaderWindow(maxWaitMs = 30_000): Promise<void> {
    const started = Date.now();
    for (;;) {
      await this.refreshNextLeader(); // throttled to LEADER_REFRESH_MS, bounded by a timeout
      const nl = this.lastNextLeader;
      const head = this.geyser.currentHead();
      // In-window → go. The chain head advances from the stream, so re-check cheaply on each tick.
      if (nl && head && shouldSubmitNow(head.slot, nl.nextLeaderSlot, this.cfg.leaderLookaheadSlots)) return;
      if (Date.now() - started > maxWaitMs) return; // bounded — submit anyway rather than hang
      await sleep(400);
    }
  }

  // --- Submission ------------------------------------------------------------

  /**
   * Jito tip accounts (static) fetched ONCE and cached. The public, keyless Jito block engine
   * rate-limits to ~1 request/sec, so re-fetching per submission trips it; we also back off and
   * retry when the engine reports a rate-limit/back-off rather than failing the whole run.
   */
  private async tipAccountsOnce(): Promise<string[]> {
    if (this.cachedTipAccounts && this.cachedTipAccounts.length > 0) return this.cachedTipAccounts;
    let lastErr = 'unknown';
    for (let attempt = 0; attempt < 5; attempt++) {
      const res = await getTipAccounts(this.searcher);
      if (!('error' in res) && res.length > 0) {
        this.cachedTipAccounts = res;
        return res;
      }
      lastErr = 'error' in res ? res.error : 'block engine returned no tip accounts';
      if (/rate limit|exhaust|back-?off/i.test(lastErr) && attempt < 4) {
        await sleep(1300); // honor the engine's ~1s back-off with margin
        continue;
      }
      break;
    }
    throw new Error(`[engine] tip-accounts fetch failed: ${lastErr}`);
  }

  /** Run one submission through the orchestrator. Returns the terminal result. */
  async submitOnce(intentKey: string, opts: { fault?: FaultMode } = {}): Promise<RunResult> {
    const submissionId = this.repo.recordSubmission({ idempotencyKey: intentKey });
    const tipAccounts = await this.tipAccountsOnce();
    const completer = this.injectedCompleter ?? makeOpenRouterCompleter({ apiKey: this.cfg.openRouterApiKey, baseURL: this.cfg.openRouterBaseUrl });

    // The tip distribution that drove the CURRENT attempt's tip. Scoped to THIS submitOnce
    // invocation (a closure local, not engine-global), so concurrent submitOnce calls can't
    // attribute one submission's distribution to another's attempt. getTip → submit is sequential
    // per submission (the orchestrator awaits each), so within a submission this tracks the live attempt.
    let attemptTipDistribution: TipDistribution | undefined;

    const deps: OrchestratorDeps = {
      maxRetries: this.cfg.maxRetries,
      maxHoldWindows: this.cfg.maxHoldWindows,
      tipCap: this.cfg.tipHardCapLamports,
      model: this.cfg.openRouterModel,
      completer,
      getTip: async () => {
        const d = await this.tip();
        attemptTipDistribution = d;
        return this.envelope(d);
      },
      leaderWindow: () => this.leaderWindowLabel(),
      waitForNextWindow: () => this.waitForLeaderWindow(),
      submit: (input) =>
        this.doSubmit({
          submissionId,
          attemptNo: input.attemptNo,
          tip: input.tip,
          refreshBlockhash: input.refreshBlockhash,
          // attempt 1 -> tip account index 0 (Codex MINOR: do not skip index 0).
          tipAccount: tipAccounts[(input.attemptNo - 1) % tipAccounts.length]!,
          fault: opts.fault,
          tipDistribution: attemptTipDistribution,
        }),
      onAgentDecision: (r: AgentResult, attemptNo, clampedTip) =>
        this.repo.recordAgentDecision({
          attemptId: this.repo.attemptIdFor(submissionId, attemptNo),
          output: r.ok ? r.decision : { reason: r.reason },
          clampedTip,
          model: this.cfg.openRouterModel,
          malformed: !r.ok,
          ts: new Date().toISOString(),
        }),
      onFailure: (c, attemptNo) =>
        this.repo.recordFailure({
          attemptId: this.repo.attemptIdFor(submissionId, attemptNo),
          classification: c.class,
          signal: c.signal,
          rawBundleResult: c.rawBundleResult,
          ts: new Date().toISOString(),
        }),
    };
    return runSubmission(deps);
  }

  /** Build + send one bundle attempt and resolve its landed/failed outcome. */
  private async doSubmit(args: {
    submissionId: string;
    attemptNo: number;
    tip: TipLamports;
    tipAccount: string;
    refreshBlockhash: boolean;
    fault?: FaultMode;
    /** The tip distribution that produced `tip` (passed per-attempt to avoid global-state misattribution). */
    tipDistribution?: TipDistribution;
  }): Promise<SubmitOutcome> {
    // Detect + target the Jito leader window before every send.
    await this.waitForLeaderWindow();

    // Fault injection: deliberately let a blockhash expire on the first attempt, so the
    // forced ExpiredBlockhash -> AI-retry path is real and explorer-consistent (not faked).
    // We only treat it as expired once `waitUntilExpired` PROVES it (block height passed the
    // validity window); if it never expires in the window we do NOT fabricate it — we fall
    // back to a normal fresh-blockhash submission.
    let blockhash: string;
    let lastValidBlockHeight: number | undefined;
    let expiryBlockHeight: number | undefined;
    let forcedExpired = false;
    if (args.fault === 'expired-blockhash' && args.attemptNo === 1 && !args.refreshBlockhash) {
      const captured = await captureBlockhash(this.conn);
      const expired = await waitUntilExpired(this.conn, captured);
      if (expired) {
        blockhash = captured.blockhash;
        lastValidBlockHeight = captured.lastValidBlockHeight;
        expiryBlockHeight = await this.conn.getBlockHeight('confirmed'); // proof: this height > lastValidBlockHeight
        forcedExpired = true;
      } else {
        logger.warn('[engine] fault-injection blockhash did not expire within the window — submitting fresh (not faking expiry)');
        const fresh = await this.conn.getLatestBlockhash('confirmed');
        blockhash = fresh.blockhash;
        lastValidBlockHeight = fresh.lastValidBlockHeight;
      }
    } else {
      const fresh = await this.conn.getLatestBlockhash('confirmed');
      blockhash = fresh.blockhash;
      lastValidBlockHeight = fresh.lastValidBlockHeight;
    }

    // Record the attempt row FIRST, so ANY classified return below (build error, send error,
    // forced expiry) already has a parent submission_attempts row for its failure/agent FK.
    const attemptId = this.repo.recordAttempt({
      submissionId: args.submissionId,
      attemptNo: args.attemptNo,
      tipLamports: args.tip,
      blockhash,
      lastValidBlockHeight,
      expiryBlockHeight,
    });

    // Persist the tip decision: the live distribution that drove this attempt's tip + the chosen tip.
    const dist = args.tipDistribution;
    if (dist) {
      this.repo.recordTipDecision({
        attemptId,
        source: dist.source,
        floor: dist.floor,
        p50: dist.p50,
        p75: dist.p75,
        max: dist.max,
        congestion: dist.congestion,
        chosenTip: args.tip,
        ts: new Date().toISOString(),
      });
    }

    // Once the blockhash is PROVEN expired, any build/send failure is an expired-blockhash failure
    // (a plausible live consequence of the stale hash) — classify it so the orchestrator still
    // applies the mandatory deterministic refresh, never a generic BundleFailure.
    const classifyAttemptError = (errMsg: string): Classification =>
      forcedExpired ? classifyFailure({ blockhashExpired: true, rpcError: errMsg }) : { class: 'BundleFailure', signal: errMsg };

    // Build + send inside try/catch: buildBundle returns Error and sendBundle returns { error },
    // but `new PublicKey()` and the gRPC `sendBundle` call can also THROW. A throw must not
    // escape doSubmit — for a proven-expired blockhash it would skip the mandatory refresh and
    // reject the whole submission. Any failure here routes through classifyAttemptError.
    let signature: string | undefined;
    let res!: SubmitResult;
    try {
      const tx = buildSelfTransferTx({ payer: this.payer.publicKey, blockhash });
      const built = buildBundle({ payer: this.payer, tx, tip: args.tip, tipAccount: new PublicKey(args.tipAccount), blockhash });
      if (built instanceof Error) return { landed: false, classification: classifyAttemptError(built.message) };

      signature = bs58.encode(tx.signatures[0] ?? new Uint8Array(64));
      this.attemptBySignature.set(signature, attemptId); // FK target must exist before tracking
      this.repo.recordAttempt({ submissionId: args.submissionId, attemptNo: args.attemptNo, signature }); // upsert the signature
      // Track BEFORE watching: the `submitted` state must exist so a stream event delivered
      // immediately on watch has a lifecycle to attach to (observe() no-ops without it).
      this.tracker.track(signature, Date.now());
      this.geyser.watchSignature(signature);

      res = await sendBundle(this.searcher, built);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { landed: false, signature, classification: classifyAttemptError(msg) };
    }
    if (res.error) return { landed: false, signature, classification: classifyAttemptError(res.error) };
    if (!signature) return { landed: false, classification: classifyAttemptError('missing signature after send') }; // unreachable; narrows the type

    // Register the bundle uuid -> attempt and drain any results that raced ahead of us (MAJOR-1/2).
    if (res.bundleUuid) this.registerBundle(res.bundleUuid, { submissionId: args.submissionId, attemptNo: args.attemptNo, attemptId });

    const slot = this.geyser.currentHead()?.slot;

    // Forced expiry: classify deterministically (block-height proof recorded) without waiting.
    if (forcedExpired) {
      if (res.bundleUuid) this.pendingBundleSignals.delete(res.bundleUuid); // no waiter will drain it
      this.recentOutcomes.push({ landed: false, reason: 'forced expired blockhash', at: Date.now() });
      return { landed: false, signature, slot, bundleUuid: res.bundleUuid, classification: classifyFailure({ blockhashExpired: true }) };
    }

    // Race: finalized (tracker via stream+RPC) vs a terminal Jito result (dropped/rejected) vs timeout.
    const outcome = await this.awaitOutcome(signature, res.bundleUuid, args.tip, 45_000);
    const reason = outcome.observedOnChain
      ? 'observed on-chain (finalization pending)'
      : outcome.streamObservedPendingRpc
        ? 'stream-observed, RPC unconfirmed in window (indeterminate)'
        : outcome.classification?.signal;
    this.recentOutcomes.push({ landed: outcome.landed, reason, at: Date.now() });
    return { ...outcome, signature, slot, bundleUuid: res.bundleUuid };
  }

  /**
   * Resolve an attempt's outcome. Terminal signals:
   *  - the tracker reaches `finalized` (landed) — `processed` is observed from the Geyser tx-stream,
   *    but `confirmed`/`finalized` advance from the authoritative per-signature RPC reconcile (not slot);
   *  - a Jito bundle result is `dropped`/`rejected` (not landed) — classified with the raw evidence;
   *  - the window elapses: `observedOnChain` if the AUTHORITATIVE RPC reconcile saw it (terminal,
   *    not finalized, not retried — it can still finalize); `streamObservedPendingRpc` if only the
   *    tx-stream saw `processed` and RPC never confirmed (indeterminate — no retry, to avoid a
   *    double-send on a possibly-landed tx; not claimed on-chain since it may be a fork); a tx
   *    seen by neither is a retryable BundleFailure.
   */
  private awaitOutcome(signature: string, bundleUuid: string | undefined, tip: TipLamports, timeoutMs: number): Promise<SubmitOutcome> {
    return new Promise((resolveP) => {
      let tick: ReturnType<typeof setInterval> | undefined;
      let settled = false;
      const cleanup = (): void => {
        if (tick) clearInterval(tick);
        if (bundleUuid) this.bundleWaiters.delete(bundleUuid);
      };
      const finish = (o: SubmitOutcome): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolveP(o);
      };

      const onSignal = (signal: JitoSignal): void => {
        if (signal.kind === 'dropped' || signal.kind === 'rejected') {
          finish({ landed: false, classification: classifyFailure({ jito: signal, tipBelowFloor: this.tipBelowFloor(tip) }) });
        }
        // accepted/processed/finalized/unknown are not terminal here — the tracker drives `landed`.
      };

      const started = Date.now();
      // Install the waiter + start the interval BEFORE draining buffered signals, so a buffered
      // terminal signal that calls finish() can actually clear the interval (no leaked timer).
      if (bundleUuid) this.bundleWaiters.set(bundleUuid, onSignal);
      tick = setInterval(() => {
        void this.reconcile(signature); // RPC backstop advances the progression to finalized
        const st = this.tracker.get(signature);
        if (st && isFinalized(st)) {
          finish({ landed: true });
        } else if (Date.now() - started > timeoutMs) {
          // Three-way terminal at timeout, by EVIDENCE STRENGTH:
          //  - RPC-confirmed on-chain → `observed` (no retry; it can still finalize → double-send risk);
          //  - stream saw `processed` but RPC never confirmed → `streamObservedPendingRpc` (indeterminate:
          //    maybe RPC lag on a real tx, maybe a fork — no retry to avoid a double-send, but NOT claimed
          //    on-chain since a stream-only processed can be an orphaned fork);
          //  - never seen anywhere → retryable BundleFailure.
          const rpcSawChain = this.rpcSeenOnChain.has(signature);
          const streamSaw = st !== undefined && st.records.some((r) => r.stage !== 'submitted');
          finish(
            rpcSawChain
              ? { landed: false, observedOnChain: true }
              : streamSaw
                ? { landed: false, streamObservedPendingRpc: true }
                : { landed: false, classification: { class: 'BundleFailure', signal: 'not observed on-chain in window' } },
          );
        }
      }, 1_500);

      // Drain pre-registration buffered signals into the now-installed waiter (may finish() at once).
      if (bundleUuid) {
        const pending = this.pendingBundleSignals.get(bundleUuid);
        if (pending) {
          this.pendingBundleSignals.delete(bundleUuid);
          for (const s of pending) onSignal(s);
        }
      }
    });
  }

  /** Tiny read-only dashboard (in-memory status; the persisted view is in Postgres). */
  dashboard(): express.Express {
    const app = express();
    app.get('/health', (_req, res) => {
      res.json({ ok: true });
    });
    app.get('/', (_req, res) => {
      res.json({ recentOutcomes: this.recentOutcomes.slice(-50) });
    });
    return app;
  }

  /**
   * Stop every event source (Jito bundle-result subscription + Geyser streams) so NO further
   * repo write can be enqueued, THEN drain in-flight RPC reconciles (bounded) so their lifecycle
   * writes land before the export flush. MUST be called before `flushForExport()` for an export:
   * otherwise a late `onBundleResult`/Geyser event or a trailing reconcile could persist AFTER the
   * flush but during the DB read, making the exported report incomplete even though the pre-read
   * flush itself succeeded. After this returns, `quiesced` blocks any straggler reconcile from
   * persisting (defense in depth against an RPC call slower than the drain bound). Terminal for an
   * export run; a subsequent `start()` resets `quiesced` and re-enables reconcile persistence.
   */
  async quiesce(): Promise<void> {
    this.bundleUnsub?.();
    this.bundleUnsub = undefined;
    this.geyser.stop();
    const inflight = [...this.inflightReconciles];
    if (inflight.length) await withTimeout(Promise.allSettled(inflight), 5_000).catch(() => undefined);
    this.quiesced = true;
  }

  /**
   * STRICT flush for evidence export: rethrows if the buffered/WAL-backed writes did not reach
   * Postgres. Call order for an export is `quiesce()` → `flushForExport()` → read → `close()`,
   * so an export can never silently ship an incomplete lifecycle report (no swallowed flush
   * failure, no in-flight event after the flush). (Plain `stop()` stays lenient.)
   */
  async flushForExport(): Promise<void> {
    await this.repo.flush();
  }

  /** Close underlying resources (the DB pool). Call last, after any export read is done. */
  async close(): Promise<void> {
    await this.repo.close();
  }

  async stop(): Promise<void> {
    await this.quiesce();
    await this.repo.flush().catch((err: unknown) => logger.error({ err }, '[engine] flush on shutdown failed'));
    await this.close();
  }
}

// CLI entrypoint: `npm start`
const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const cfg = loadConfig();
  const engine = new MarlinEngine(cfg);
  engine
    .start()
    .then(() => {
      engine.dashboard().listen(cfg.dashboardPort, () => logger.info({ port: cfg.dashboardPort }, '[engine] dashboard up'));
    })
    .catch((err: unknown) => {
      logger.error({ err }, '[engine] failed to start');
      process.exit(1);
    });
}
