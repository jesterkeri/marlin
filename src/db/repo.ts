import { Pool } from 'pg';
import { createHash } from 'node:crypto';
import { WriteBuffer, type WalEvent } from './writeBuffer.js';
import type { TipLamports } from '../tip/tipLamports.js';
import type { FailureClass } from '../track/failures.js';

/**
 * Async, non-blocking persistence. Every `record*` enqueues and returns
 * immediately — submission is never gated on a DB write.
 *
 * IDs are DETERMINISTIC (a UUID derived from the row's natural key), so a
 * replayed or re-recorded event maps to the SAME primary key. Combined with
 * `ON CONFLICT ... DO NOTHING/UPDATE`, this makes WAL replay fully idempotent and
 * keeps child-row foreign keys valid even when a parent insert conflicted with a
 * pre-existing row (the Codex r2/r3 FK hazard with random UUIDs).
 */

/** Deterministic UUID (v5-shaped) from a stable key. Same key → same id, always. */
export function deterministicId(key: string): string {
  const b = createHash('sha256').update(key).digest().subarray(0, 16);
  const v = Buffer.from(b);
  v[6] = (v[6]! & 0x0f) | 0x50; // version 5
  v[8] = (v[8]! & 0x3f) | 0x80; // RFC-4122 variant
  const h = v.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

export interface SubmissionRow { idempotencyKey: string; targetLeaderIdentity?: string; targetSlot?: number; blockhash?: string; lastValidBlockHeight?: number; }
export interface AttemptRow { submissionId: string; attemptNo: number; bundleUuid?: string; signature?: string; tipLamports?: TipLamports; blockhash?: string; lastValidBlockHeight?: number; expiryBlockHeight?: number; rawBundleResult?: unknown; resultReceivedAt?: string; }
export interface BundleEventRow { attemptId: string; bundleUuid: string; kind: string; droppedReason?: string; rejectedReason?: string; raw?: unknown; ts: string; }
export interface LifecycleRow { attemptId: string; stage: 'submitted' | 'processed' | 'confirmed' | 'finalized'; slot?: number; ts: string; latencyDeltaMs?: number; }
export interface TipDecisionRow { attemptId: string; source: 'tip_floor' | 'last_good_degraded'; floor?: number; p50?: number; p75?: number; max?: number; congestion?: number; chosenTip?: number; ts: string; }
export interface FailureRow { attemptId: string; classification: FailureClass; jitoDropReason?: string; rawBundleResult?: unknown; signal?: string; slot?: number; ts: string; }
export interface AgentDecisionRow { attemptId: string; inputs?: unknown; output?: unknown; clampedTip?: number; model?: string; malformed?: boolean; ts: string; }

export class Repo {
  private readonly pool: Pool;
  private readonly buffer: WriteBuffer;

  constructor(opts: { databaseUrl: string; walPath: string; onError?: (e: WalEvent, err: unknown) => void; onFatal?: (e: WalEvent, err: unknown) => void }) {
    this.pool = new Pool({ connectionString: opts.databaseUrl });
    this.buffer = new WriteBuffer({ walPath: opts.walPath, writeFn: (e) => this.persist(e), onError: opts.onError, onFatal: opts.onFatal });
  }

  /** Returns the deterministic submission id (stable across replays). */
  recordSubmission(r: SubmissionRow): string {
    const id = deterministicId(`submission:${r.idempotencyKey}`);
    this.buffer.enqueue('submission', r.idempotencyKey, { id, ...r });
    return id;
  }

  /** Returns the deterministic attempt id. */
  recordAttempt(r: AttemptRow): string {
    const id = deterministicId(`attempt:${r.submissionId}#${r.attemptNo}`);
    this.buffer.enqueue('attempt', `${r.submissionId}#${r.attemptNo}`, { id, ...r });
    return id;
  }

  /**
   * The deterministic attempt id for a (submission, attemptNo) — the SAME
   * derivation `recordAttempt` uses. Lets failure/lifecycle/agent rows reference
   * an attempt by its real UUID PK (not a raw `submId#n` string, which would
   * violate the UUID foreign key).
   */
  attemptIdFor(submissionId: string, attemptNo: number): string {
    return deterministicId(`attempt:${submissionId}#${attemptNo}`);
  }

  recordLifecycle(r: LifecycleRow): void {
    const id = deterministicId(`lifecycle:${r.attemptId}#${r.stage}`);
    this.buffer.enqueue('lifecycle', `${r.attemptId}#${r.stage}`, { id, ...r });
  }
  /** Append-only Jito bundle-result history (one row per attempt+kind; replay-safe). */
  recordBundleEvent(r: BundleEventRow): void {
    const id = deterministicId(`bundle_event:${r.attemptId}#${r.kind}`);
    this.buffer.enqueue('bundle_event', `${r.attemptId}#${r.kind}`, { id, ...r });
  }
  recordTipDecision(r: TipDecisionRow): void {
    const id = deterministicId(`tip:${r.attemptId}#${r.ts}`);
    this.buffer.enqueue('tip_decision', id, { id, ...r });
  }
  recordFailure(r: FailureRow): void {
    const id = deterministicId(`failure:${r.attemptId}#${r.ts}`);
    this.buffer.enqueue('failure', id, { id, ...r });
  }
  recordAgentDecision(r: AgentDecisionRow): void {
    const id = deterministicId(`agent:${r.attemptId}#${r.ts}`);
    this.buffer.enqueue('agent_decision', id, { id, ...r });
  }

  flush(): Promise<void> {
    return this.buffer.flush();
  }
  recoverWal(): Promise<{ replayed: number; remaining: number; corrupt: number }> {
    return this.buffer.replayWal();
  }
  async close(): Promise<void> {
    await this.pool.end();
  }

  private async persist(e: WalEvent): Promise<void> {
    const p = e.payload as Record<string, unknown>;
    switch (e.kind) {
      case 'submission':
        await this.pool.query(
          `INSERT INTO submissions(id, idempotency_key, target_leader_identity, target_slot, blockhash, last_valid_block_height)
           VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT (idempotency_key) DO NOTHING`,
          [p.id, p.idempotencyKey, p.targetLeaderIdentity ?? null, p.targetSlot ?? null, p.blockhash ?? null, p.lastValidBlockHeight ?? null],
        );
        break;
      case 'attempt':
        await this.pool.query(
          `INSERT INTO submission_attempts(id, submission_id, attempt_no, bundle_uuid, signed_tx_signature, tip_lamports, blockhash, last_valid_block_height, expiry_block_height, raw_bundle_result, result_received_at)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
           ON CONFLICT (submission_id, attempt_no) DO UPDATE SET
             bundle_uuid=COALESCE(EXCLUDED.bundle_uuid, submission_attempts.bundle_uuid),
             signed_tx_signature=COALESCE(EXCLUDED.signed_tx_signature, submission_attempts.signed_tx_signature),
             tip_lamports=COALESCE(EXCLUDED.tip_lamports, submission_attempts.tip_lamports),
             blockhash=COALESCE(EXCLUDED.blockhash, submission_attempts.blockhash),
             last_valid_block_height=COALESCE(EXCLUDED.last_valid_block_height, submission_attempts.last_valid_block_height),
             expiry_block_height=COALESCE(EXCLUDED.expiry_block_height, submission_attempts.expiry_block_height),
             -- EXCLUDED is the INCOMING row, so a non-null new snapshot overwrites (latest-non-null
             -- wins); a partial upsert (e.g. signature-only, raw NULL) keeps the prior snapshot. Full
             -- ordered history lives in the append-only bundle_events table.
             raw_bundle_result=COALESCE(EXCLUDED.raw_bundle_result, submission_attempts.raw_bundle_result),
             result_received_at=COALESCE(EXCLUDED.result_received_at, submission_attempts.result_received_at)`,
          [p.id, p.submissionId, p.attemptNo, p.bundleUuid ?? null, p.signature ?? null, p.tipLamports ?? null, p.blockhash ?? null, p.lastValidBlockHeight ?? null, p.expiryBlockHeight ?? null, p.rawBundleResult ?? null, p.resultReceivedAt ?? null],
        );
        break;
      case 'bundle_event':
        await this.pool.query(
          `INSERT INTO bundle_events(id, attempt_id, bundle_uuid, kind, dropped_reason, rejected_reason, raw_bundle_result, ts)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (attempt_id, kind) DO NOTHING`,
          [p.id, p.attemptId, p.bundleUuid, p.kind, p.droppedReason ?? null, p.rejectedReason ?? null, p.raw ?? null, p.ts],
        );
        break;
      case 'lifecycle':
        await this.pool.query(
          `INSERT INTO lifecycle_events(id, attempt_id, stage, slot, ts, latency_delta_ms)
           VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT (attempt_id, stage) DO NOTHING`,
          [p.id, p.attemptId, p.stage, p.slot ?? null, p.ts, p.latencyDeltaMs ?? null],
        );
        break;
      case 'tip_decision':
        await this.pool.query(
          `INSERT INTO tip_decisions(id, attempt_id, source, floor_lamports, p50_lamports, p75_lamports, max_lamports, congestion, chosen_tip_lamports, ts)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (id) DO NOTHING`,
          [p.id, p.attemptId, p.source, p.floor ?? null, p.p50 ?? null, p.p75 ?? null, p.max ?? null, p.congestion ?? null, p.chosenTip ?? null, p.ts],
        );
        break;
      case 'failure':
        await this.pool.query(
          `INSERT INTO failures(id, attempt_id, classification, jito_drop_reason, raw_bundle_result, signal, slot, ts)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (id) DO NOTHING`,
          [p.id, p.attemptId, p.classification, p.jitoDropReason ?? null, p.rawBundleResult ?? null, p.signal ?? null, p.slot ?? null, p.ts],
        );
        break;
      case 'agent_decision':
        await this.pool.query(
          `INSERT INTO agent_decisions(id, attempt_id, inputs, output, clamped_tip_lamports, model, malformed, ts)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (id) DO NOTHING`,
          [p.id, p.attemptId, p.inputs ?? null, p.output ?? null, p.clampedTip ?? null, p.model ?? null, p.malformed ?? false, p.ts],
        );
        break;
      default:
        throw new Error(`[repo] unknown event kind: ${e.kind}`);
    }
  }
}
