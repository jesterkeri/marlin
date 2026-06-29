/**
 * Pure helpers for the Geyser ingest path — no network, fully unit-tested.
 */

export interface SlotUpdate {
  slot: number;
  /** Parent slot, if the provider includes it (used for reorg-safe dedupe). */
  parent?: number;
  /** Normalized commitment name: 'processed' | 'confirmed' | 'finalized' | 'other'. */
  status: string;
}

/**
 * Dedupe key. A slot legitimately re-emits as it advances
 * PROCESSED→CONFIRMED→FINALIZED, so we key on status too. And during a minor
 * fork/reorg the same (slot,status) can recur with a different parent, so we key
 * on parent when it's present. When parent is absent we fall back to
 * (slot,status) and reorg detection is degraded for that update.
 */
export function slotKey(u: SlotUpdate): string {
  return u.parent === undefined ? `${u.slot}:_:${u.status}` : `${u.slot}:${u.parent}:${u.status}`;
}

/** True when parent was absent — reorg detection is degraded for this update. */
export function reorgDegraded(u: SlotUpdate): boolean {
  return u.parent === undefined;
}

/** Bounded FIFO dedupe set: remembers the last `capacity` keys. */
export class SlotDeduper {
  private readonly seen = new Set<string>();
  private readonly order: string[] = [];
  constructor(private readonly capacity = 4096) {}

  /** Returns true if this update is NEW (not a duplicate). */
  accept(u: SlotUpdate): boolean {
    const k = slotKey(u);
    if (this.seen.has(k)) return false;
    this.seen.add(k);
    this.order.push(k);
    if (this.order.length > this.capacity) {
      const old = this.order.shift()!;
      this.seen.delete(old);
    }
    return true;
  }
}

/** Latest-value-wins coalescer for the chain head (stale slots are dropped). */
export class LatestWins<T> {
  private value: T | undefined;
  set(v: T): void {
    this.value = v;
  }
  get(): T | undefined {
    return this.value;
  }
}

export interface BoundedQueueOpts {
  /** Past this, flag degraded so RPC reconciliation backstops the stream. */
  softCap?: number;
  /** Hard memory ceiling: past this, shed the OLDEST events (recovered via RPC reconcile). */
  hardCap?: number;
  onDegraded?: (size: number) => void;
  onShed?: (totalShed: number) => void;
}

/**
 * Bounded queue for watched-tx lifecycle events. Soft cap flags `degraded`
 * (RPC reconciliation kicks in); the HARD cap actually bounds memory by shedding
 * the oldest events — under a wedged consumer this prevents an OOM, and the shed
 * (oldest, most-likely-already-reconciled) events are recovered via the RPC
 * `getSignatureStatuses` backstop. `shed` exposes how many were dropped.
 */
export class BoundedLifecycleQueue<T> {
  private readonly items: T[] = [];
  private readonly softCap: number;
  private readonly hardCap: number;
  private readonly onDegraded?: (size: number) => void;
  private readonly onShed?: (totalShed: number) => void;
  degraded = false;
  shed = 0;

  constructor(opts: BoundedQueueOpts = {}) {
    this.softCap = opts.softCap ?? 10_000;
    this.hardCap = opts.hardCap ?? 50_000;
    this.onDegraded = opts.onDegraded;
    this.onShed = opts.onShed;
  }

  push(item: T): void {
    this.items.push(item);
    if (this.items.length > this.softCap && !this.degraded) {
      this.degraded = true;
      this.onDegraded?.(this.items.length);
    }
    while (this.items.length > this.hardCap) {
      this.items.shift(); // shed oldest — bounds memory; RPC reconcile recovers it
      this.shed++;
      this.onShed?.(this.shed);
    }
  }

  drain(): T[] {
    const out = this.items.splice(0, this.items.length);
    if (this.items.length <= this.softCap) this.degraded = false;
    return out;
  }

  get size(): number {
    return this.items.length;
  }
}

/**
 * Runtime startup probe (Codex r3): did the single `filterByCommitment:false`
 * stream actually deliver CONFIRMED + FINALIZED slot statuses? If not, the caller
 * must fall back to N per-commitment subscriptions.
 */
export function commitmentProbe(seenStatuses: Iterable<string>): {
  processed: boolean;
  confirmed: boolean;
  finalized: boolean;
  ok: boolean;
} {
  const s = new Set([...seenStatuses].map((x) => x.toLowerCase()));
  const processed = s.has('processed');
  const confirmed = s.has('confirmed');
  const finalized = s.has('finalized');
  return { processed, confirmed, finalized, ok: confirmed && finalized };
}
