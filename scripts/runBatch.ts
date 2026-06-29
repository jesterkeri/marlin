import process from 'node:process';
import { writeFileSync } from 'node:fs';
import { Pool } from 'pg';
import { loadConfig } from '../src/config.js';
import { logger } from '../src/logger.js';
import { MarlinEngine } from '../src/index.js';
import type { RunResult } from '../src/exec/orchestrator.js';
import { loadRawTables, assembleReport, renderJson, renderTable } from '../src/report/lifecycleReport.js';

/**
 * The lifecycle-log deliverable: run >=N mainnet submissions including >=1 forced
 * blockhash-expiry failure (the AI-retry-with-fault-injection demo), then export
 * the lifecycle log straight from the DB as `lifecycle-report.json` + a
 * human-readable `lifecycle-report.md` (slots, commitment progression, timestamps,
 * tips, failure classes, explorer links for landed txs). Spot-check a few
 * signatures on Solscan before submitting — judges cross-reference them.
 *
 * A second forced failure (a deliberate sub-floor tip) is a Phase-2 orchestrator
 * hook and is intentionally NOT faked here.
 */
const N = Number(process.argv[2] ?? 10);

async function main(): Promise<void> {
  const cfg = loadConfig();
  const engine = new MarlinEngine(cfg);
  await engine.start();

  const results: RunResult[] = [];
  for (let i = 0; i < N; i++) {
    const fault = i === 0 ? ({ fault: 'expired-blockhash' } as const) : {};
    results.push(await engine.submitOnce(`batch-${i}`, fault));
  }

  logger.info(
    {
      count: results.length,
      finalized: results.filter((r) => r.status === 'finalized').length,
      observed: results.filter((r) => r.status === 'observed').length, // RPC-confirmed on-chain, finalization pending — NOT counted as finalized
      indeterminate: results.filter((r) => r.status === 'indeterminate').length, // stream saw it, RPC unconfirmed in-window
      failed: results.filter((r) => r.status === 'failed').length,
    },
    '[runBatch] complete',
  );

  // Export ordering matters (Codex r10): QUIESCE first so no late onBundleResult/Geyser event can
  // enqueue after the flush, THEN strict-flush (rethrows if buffered/WAL writes didn't reach
  // Postgres), THEN read/export, THEN close. This guarantees the exported report is complete — a
  // swallowed flush failure OR an in-flight event can never make us ship a partial log as if whole.
  await engine.quiesce();        // stop streams + drain in-flight reconciles (no late write can land)
  await engine.flushForExport(); // throws → main().catch() exits non-zero, no report files written

  const pool = new Pool({ connectionString: cfg.databaseUrl });
  try {
    const report = assembleReport(await loadRawTables(pool), new Date().toISOString());
    writeFileSync('lifecycle-report.json', renderJson(report));
    const table = renderTable(report);
    writeFileSync('lifecycle-report.md', `${table}\n`);
    process.stdout.write(`\n${table}\n\n`);
    logger.info({ json: 'lifecycle-report.json', md: 'lifecycle-report.md' }, '[runBatch] lifecycle log exported');
  } finally {
    await pool.end();
  }

  await engine.close();
}

main().catch((err: unknown) => {
  logger.error({ err }, '[runBatch] error');
  process.exit(1);
});
