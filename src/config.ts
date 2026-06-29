import 'dotenv/config';
import { lamportsToTip, type TipLamports } from './tip/tipLamports.js';

/**
 * Validated runtime configuration. `loadConfig()` is a *function*, not a
 * top-level side effect — importing this module never triggers validation, so
 * pure modules and unit tests aren't forced to provide a full `.env`. Call it
 * once from the entrypoints (`index.ts`, scripts).
 *
 * No fallbacks for secrets/endpoints: a missing required var throws a clear
 * error rather than silently defaulting (the "real value or a clear error"
 * rule). Tunables get sane defaults.
 */
export interface MarlinConfig {
  // RPC (primary + fallback) — mainnet-beta only
  rpcUrl: string;
  rpcFallbackUrl: string;
  // Geyser / Yellowstone gRPC
  geyserUrl: string;
  geyserToken: string | undefined;
  // Jito Block Engine
  jitoBlockEngineUrl: string;
  payerSecretKey: string;
  // Tip oracle
  jitoTipFloorUrl: string;
  subfloorTipFraction: number;
  // Persistence
  databaseUrl: string;
  // AI agent (OpenRouter, OpenAI-compatible)
  openRouterApiKey: string;
  openRouterModel: string;
  openRouterBaseUrl: string;
  // Tuning
  leaderLookaheadSlots: number;
  maxHoldWindows: number;
  maxRetries: number;
  /** Env-derived hard cap, minted through the tip helper — never `as TipLamports`. */
  tipHardCapLamports: TipLamports;
  // Dashboard / logging
  dashboardPort: number;
  logLevel: string;
}

function req(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`[config] missing required env var: ${name}`);
  return v;
}

function opt(name: string, fallback: string): string {
  const v = process.env[name]?.trim();
  return v && v.length > 0 ? v : fallback;
}

function reqInt(name: string): number {
  const v = req(name);
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new Error(`[config] ${name} must be a non-negative integer, got "${v}"`);
  return n;
}

function intOpt(name: string, fallback: number, min = 0): number {
  const v = process.env[name]?.trim();
  if (!v) return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min) throw new Error(`[config] ${name} must be an integer >= ${min}, got "${v}"`);
  return n;
}

function floatOpt(name: string, fallback: number, min: number, max: number): number {
  const v = process.env[name]?.trim();
  if (!v) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`[config] ${name} must be a number in [${min}, ${max}], got "${v}"`);
  return n;
}

export function loadConfig(): MarlinConfig {
  const rpcUrl = req('RPC_URL');
  return {
    rpcUrl,
    rpcFallbackUrl: opt('RPC_FALLBACK_URL', rpcUrl),
    geyserUrl: req('GEYSER_URL'),
    geyserToken: process.env.GEYSER_TOKEN?.trim() || undefined,
    jitoBlockEngineUrl: req('JITO_BLOCK_ENGINE_URL'),
    payerSecretKey: req('PAYER_SECRET_KEY'),
    jitoTipFloorUrl: opt('JITO_TIP_FLOOR_URL', 'https://bundles.jito.wtf/api/v1/bundles/tip_floor'),
    subfloorTipFraction: floatOpt('SUBFLOOR_TIP_FRACTION', 0.2, 0, 1),
    databaseUrl: req('DATABASE_URL'),
    openRouterApiKey: req('OPENROUTER_API_KEY'),
    openRouterModel: opt('OPENROUTER_MODEL', 'openai/gpt-4o-mini'),
    openRouterBaseUrl: opt('OPENROUTER_BASE_URL', 'https://openrouter.ai/api/v1'),
    leaderLookaheadSlots: intOpt('LEADER_LOOKAHEAD_SLOTS', 8, 1),
    maxHoldWindows: intOpt('MAX_HOLD_WINDOWS', 2, 0),
    maxRetries: intOpt('MAX_RETRIES', 3, 0),
    // Codex r4 note: mint the env-derived cap through the tip helper, not `as TipLamports`.
    tipHardCapLamports: lamportsToTip(reqInt('TIP_HARD_CAP_LAMPORTS')),
    dashboardPort: intOpt('DASHBOARD_PORT', 8080, 1),
    logLevel: opt('LOG_LEVEL', 'info'),
  };
}
