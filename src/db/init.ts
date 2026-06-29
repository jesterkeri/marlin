import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { Pool } from 'pg';
import { loadConfig } from '../config.js';
import { logger } from '../logger.js';

const here = dirname(fileURLToPath(import.meta.url));

/** Apply the idempotent schema. Safe to run repeatedly. */
export async function initDb(databaseUrl: string): Promise<void> {
  const sql = await readFile(join(here, 'schema.sql'), 'utf8');
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    await pool.query(sql);
    logger.info('[db] schema applied');
  } finally {
    await pool.end();
  }
}

// CLI entrypoint: `npm run db:init` (tsx src/db/init.ts)
const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  initDb(loadConfig().databaseUrl).catch((err: unknown) => {
    logger.error(err);
    process.exit(1);
  });
}
