// Found 2026-09-07 auditing why openai/gpt-5.6-luna — the model openrouter/auto
// beats us with on code-review — had never reached a frontier. It failed on
// every cell of two sweeps with the bare `Provider returned error`. Probing
// each parameter the transport sends isolated it: `logprobs: true`, which the
// harness sets on every cell to capture confidence, and which OpenAI reasoning
// models refuse ("logprobs are not supported with reasoning models"). The
// transport threw and never retried without it, so the measurement pipeline
// could not audition the whole class of model the competitor serves.
import { describe, expect, it } from 'vitest';
import type { PriceTable } from '@potion/core';
import { openAiCompatibleComplete } from './openai.js';

const prices: PriceTable = {
  version: 't',
  updatedAt: '2026-01-01T00:00:00Z',
  entries: [{ alias: 'or-luna', provider: 'openrouter', model: 'openai/gpt-5.6-luna', inputPer1M: 0.2, outputPer1M: 1.2 }],
};

/** OpenRouter's actual body for luna with logprobs, captured live 2026-09-07. */
const LUNA_REJECTS_LOGPROBS = {
  error: {
    message: 'Provider returned error',
    code: 400,
    metadata: {
      raw: '{\n  "error": {\n    "message": "logprobs are not supported with reasoning models.",\n    "type": "invalid_request_error",\n    "param": "include",\n    "code": "unsupported_parameter"\n  }\n}',
      provider_name: 'Azure',
    },
  },
};

/** kat-coder's body, same day: a 400 with AND without logprobs — a dead upstream. */
const DEAD_UPSTREAM = {
  error: { message: 'Provider returned error', code: 400, metadata: { raw: '{"code":400,"msg":"bad request"}', provider_name: 'AtlasCloud' } },
};

const ok = (text: string) =>
  new Response(JSON.stringify({ model: 'openai/gpt-5.6-luna', choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 1 } }), { status: 200 });

describe('logprobs refused by the upstream model', () => {
  it('retries ONCE without logprobs and returns the answer with no confidence, rather than failing the cell', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchFn: typeof fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      if (body.logprobs === true) return new Response(JSON.stringify(LUNA_REJECTS_LOGPROBS), { status: 400 });
      return ok('OK');
    };
    const res = await openAiCompatibleComplete(
      'openrouter', 'http://x', {}, { apiKey: 'k', prices, fetchFn, maxRetries: 0 },
      { model: 'or-luna', messages: [{ role: 'user', content: 'Reply OK.' }], params: { logprobs: true } },
    );
    expect(res.text).toBe('OK');
    expect(res.logprobConfidence).toBeUndefined();
    expect(bodies).toHaveLength(2);
    expect(bodies[0]?.logprobs).toBe(true);
    expect('logprobs' in (bodies[1] ?? {})).toBe(false);
  });

  it('does NOT retry a 400 that is not about logprobs — a dead upstream stays a failed cell, in one call', async () => {
    let calls = 0;
    const fetchFn: typeof fetch = async () => { calls++; return new Response(JSON.stringify(DEAD_UPSTREAM), { status: 400 }); };
    await expect(openAiCompatibleComplete(
      'openrouter', 'http://x', {}, { apiKey: 'k', prices, fetchFn, maxRetries: 0 },
      { model: 'or-luna', messages: [{ role: 'user', content: 'hi' }], params: { logprobs: true } },
    )).rejects.toThrow(/request failed/);
    expect(calls).toBe(1);
  });

  it('surfaces the UPSTREAM reason in the error, not just OpenRouter’s wrapper — so a failed candidate is diagnosable from the sweep result', async () => {
    const fetchFn: typeof fetch = async () => new Response(JSON.stringify(LUNA_REJECTS_LOGPROBS), { status: 400 });
    await expect(openAiCompatibleComplete(
      'openrouter', 'http://x', {}, { apiKey: 'k', prices, fetchFn, maxRetries: 0 },
      // No logprobs requested here, so nothing to strip: the error must carry the real reason.
      { model: 'or-luna', messages: [{ role: 'user', content: 'hi' }] },
    )).rejects.toThrow(/logprobs are not supported with reasoning models/);
  });
});
