import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAgent, validateDecision, completerFromCreate, type ChatCompleter, type AgentContext, type CreateCompletion } from '../src/ai/agent.js';

const ctx: AgentContext = {
  classification: 'ExpiredBlockhash',
  slot: 100,
  tip: { floor: 10_000, p50: 20_000, p75: 50_000, max: 200_000, congestion: 0.3 },
  leaderWindow: 'imminent',
  attemptNo: 1,
  maxRetries: 3,
};

const completer = (argumentsJson: string | null, throws = false): ChatCompleter => ({
  complete: async () => {
    if (throws) throw new Error('api down');
    return { argumentsJson, raw: {} };
  },
});

const validArgs = JSON.stringify({
  diagnosis: 'expired blockhash',
  actions: { refresh_blockhash: true, new_tip_lamports: 30_000, submit: 'NOW' },
  confidence: 0.8,
  rationale: 'fresh hash + p60 tip',
});

test('runAgent: valid tool args → ok decision', async () => {
  const r = await runAgent(completer(validArgs), 'm', ctx);
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.decision.actions.new_tip_lamports, 30_000);
    assert.equal(r.decision.actions.submit, 'NOW');
  }
});

test('runAgent: absent tool call → not ok (absent)', async () => {
  const r = await runAgent(completer(null), 'm', ctx);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, 'absent');
});

test('runAgent: invalid JSON → malformed', async () => {
  const r = await runAgent(completer('not json{'), 'm', ctx);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, 'malformed');
});

test('runAgent: schema-mismatch JSON → malformed', async () => {
  const r = await runAgent(completer(JSON.stringify({ diagnosis: 'x' })), 'm', ctx);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, 'malformed');
});

test('runAgent: completer throws → error (never throws to caller)', async () => {
  const r = await runAgent(completer(null, true), 'm', ctx);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, 'error');
});

test('validateDecision: rejects bad enum / missing fields, accepts a good one', () => {
  assert.equal(
    validateDecision({ diagnosis: 'x', rationale: 'y', confidence: 1, actions: { refresh_blockhash: true, new_tip_lamports: 1, submit: 'MAYBE' } }),
    null,
  );
  assert.equal(validateDecision({ diagnosis: 'x' }), null);
  assert.ok(validateDecision(JSON.parse(validArgs)));
});

test('completerFromCreate: forced tool-call first, returns its arguments', async () => {
  const calls: Array<Record<string, unknown>> = [];
  const create: CreateCompletion = async (p) => {
    calls.push(p as unknown as Record<string, unknown>);
    return { choices: [{ message: { tool_calls: [{ type: 'function', function: { name: 'decide_retry', arguments: '{"x":1}' } }] } }] };
  };
  const r = await completerFromCreate(create).complete({ model: 'm', system: 's', user: 'u' });
  assert.equal(r.argumentsJson, '{"x":1}');
  assert.equal(calls.length, 1);
  assert.ok((calls[0] as { tool_choice?: unknown }).tool_choice); // forced tool-choice first
});

test('completerFromCreate: tools rejected → falls back to response_format json_schema (in order)', async () => {
  const calls: Array<Record<string, unknown>> = [];
  const create: CreateCompletion = async (p) => {
    calls.push(p as unknown as Record<string, unknown>);
    if ((p as { tool_choice?: unknown }).tool_choice) throw new Error('tools unsupported');
    return { choices: [{ message: { content: '{"y":2}' } }] };
  };
  const r = await completerFromCreate(create).complete({ model: 'm', system: 's', user: 'u' });
  assert.equal(r.argumentsJson, '{"y":2}');
  assert.equal(calls.length, 2);
  assert.ok((calls[0] as { tool_choice?: unknown }).tool_choice); // tool_choice first
  assert.ok((calls[1] as { response_format?: unknown }).response_format); // response_format second
});

test('completerFromCreate: empty forced tool-call → fallback to json_schema', async () => {
  let n = 0;
  const create: CreateCompletion = async (p) => {
    n++;
    if ((p as { tool_choice?: unknown }).tool_choice) return { choices: [{ message: {} }] };
    return { choices: [{ message: { content: '{"z":3}' } }] };
  };
  const r = await completerFromCreate(create).complete({ model: 'm', system: 's', user: 'u' });
  assert.equal(r.argumentsJson, '{"z":3}');
  assert.equal(n, 2);
});
