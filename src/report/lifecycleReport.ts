import type { Pool } from 'pg';
import { landRate, percentile, tipEfficiency } from '../obs/metrics.js';

/**
 * Lifecycle-log export (the bounty deliverable: >=10 submissions incl. failures,
 * each with slot numbers, commitment progression, timestamps, tip amounts, and
 * failure classification). Judges cross-reference slots on a Solana explorer.
 *
 * The SQL read (`loadRawTables`) is the only effectful part; assembly + rendering
 * are PURE and unit-tested, so the report format is verifiable offline — the live
 * run just fills the tables. A one-glance SCORECARD (land rate, processed→confirmed
 * latency percentiles, tip efficiency vs the computed floor) heads the report.
 */

export interface SubmissionRow {
  id: string;
  idempotencyKey: string;
}
export interface AttemptRow {
  id: string;
  submissionId: string;
  attemptNo: number;
  signature: string | null;
  tipLamports: number | null;
  blockhash: string | null;
  lastValidBlockHeight: number | null;
  expiryBlockHeight: number | null;
}
export interface StageRow {
  attemptId: string;
  stage: string;
  slot: number | null;
  ts: string;
  latencyDeltaMs: number | null;
}
export interface FailureRow {
  attemptId: string;
  classification: string;
  signal: string | null;
  slot: number | null;
}
export interface BundleEventRow {
  attemptId: string;
  kind: string;
  droppedReason: string | null;
  rejectedReason: string | null;
}
export interface TipDecisionRow {
  attemptId: string;
  source: string;
  floorLamports: number | null;
  chosenTipLamports: number | null;
}
export interface RawTables {
  submissions: SubmissionRow[];
  attempts: AttemptRow[];
  stages: StageRow[];
  failures: FailureRow[];
  bundleEvents: BundleEventRow[];
  tipDecisions: TipDecisionRow[];
}

export interface StageEntry {
  stage: string;
  slot: number | null;
  ts: string;
  latencyDeltaMs: number | null;
}
export interface AttemptReport {
  attemptNo: number;
  signature: string | null;
  tipLamports: number | null;
  expiry?: { lastValidBlockHeight: number | null; expiryBlockHeight: number | null };
  stages: StageEntry[];
  /** Q1-relevant deltas (ms) between commitment stages, when both endpoints exist. */
  deltas: { submittedToProcessedMs?: number; processedToConfirmedMs?: number; confirmedToFinalizedMs?: number };
  failure?: { classification: string; signal: string | null; slot: number | null };
  bundleEventKinds: string[];
  landed: boolean;
  explorer?: string;
}
export interface SubmissionReport {
  idempotencyKey: string;
  attempts: AttemptReport[];
}
export interface LatencyStat {
  p50: number;
  p95: number;
  n: number;
}
/** One-glance health/quality summary computed from the run (uses obs/metrics.ts). */
export interface Scorecard {
  /** Submission-level land rate (a submission lands if any of its attempts finalized). */
  landRate: number;
  landedSubmissions: number;
  totalSubmissions: number;
  /** Average attempts per submission (1.0 = no retries needed). */
  avgAttemptsPerSubmission: number;
  failureClassCounts: Record<string, number>;
  latencyMs: {
    submittedToProcessed: LatencyStat;
    processedToConfirmed: LatencyStat; // the Q1 network-health metric
    confirmedToFinalized: LatencyStat;
  };
  /** Tip discipline: chosen tip vs the oracle floor (1.0 = paid the floor exactly; >1 = overpaid). */
  tip: { avgChosenLamports: number; avgFloorLamports: number; avgEfficiency: number; n: number };
}
export interface LifecycleReport {
  generatedAt: string;
  summary: { submissions: number; attempts: number; landed: number; failedAttempts: number };
  scorecard: Scorecard;
  submissions: SubmissionReport[];
}

const STAGE_ORDER = ['submitted', 'processed', 'confirmed', 'finalized'];

const round2 = (n: number): number => Math.round(n * 100) / 100;
const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const latencyStat = (xs: number[]): LatencyStat => ({ p50: percentile(xs, 50), p95: percentile(xs, 95), n: xs.length });

/** Pure scorecard from the assembled submissions + the tip-decision rows. Uses obs/metrics.ts. */
export function computeScorecard(submissions: SubmissionReport[], tipDecisions: TipDecisionRow[]): Scorecard {
  const submissionLanded = submissions.map((s) => s.attempts.some((a) => a.landed));
  const attemptsTotal = submissions.reduce((n, s) => n + s.attempts.length, 0);
  const allAttempts = submissions.flatMap((s) => s.attempts);

  const failureClassCounts: Record<string, number> = {};
  for (const a of allAttempts) if (a.failure) failureClassCounts[a.failure.classification] = (failureClassCounts[a.failure.classification] ?? 0) + 1;

  const collect = (pick: (a: AttemptReport) => number | undefined): number[] =>
    allAttempts.map(pick).filter((x): x is number => x !== undefined);

  // Tip efficiency: chosen / floor per decision (only rows with a known positive floor).
  const tipRows = tipDecisions.filter((d) => d.chosenTipLamports !== null && d.floorLamports !== null && d.floorLamports > 0);
  const efficiencies = tipRows.map((d) => tipEfficiency(d.chosenTipLamports!, d.floorLamports!));

  return {
    landRate: round2(landRate(submissionLanded)),
    landedSubmissions: submissionLanded.filter(Boolean).length,
    totalSubmissions: submissions.length,
    avgAttemptsPerSubmission: submissions.length ? round2(attemptsTotal / submissions.length) : 0,
    failureClassCounts,
    latencyMs: {
      submittedToProcessed: latencyStat(collect((a) => a.deltas.submittedToProcessedMs)),
      processedToConfirmed: latencyStat(collect((a) => a.deltas.processedToConfirmedMs)),
      confirmedToFinalized: latencyStat(collect((a) => a.deltas.confirmedToFinalizedMs)),
    },
    tip: {
      avgChosenLamports: Math.round(mean(tipRows.map((d) => d.chosenTipLamports!))),
      avgFloorLamports: Math.round(mean(tipRows.map((d) => d.floorLamports!))),
      avgEfficiency: round2(mean(efficiencies)),
      n: tipRows.length,
    },
  };
}

function tsOf(stages: StageEntry[], stage: string): number | undefined {
  const s = stages.find((x) => x.stage === stage);
  return s ? Date.parse(s.ts) : undefined;
}
function deltaMs(stages: StageEntry[], from: string, to: string): number | undefined {
  const a = tsOf(stages, from);
  const b = tsOf(stages, to);
  return a !== undefined && b !== undefined ? b - a : undefined;
}

/** Build the structured report from the raw rows. Pure — testable. */
export function assembleReport(t: RawTables, generatedAt: string): LifecycleReport {
  const stagesByAttempt = new Map<string, StageEntry[]>();
  for (const s of t.stages) {
    const list = stagesByAttempt.get(s.attemptId) ?? [];
    list.push({ stage: s.stage, slot: s.slot, ts: s.ts, latencyDeltaMs: s.latencyDeltaMs });
    stagesByAttempt.set(s.attemptId, list);
  }
  const failureByAttempt = new Map<string, FailureRow>();
  for (const f of t.failures) if (!failureByAttempt.has(f.attemptId)) failureByAttempt.set(f.attemptId, f);
  const bundleKindsByAttempt = new Map<string, string[]>();
  for (const e of t.bundleEvents) {
    const list = bundleKindsByAttempt.get(e.attemptId) ?? [];
    list.push(e.kind);
    bundleKindsByAttempt.set(e.attemptId, list);
  }
  const attemptsBySubmission = new Map<string, AttemptRow[]>();
  for (const a of t.attempts) {
    const list = attemptsBySubmission.get(a.submissionId) ?? [];
    list.push(a);
    attemptsBySubmission.set(a.submissionId, list);
  }

  let attemptCount = 0;
  let landedCount = 0;
  let failedCount = 0;

  const submissions: SubmissionReport[] = t.submissions.map((sub) => {
    const attempts = (attemptsBySubmission.get(sub.id) ?? [])
      .slice()
      .sort((x, y) => x.attemptNo - y.attemptNo)
      .map((a): AttemptReport => {
        const stages = (stagesByAttempt.get(a.id) ?? [])
          .slice()
          .sort((x, y) => STAGE_ORDER.indexOf(x.stage) - STAGE_ORDER.indexOf(y.stage));
        const landed = stages.some((s) => s.stage === 'finalized');
        const failure = failureByAttempt.get(a.id);
        attemptCount++;
        if (landed) landedCount++;
        if (failure) failedCount++;
        return {
          attemptNo: a.attemptNo,
          signature: a.signature,
          tipLamports: a.tipLamports,
          ...(a.expiryBlockHeight !== null || a.lastValidBlockHeight !== null
            ? { expiry: { lastValidBlockHeight: a.lastValidBlockHeight, expiryBlockHeight: a.expiryBlockHeight } }
            : {}),
          stages,
          deltas: {
            submittedToProcessedMs: deltaMs(stages, 'submitted', 'processed'),
            processedToConfirmedMs: deltaMs(stages, 'processed', 'confirmed'),
            confirmedToFinalizedMs: deltaMs(stages, 'confirmed', 'finalized'),
          },
          ...(failure ? { failure: { classification: failure.classification, signal: failure.signal, slot: failure.slot } } : {}),
          bundleEventKinds: bundleKindsByAttempt.get(a.id) ?? [],
          landed,
          ...(landed && a.signature ? { explorer: `https://solscan.io/tx/${a.signature}` } : {}),
        };
      });
    return { idempotencyKey: sub.idempotencyKey, attempts };
  });

  return {
    generatedAt,
    summary: { submissions: t.submissions.length, attempts: attemptCount, landed: landedCount, failedAttempts: failedCount },
    scorecard: computeScorecard(submissions, t.tipDecisions),
    submissions,
  };
}

export function renderJson(r: LifecycleReport): string {
  return JSON.stringify(r, null, 2);
}

function stageCell(stages: StageEntry[], stage: string): string {
  const s = stages.find((x) => x.stage === stage);
  return s ? String(s.slot ?? '?') : '-';
}

const stat = (s: LatencyStat): string => (s.n ? `p50 ${s.p50} / p95 ${s.p95} ms (n=${s.n})` : 'n/a');

/** The one-glance scorecard block that heads the human-readable report. */
function renderScorecard(sc: Scorecard): string[] {
  const failures = Object.entries(sc.failureClassCounts);
  const failureLine = failures.length ? failures.map(([k, v]) => `${k}×${v}`).join(', ') : 'none';
  const tip = sc.tip.n
    ? `chosen ${sc.tip.avgChosenLamports} vs floor ${sc.tip.avgFloorLamports} lamports → ${sc.tip.avgEfficiency}× floor (n=${sc.tip.n})`
    : 'n/a';
  return [
    '## Scorecard',
    '',
    `- **Land rate:** ${Math.round(sc.landRate * 100)}% (${sc.landedSubmissions}/${sc.totalSubmissions} submissions) · avg ${sc.avgAttemptsPerSubmission} attempts/submission`,
    `- **processed→confirmed latency** (Q1 network-health signal): ${stat(sc.latencyMs.processedToConfirmed)}`,
    `- submitted→processed: ${stat(sc.latencyMs.submittedToProcessed)} · confirmed→finalized: ${stat(sc.latencyMs.confirmedToFinalized)}`,
    `- **Tip efficiency:** ${tip}`,
    `- Failure classes: ${failureLine}`,
    '',
  ];
}

/** Human-readable table (printed to the console + saved as the .md deliverable). */
export function renderTable(r: LifecycleReport): string {
  const lines: string[] = [];
  lines.push(`# Marlin lifecycle log — ${r.generatedAt}`);
  lines.push('');
  lines.push(...renderScorecard(r.scorecard));
  lines.push(`submissions: ${r.summary.submissions} · attempts: ${r.summary.attempts} · landed: ${r.summary.landed} · failed attempts: ${r.summary.failedAttempts}`);
  lines.push('');
  lines.push('| submission | att | sub | proc | conf | final | p→c ms | tip | class | explorer |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|');
  for (const sub of r.submissions) {
    for (const a of sub.attempts) {
      lines.push(
        `| ${sub.idempotencyKey} | ${a.attemptNo} | ${stageCell(a.stages, 'submitted')} | ${stageCell(a.stages, 'processed')} | ${stageCell(a.stages, 'confirmed')} | ${stageCell(a.stages, 'finalized')} | ${a.deltas.processedToConfirmedMs ?? '-'} | ${a.tipLamports ?? '-'} | ${a.failure?.classification ?? (a.landed ? 'landed' : '-')} | ${a.explorer ?? '-'} |`,
      );
    }
  }
  return lines.join('\n');
}

/** The only effectful part: read the five tables. Assembly/formatting are pure. */
export async function loadRawTables(pool: Pool): Promise<RawTables> {
  const [subs, atts, stages, fails, events, tips] = await Promise.all([
    pool.query('SELECT id, idempotency_key FROM submissions ORDER BY created_at'),
    pool.query('SELECT id, submission_id, attempt_no, signed_tx_signature, tip_lamports, blockhash, last_valid_block_height, expiry_block_height FROM submission_attempts'),
    pool.query('SELECT attempt_id, stage, slot, ts, latency_delta_ms FROM lifecycle_events'),
    pool.query('SELECT attempt_id, classification, signal, slot FROM failures'),
    pool.query('SELECT attempt_id, kind, dropped_reason, rejected_reason FROM bundle_events'),
    pool.query('SELECT attempt_id, source, floor_lamports, chosen_tip_lamports FROM tip_decisions'),
  ]);
  return {
    submissions: subs.rows.map((r) => ({ id: r.id, idempotencyKey: r.idempotency_key })),
    attempts: atts.rows.map((r) => ({
      id: r.id,
      submissionId: r.submission_id,
      attemptNo: r.attempt_no,
      signature: r.signed_tx_signature,
      tipLamports: r.tip_lamports === null ? null : Number(r.tip_lamports),
      blockhash: r.blockhash,
      lastValidBlockHeight: r.last_valid_block_height === null ? null : Number(r.last_valid_block_height),
      expiryBlockHeight: r.expiry_block_height === null ? null : Number(r.expiry_block_height),
    })),
    stages: stages.rows.map((r) => ({
      attemptId: r.attempt_id,
      stage: r.stage,
      slot: r.slot === null ? null : Number(r.slot),
      ts: r.ts instanceof Date ? r.ts.toISOString() : String(r.ts),
      latencyDeltaMs: r.latency_delta_ms === null ? null : Number(r.latency_delta_ms),
    })),
    failures: fails.rows.map((r) => ({ attemptId: r.attempt_id, classification: r.classification, signal: r.signal, slot: r.slot === null ? null : Number(r.slot) })),
    bundleEvents: events.rows.map((r) => ({ attemptId: r.attempt_id, kind: r.kind, droppedReason: r.dropped_reason, rejectedReason: r.rejected_reason })),
    tipDecisions: tips.rows.map((r) => ({
      attemptId: r.attempt_id,
      source: r.source,
      floorLamports: r.floor_lamports === null ? null : Number(r.floor_lamports),
      chosenTipLamports: r.chosen_tip_lamports === null ? null : Number(r.chosen_tip_lamports),
    })),
  };
}
