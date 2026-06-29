/**
 * Stream-confirmed lifecycle tracking. Stage progression is a pure, monotonic
 * state machine (submitted → processed → confirmed → finalized) with per-stage
 * timestamps, slots, and latency deltas — fully unit-testable. The
 * `LifecycleTracker` wires it to persistence + a finalized signal. The live
 * source feeds `observe()`: the Geyser tx-stream (PROCESSED commitment) for the
 * earliest `processed` observation, and the authoritative per-signature RPC
 * reconcile (`getSignatureStatuses`) for `confirmed`/`finalized` — commitment is
 * never advanced from slot numbers alone (a slot can finalize on a fork that did
 * not include the transaction).
 */

export type Stage = 'submitted' | 'processed' | 'confirmed' | 'finalized';
const ORDER: Stage[] = ['submitted', 'processed', 'confirmed', 'finalized'];

export interface StageRecord {
  stage: Stage;
  slot?: number;
  ts: number;
  latencyDeltaMs?: number;
}
export interface LifecycleState {
  signature: string;
  records: StageRecord[];
}

/** Apply a stage event. Out-of-order and duplicate stages are ignored (monotonic). */
export function applyStage(
  state: LifecycleState,
  stage: Stage,
  slot: number | undefined,
  ts: number,
): { state: LifecycleState; record?: StageRecord } {
  const last = state.records[state.records.length - 1];
  const lastIdx = last ? ORDER.indexOf(last.stage) : -1;
  const idx = ORDER.indexOf(stage);
  if (idx <= lastIdx) return { state }; // duplicate or out-of-order
  const prevTs = last?.ts;
  const record: StageRecord = { stage, slot, ts, latencyDeltaMs: prevTs !== undefined ? ts - prevTs : undefined };
  return { state: { ...state, records: [...state.records, record] }, record };
}

export function isFinalized(state: LifecycleState): boolean {
  return state.records.some((r) => r.stage === 'finalized');
}

/** Delta between two named stages (ms), or undefined if either is missing. */
export function stageDelta(state: LifecycleState, from: Stage, to: Stage): number | undefined {
  const a = state.records.find((r) => r.stage === from)?.ts;
  const b = state.records.find((r) => r.stage === to)?.ts;
  return a !== undefined && b !== undefined ? b - a : undefined;
}

export interface TrackerDeps {
  onStage?: (signature: string, record: StageRecord) => void;
  onFinalized?: (signature: string, state: LifecycleState) => void;
}

export class LifecycleTracker {
  private readonly states = new Map<string, LifecycleState>();
  constructor(private readonly deps: TrackerDeps = {}) {}

  /** Begin tracking at submission. */
  track(signature: string, ts: number): void {
    if (this.states.has(signature)) return;
    const { state, record } = applyStage({ signature, records: [] }, 'submitted', undefined, ts);
    this.states.set(signature, state);
    if (record) this.deps.onStage?.(signature, record);
  }

  /** Feed a stage observation from the stream (or RPC fallback). */
  observe(signature: string, stage: Stage, slot: number | undefined, ts: number): void {
    const st = this.states.get(signature);
    if (!st) return;
    const { state, record } = applyStage(st, stage, slot, ts);
    this.states.set(signature, state);
    if (record) {
      this.deps.onStage?.(signature, record);
      if (stage === 'finalized') this.deps.onFinalized?.(signature, state);
    }
  }

  get(signature: string): LifecycleState | undefined {
    return this.states.get(signature);
  }
}
