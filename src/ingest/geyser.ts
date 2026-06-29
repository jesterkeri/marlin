import GeyserPkg, { CommitmentLevel, type SubscribeUpdate } from '@triton-one/yellowstone-grpc';
import {
  buildSlotsRequest,
  buildTxRequest,
  buildPerCommitmentSlotsRequest,
  emptySubscribeRequest,
  commitmentName,
} from './geyserRequest.js';
import { SlotDeduper, LatestWins, BoundedLifecycleQueue, type SlotUpdate } from './slotDedupe.js';
import { logger } from '../logger.js';

/**
 * Heuristic reference for a "full" block's executed-transaction count, used only
 * to derive a 0..1 slot-fullness congestion signal (advisory — fed to the agent,
 * never a tip multiplier; the "no hardcoded tip" rule is about tips, not this).
 */
export const FULL_BLOCK_TX_REFERENCE = 2_500;

/** Pure: map a block's executed-transaction count to a clamped 0..1 fullness. Testable. */
export function blockFullnessFrom(executedTransactionCount: string, reference = FULL_BLOCK_TX_REFERENCE): number {
  const n = Number(executedTransactionCount);
  if (!Number.isFinite(n) || n < 0 || reference <= 0) return 0;
  return Math.min(1, n / reference);
}

/**
 * Pure: is this gRPC error one that reconnecting can NEVER fix? 7 = PERMISSION_DENIED,
 * 16 = UNAUTHENTICATED (a SolInfra "insufficient balance" rejection arrives as 7). Such
 * errors must stop the ingestor instead of looping the reconnect forever. Testable.
 */
export function isNonRetryableGrpcError(err: unknown): boolean {
  const code = (err as { code?: number } | null | undefined)?.code;
  return code === 7 || code === 16;
}

// The package is CJS (`exports.default = Client`); under NodeNext an ESM default
// import binds the whole module namespace, so the class itself is `.default`.
const Client = GeyserPkg.default;
type ClientInstance = InstanceType<typeof Client>;
type Stream = Awaited<ReturnType<ClientInstance['subscribe']>>;

export interface ChainHead {
  slot: number;
  status: string;
}
export interface TxLifecycleEvent {
  slot: number;
  raw: SubscribeUpdate['transaction'];
}
export interface GeyserHandlers {
  onChainHead?: (h: ChainHead) => void;
  onTxUpdate?: (e: TxLifecycleEvent) => void;
}
export interface GeyserOpts {
  endpoint: string;
  token?: string | undefined;
  watchedSignatures?: string[];
  handlers?: GeyserHandlers;
  /** How long to wait for CONFIRMED+FINALIZED before falling back (default 12s). */
  probeWindowMs?: number;
  /** Called when a signature is newly watched — kick an RPC getSignatureStatuses reconcile to cover the pre-rewrite window. */
  onReconcileNeeded?: (sig: string) => void;
  /** Called on a NON-retryable stream rejection (auth/balance) — reconnecting can't fix it, so we stop and surface it. */
  onFatal?: (err: Error) => void;
}

/**
 * Live Geyser ingestor. Slot and tx subscriptions are on separate streams:
 *  - Slots start single-stream (`filterByCommitment:false`); a runtime probe
 *    checks that CONFIRMED+FINALIZED actually arrive within `probeWindowMs`, and
 *    if not it falls back to three per-commitment slot streams (Codex r3 fix).
 *  - The tx subscription tracks a MUTABLE signature set: `watchSignature()` adds
 *    a signature and re-writes the request, minimizing the miss window; an RPC
 *    reconciliation backstop (`onReconcileNeeded`) covers any early misses.
 *
 * Backpressure is two-lane: chain head = latest-value-wins; watched-tx lifecycle
 * = a hard-bounded queue (sheds oldest past the hard cap; RPC reconcile recovers).
 */
export class GeyserIngestor {
  private client: ClientInstance | undefined;
  private slotStreams: Stream[] = [];
  private txStream: Stream | undefined;
  private stopped = false;
  private reconnecting = false;
  private backoffMs = 500;
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private probeTimer: ReturnType<typeof setTimeout> | undefined;
  private pingId = 0;
  private mode: 'single' | 'perCommitment' = 'single';
  private fallbackTried = false;
  private readonly watched = new Set<string>();
  private readonly deduper = new SlotDeduper();
  private readonly head = new LatestWins<ChainHead>();
  private readonly lifecycle = new BoundedLifecycleQueue<TxLifecycleEvent>({
    softCap: 10_000,
    hardCap: 50_000,
    onDegraded: (n) => logger.warn({ size: n }, '[geyser] lifecycle degraded — RPC reconciliation should backstop'),
    onShed: (n) => logger.error({ shed: n }, '[geyser] lifecycle SHEDDING oldest — RPC reconciliation required'),
  });
  private readonly seenStatuses = new Set<string>(); // lifetime telemetry
  private probeStatuses = new Set<string>(); // statuses since the CURRENT slot-stream connection opened
  private blockFullnessValue: number | undefined; // latest 0..1 slot fullness from blockMeta (congestion signal)

  /** Event callbacks. Settable post-construction so an injected ingestor (tests/DI) can receive the engine's handlers. */
  private handlers: GeyserHandlers | undefined;

  constructor(private readonly opts: GeyserOpts) {
    for (const s of opts.watchedSignatures ?? []) this.watched.add(s);
    this.handlers = opts.handlers;
  }

  /** Register/replace the event handlers (used by the engine to wire an injected ingestor). */
  setHandlers(handlers: GeyserHandlers): void {
    this.handlers = handlers;
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    this.teardownStreams();
  }

  currentHead(): ChainHead | undefined {
    return this.head.get();
  }
  /** Latest 0..1 slot fullness from blockMeta (undefined until the first block arrives). */
  currentBlockFullness(): number | undefined {
    return this.blockFullnessValue;
  }
  drainLifecycle(): TxLifecycleEvent[] {
    return this.lifecycle.drain();
  }
  /** Whether the CURRENT slot-stream connection has yielded confirmed + finalized. */
  commitmentProbeOk(): boolean {
    return this.probeStatuses.has('confirmed') && this.probeStatuses.has('finalized');
  }

  /**
   * Watch a signature (ideally called at/before signing, so the subscription is
   * in place before the tx can land). The stream is PRIMARY, but a tx that lands
   * between this rewrite and the server applying it can be missed — so we also
   * fire `onReconcileNeeded` to trigger an RPC getSignatureStatuses backstop for
   * the early window. ("Never misses" is only true with that reconcile.)
   */
  watchSignature(sig: string): void {
    if (this.watched.has(sig)) {
      this.safeReconcile(sig);
      return;
    }
    this.watched.add(sig);
    try {
      this.txStream?.write(buildTxRequest([...this.watched], CommitmentLevel.PROCESSED));
    } catch {
      /* reconnect will re-write with the current set */
    }
    this.safeReconcile(sig);
  }

  /** The reconcile hook is a backstop — never let it throw into the watch/submission path. */
  private safeReconcile(sig: string): void {
    try {
      this.opts.onReconcileNeeded?.(sig);
    } catch (err) {
      logger.warn({ err, sig }, '[geyser] onReconcileNeeded hook threw (ignored)');
    }
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    this.reconnecting = false;
    this.probeStatuses = new Set(); // fallback decision only considers THIS connection's statuses
    try {
      this.client = new Client(this.opts.endpoint, this.opts.token, undefined);
      await this.openSlotSubscription();
      await this.openTxSubscription();
      this.startPing();
      this.startProbe();
      this.backoffMs = 500;
      logger.info({ mode: this.mode }, '[geyser] subscribed');
    } catch (err) {
      logger.error({ err }, '[geyser] connect failed');
      this.scheduleReconnect();
    }
  }

  private async openSlotSubscription(): Promise<void> {
    if (!this.client) return;
    if (this.mode === 'single') {
      const s = await this.client.subscribe();
      this.wire(s);
      s.write(buildSlotsRequest());
      this.slotStreams = [s];
    } else {
      const streams: Stream[] = [];
      for (const lvl of [CommitmentLevel.PROCESSED, CommitmentLevel.CONFIRMED, CommitmentLevel.FINALIZED]) {
        const s = await this.client.subscribe();
        this.wire(s);
        // blocksMeta on exactly one stream so slot-fullness congestion survives fallback.
        s.write(buildPerCommitmentSlotsRequest(lvl, lvl === CommitmentLevel.CONFIRMED));
        streams.push(s);
      }
      this.slotStreams = streams;
    }
  }

  private async openTxSubscription(): Promise<void> {
    if (!this.client) return;
    const s = await this.client.subscribe();
    this.wire(s);
    // PROCESSED commitment → the tx stream delivers the EARLIEST stage (processed_at) precisely.
    // confirmed/finalized are NOT derived here — they come from the engine's authoritative
    // per-signature RPC reconcile (getSignatureStatuses), never from slot numbers.
    s.write(buildTxRequest([...this.watched], CommitmentLevel.PROCESSED));
    this.txStream = s;
  }

  private wire(stream: Stream): void {
    stream.on('data', (u: SubscribeUpdate) => this.onUpdate(u));
    stream.on('error', (err: unknown) => {
      if (isNonRetryableGrpcError(err)) {
        this.fatal(err); // auth/balance — stop, surface, do NOT loop reconnect
        return;
      }
      logger.error({ err }, '[geyser] stream error');
      this.scheduleReconnect();
    });
    stream.on('end', () => {
      logger.warn('[geyser] stream ended');
      this.scheduleReconnect();
    });
  }

  private onUpdate(u: SubscribeUpdate): void {
    if (u.pong) return;
    if (u.ping) {
      this.writePing();
      return;
    }
    if (u.slot) {
      const upd: SlotUpdate = {
        slot: Number(u.slot.slot),
        parent: u.slot.parent !== undefined ? Number(u.slot.parent) : undefined,
        status: commitmentName(u.slot.status),
      };
      this.seenStatuses.add(upd.status);
      this.probeStatuses.add(upd.status);
      if (!this.deduper.accept(upd)) return; // (slot,parent,status) dedupe
      const head: ChainHead = { slot: upd.slot, status: upd.status };
      this.head.set(head); // chain head: latest-value-wins
      this.handlers?.onChainHead?.(head);
    }
    if (u.transaction) {
      const ev: TxLifecycleEvent = { slot: Number(u.transaction.slot), raw: u.transaction };
      this.lifecycle.push(ev); // lifecycle: hard-bounded queue
      this.handlers?.onTxUpdate?.(ev);
    }
    if (u.blockMeta) {
      this.blockFullnessValue = blockFullnessFrom(u.blockMeta.executedTransactionCount); // congestion signal
    }
  }

  /** Runtime probe: if the single stream never yields CONFIRMED+FINALIZED, fall back. */
  private startProbe(): void {
    if (this.mode !== 'single' || this.fallbackTried) return;
    this.probeTimer = setTimeout(() => {
      if (!this.stopped && this.mode === 'single' && !this.commitmentProbeOk()) {
        this.fallbackTried = true;
        this.mode = 'perCommitment';
        logger.warn('[geyser] single-stream probe failed (no confirmed/finalized) → per-commitment fallback');
        this.scheduleReconnect(); // reconnect re-opens slot subs in perCommitment mode
      }
    }, this.opts.probeWindowMs ?? 12_000);
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => this.writePing(), 15_000);
  }
  private writePing(): void {
    const req = emptySubscribeRequest();
    req.ping = { id: ++this.pingId };
    const safeWrite = (s: Stream | undefined): void => {
      if (!s) return;
      try {
        s.write(req); // guard each write so one bad stream doesn't skip the rest
      } catch {
        /* reconnect will handle */
      }
    };
    for (const s of this.slotStreams) safeWrite(s);
    safeWrite(this.txStream);
  }
  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = undefined;
    }
  }
  private clearTimers(): void {
    this.stopPing();
    if (this.probeTimer) {
      clearTimeout(this.probeTimer);
      this.probeTimer = undefined;
    }
  }

  /**
   * Cancel a stream safely. `cancel()` makes grpc-js emit a `'Cancelled on client'` 'error'
   * event; we remove the real listeners first, then attach a no-op 'error' handler so that
   * cancel-induced event can't surface as an UNHANDLED 'error' and crash the process.
   */
  private static cancelStream(s: Stream): void {
    try {
      s.removeAllListeners();
      s.on('error', () => undefined); // swallow the 'Cancelled on client' error cancel() triggers
      s.cancel();
    } catch {
      /* ignore */
    }
  }

  private teardownStreams(): void {
    for (const s of this.slotStreams) GeyserIngestor.cancelStream(s);
    this.slotStreams = [];
    if (this.txStream) {
      GeyserIngestor.cancelStream(this.txStream);
      this.txStream = undefined;
    }
  }

  /**
   * A non-retryable rejection (auth/balance): stop for good, tear down, and surface it via
   * `onFatal`. Reconnecting would just hammer the endpoint forever with the same error.
   */
  private fatal(err: unknown): void {
    if (this.stopped) return; // first fatal wins; a sibling stream's identical error is ignored
    this.stopped = true;
    this.clearTimers();
    this.teardownStreams();
    const e = err instanceof Error ? err : new Error(String(err));
    logger.error({ err: e.message }, '[geyser] FATAL stream rejection (auth/balance) — not reconnecting');
    this.opts.onFatal?.(e);
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnecting) return; // collapse multi-stream error storms into one
    this.reconnecting = true;
    this.clearTimers();
    this.teardownStreams();
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
    setTimeout(() => void this.connect(), delay);
  }
}
