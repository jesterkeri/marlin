import OpenAI from 'openai';
import { logger } from '../logger.js';

/**
 * The one autonomous decision: "Autonomous Retry with Fault Injection".
 *
 * Boundary (deterministic vs AI): the classifier, the mandatory safety actions,
 * and the clamp are deterministic and live in the orchestrator. This module owns
 * only the *discretionary* judgment — tip amount, retry timing, rationale — via a
 * real LLM call through OpenRouter (OpenAI-compatible). The model NEVER signs,
 * submits, or mints an executable tip; it returns a structured object the
 * orchestrator clamps (`clampAgentTip`) and executes.
 *
 * The LLM call is injected (`ChatCompleter`) so the whole module is unit-testable
 * offline; `makeOpenRouterCompleter` is the thin production adapter.
 */

export interface AgentContext {
  classification: string;
  slot: number;
  blockhashAgeSlots?: number;
  tip: { floor: number; p50: number; p75: number; max: number; congestion: number };
  leaderWindow: 'imminent' | 'next' | 'unknown';
  recentLandRate?: number;
  attemptNo: number;
  maxRetries: number;
}

export interface AgentDecision {
  diagnosis: string;
  actions: { refresh_blockhash: boolean; new_tip_lamports: number; submit: 'NOW' | 'HOLD_ONE_WINDOW' };
  confidence: number;
  rationale: string;
}

export type AgentResult =
  | { ok: true; decision: AgentDecision; raw: unknown }
  | { ok: false; reason: 'malformed' | 'absent' | 'error'; raw: unknown };

/** Injected LLM call: returns the forced tool-call arguments (JSON string) or null. */
export interface ChatCompleter {
  complete(args: { model: string; system: string; user: string }): Promise<{ argumentsJson: string | null; raw: unknown }>;
}

export const DECIDE_RETRY_TOOL = {
  type: 'function' as const,
  function: {
    name: 'decide_retry',
    description:
      'Decide the discretionary retry parameters for a failed Solana Jito bundle. The blockhash refresh and compute re-budget are mandatory safety actions applied by the system regardless; you choose the new tip, the timing, and explain why.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['diagnosis', 'actions', 'confidence', 'rationale'],
      properties: {
        diagnosis: { type: 'string', description: 'Why the submission failed.' },
        actions: {
          type: 'object',
          additionalProperties: false,
          required: ['refresh_blockhash', 'new_tip_lamports', 'submit'],
          properties: {
            refresh_blockhash: { type: 'boolean' },
            new_tip_lamports: { type: 'number', description: 'Proposed tip in lamports; will be clamped to [floor, cap].' },
            submit: { type: 'string', enum: ['NOW', 'HOLD_ONE_WINDOW'] },
          },
        },
        confidence: { type: 'number' },
        rationale: { type: 'string' },
      },
    },
  },
};

const SYSTEM_PROMPT = [
  'You are the retry-decision module of a Solana mainnet transaction stack.',
  'A Jito bundle failed. The system has already classified the failure and will deterministically apply mandatory safety fixes (refresh an expired blockhash, re-budget compute).',
  'Your job: choose the new tip (lamports), decide whether to submit NOW or HOLD_ONE_WINDOW, and explain your reasoning.',
  'Your proposed tip is clamped to the oracle floor and the hard cap, so never exceed the live distribution; reason within it.',
  'Always call the decide_retry function with a complete, well-formed decision.',
].join(' ');

function buildUserPrompt(ctx: AgentContext): string {
  return JSON.stringify(ctx);
}

/** Runtime validation — never trust model output even under a strict schema. */
export function validateDecision(obj: unknown): AgentDecision | null {
  if (typeof obj !== 'object' || obj === null) return null;
  const o = obj as Record<string, unknown>;
  const a = o.actions as Record<string, unknown> | undefined;
  if (typeof o.diagnosis !== 'string' || typeof o.rationale !== 'string' || typeof o.confidence !== 'number') return null;
  if (!a || typeof a.refresh_blockhash !== 'boolean' || typeof a.new_tip_lamports !== 'number') return null;
  if (a.submit !== 'NOW' && a.submit !== 'HOLD_ONE_WINDOW') return null;
  return {
    diagnosis: o.diagnosis,
    rationale: o.rationale,
    confidence: o.confidence,
    actions: {
      refresh_blockhash: a.refresh_blockhash,
      new_tip_lamports: a.new_tip_lamports,
      submit: a.submit,
    },
  };
}

/** Run the agent. Returns a structured result; malformed/absent/error are safe, non-throwing. */
export async function runAgent(completer: ChatCompleter, model: string, ctx: AgentContext): Promise<AgentResult> {
  let raw: unknown;
  try {
    const res = await completer.complete({ model, system: SYSTEM_PROMPT, user: buildUserPrompt(ctx) });
    raw = res.raw;
    if (!res.argumentsJson) return { ok: false, reason: 'absent', raw };
    let parsed: unknown;
    try {
      parsed = JSON.parse(res.argumentsJson);
    } catch {
      return { ok: false, reason: 'malformed', raw };
    }
    const decision = validateDecision(parsed);
    return decision ? { ok: true, decision, raw } : { ok: false, reason: 'malformed', raw };
  } catch {
    return { ok: false, reason: 'error', raw };
  }
}

/** Minimal structural shape of an OpenAI-compatible chat-completions `create`. */
export interface RawCompletion {
  choices: Array<{ message?: { content?: string | null; tool_calls?: Array<{ type?: string; function?: { name?: string; arguments?: string } }> } }>;
}
export type CreateCompletion = (params: {
  model: string;
  messages: { role: string; content: string }[];
  tools?: unknown[];
  tool_choice?: unknown;
  response_format?: unknown;
}) => Promise<RawCompletion>;

/**
 * The completer core, parameterized by the `create` call so it's unit-testable.
 * Tries forced function-calling first; on rejection or an empty tool call, falls
 * back to strict json_schema response_format (sends tool_choice first, then
 * response_format).
 */
export function completerFromCreate(create: CreateCompletion): ChatCompleter {
  return {
    async complete({ model, system, user }) {
      const messages = [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ];
      try {
        const resp = await create({
          model,
          messages,
          tools: [DECIDE_RETRY_TOOL],
          tool_choice: { type: 'function', function: { name: 'decide_retry' } },
        });
        const call = resp.choices[0]?.message?.tool_calls?.[0];
        if (call && call.type === 'function' && call.function?.arguments) {
          return { argumentsJson: call.function.arguments, raw: resp };
        }
        logger.warn('[agent] forced tool-call returned no usable call; falling back to json_schema');
      } catch (err) {
        logger.warn({ err }, '[agent] forced tool-calling rejected; falling back to json_schema');
      }
      const resp2 = await create({
        model,
        messages,
        response_format: { type: 'json_schema', json_schema: { name: 'decide_retry', strict: true, schema: DECIDE_RETRY_TOOL.function.parameters } },
      });
      const content = resp2.choices[0]?.message?.content;
      return { argumentsJson: typeof content === 'string' ? content : null, raw: resp2 };
    },
  };
}

/** Production adapter: an OpenRouter-backed completer. */
export function makeOpenRouterCompleter(opts: { apiKey: string; baseURL: string }): ChatCompleter {
  const client = new OpenAI({ apiKey: opts.apiKey, baseURL: opts.baseURL });
  const create = client.chat.completions.create.bind(client.chat.completions) as unknown as CreateCompletion;
  return completerFromCreate(create);
}
