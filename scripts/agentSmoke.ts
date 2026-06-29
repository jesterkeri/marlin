import process from 'node:process';
import { loadConfig } from '../src/config.js';
import { logger } from '../src/logger.js';
import { makeOpenRouterCompleter, runAgent, type AgentContext } from '../src/ai/agent.js';

/**
 * Live smoke test for the AI decision path (the judged dependency). Calls the
 * configured OPENROUTER_MODEL once and asserts it returns a schema-valid decision.
 * MUST pass before any mainnet demo run. Needs OPENROUTER_API_KEY.
 */
const ctx: AgentContext = {
  classification: 'ExpiredBlockhash',
  slot: 0,
  tip: { floor: 10_000, p50: 20_000, p75: 50_000, max: 200_000, congestion: 0.3 },
  leaderWindow: 'imminent',
  attemptNo: 1,
  maxRetries: 3,
};

async function main(): Promise<void> {
  const cfg = loadConfig();
  const completer = makeOpenRouterCompleter({ apiKey: cfg.openRouterApiKey, baseURL: cfg.openRouterBaseUrl });
  const r = await runAgent(completer, cfg.openRouterModel, ctx);
  if (r.ok) {
    logger.info({ decision: r.decision }, '[agentSmoke] PASS — model returned a schema-valid decision');
    process.exit(0);
  }
  logger.error({ reason: r.reason }, '[agentSmoke] FAIL — model did not return a valid schema');
  process.exit(1);
}

main().catch((err: unknown) => {
  logger.error({ err }, '[agentSmoke] error');
  process.exit(1);
});
