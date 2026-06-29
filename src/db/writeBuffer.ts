import { appendFile, readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Async write buffer with a durable fallback. Persistence MUST NEVER block
 * submission (brief §2), so writes go through an in-memory queue drained in the
 * background; if the durable sink (Postgres) fails, the event is appended to an
 * append-only JSONL WAL and retried later. On recovery, `replayWal()` drains the
 * WAL back into the sink in append order; the sink's upserts are idempotent
 * (keyed per the schema's UNIQUE constraints), so replayed dupes are no-ops.
 *
 * Rotation: the WAL self-truncates whenever `replayWal()` succeeds. `maxWalBytes`
 * is an advisory ceiling — exceeding it emits an `onError` 'wal_overflow' (logged
 * degraded) but never drops data. True size-based rotation is a Phase-2 nicety.
 */
export interface WalEvent {
  seq: number;
  kind: string;
  /** Idempotency key (matched by the sink's ON CONFLICT). */
  key: string;
  payload: unknown;
}

export interface WriteBufferOptions {
  writeFn: (e: WalEvent) => Promise<void>;
  walPath: string;
  maxWalBytes?: number;
  onError?: (e: WalEvent, err: unknown) => void;
  onOverflow?: (bytes: number) => void;
  /** Both the sink AND the WAL append failed — the event is kept in memory, not lost. */
  onFatal?: (e: WalEvent, err: unknown) => void;
}

export class WriteBuffer {
  private seq = 0;
  private readonly queue: WalEvent[] = [];
  private chain: Promise<void> = Promise.resolve();
  private fatalPending = false;

  constructor(private readonly opts: WriteBufferOptions) {}

  /** Non-blocking. Enqueue + kick the background drain. Never throws to the caller. */
  enqueue(kind: string, key: string, payload: unknown): void {
    this.queue.push({ seq: ++this.seq, kind, key, payload });
    this.chain = this.chain.then(() => this.drainOnce()).catch(() => undefined);
  }

  /**
   * Await the in-flight drain. REJECTS if events are stuck in memory because both
   * the sink and the WAL failed — so a graceful shutdown (`await flush()` then
   * `close()`) cannot silently exit with the only copy in RAM. `enqueue()` stays
   * non-throwing for the submission path.
   */
  async flush(): Promise<void> {
    await this.chain;
    if (this.queue.length > 0) await this.retryPending(); // actively re-attempt RAM-only stuck events
    if (this.fatalPending) {
      throw new Error('[writeBuffer] flush incomplete: events remain in memory (sink AND WAL unavailable)');
    }
  }

  /**
   * Re-attempt draining events stuck in memory by a prior fatal — call this (or
   * `flush()`) after the sink/WAL is believed recovered. Without it, a stuck event
   * would only drain on the next `enqueue()`.
   */
  async retryPending(): Promise<void> {
    this.chain = this.chain.then(() => this.drainOnce()).catch(() => undefined);
    await this.chain;
  }

  /** True when events are stuck in memory because both the sink and WAL failed. */
  hasPendingFatal(): boolean {
    return this.fatalPending;
  }

  private async drainOnce(): Promise<void> {
    while (this.queue.length) {
      const e = this.queue[0]!; // peek — only remove once the event is durable somewhere
      try {
        await this.opts.writeFn(e);
        this.queue.shift(); // durable in the sink
      } catch (sinkErr) {
        let appended = false;
        try {
          await this.appendWal(e);
          appended = true;
        } catch (walErr) {
          this.fatalPending = true; // surfaced by flush()/hasPendingFatal()
          this.opts.onFatal?.(e, walErr); // sink AND wal both failed
        }
        if (appended) {
          this.queue.shift(); // durable in the WAL
          this.opts.onError?.(e, sinkErr);
        } else {
          return; // keep the event in memory and stop draining — never silently lose it
        }
      }
    }
    this.fatalPending = false; // reached here ⇒ queue fully drained, nothing stuck
  }

  private async appendWal(e: WalEvent): Promise<void> {
    await mkdir(dirname(this.opts.walPath), { recursive: true });
    await appendFile(this.opts.walPath, JSON.stringify(e) + '\n', 'utf8');
    if (this.opts.maxWalBytes) {
      const size = await stat(this.opts.walPath).then((s) => s.size).catch(() => 0);
      if (size > this.opts.maxWalBytes) this.opts.onOverflow?.(size);
    }
  }

  /**
   * Replay the WAL into the sink in append order; rewrite with only the lines
   * that still need attention. Corrupt lines are PRESERVED (kept in the WAL +
   * counted), never silently dropped — a torn tail or a bad line is surfaced for
   * inspection rather than losing the event.
   */
  async replayWal(): Promise<{ replayed: number; remaining: number; corrupt: number }> {
    let content: string;
    try {
      content = await readFile(this.opts.walPath, 'utf8');
    } catch {
      return { replayed: 0, remaining: 0, corrupt: 0 };
    }
    const lines = content.split('\n').filter((l) => l.trim().length > 0);
    const stillFailing: string[] = [];
    let replayed = 0;
    let corrupt = 0;
    for (const line of lines) {
      let e: WalEvent;
      try {
        e = JSON.parse(line) as WalEvent;
      } catch {
        corrupt++;
        stillFailing.push(line); // preserve, don't drop
        continue;
      }
      try {
        await this.opts.writeFn(e);
        replayed++;
      } catch {
        stillFailing.push(line);
      }
    }
    await writeFile(this.opts.walPath, stillFailing.length ? stillFailing.join('\n') + '\n' : '', 'utf8');
    return { replayed, remaining: stillFailing.length, corrupt };
  }
}
