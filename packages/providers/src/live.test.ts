// Live transport tests (Phase 1): stubbed global fetch (vi.stubGlobal) —
// ZERO network. Verifies request mapping (URL/headers/body), response parsing
// (text/usage/modelVersion), alias resolution, and logprobConfidence math.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PriceTable } from '@potion/core';
import { createProviders, DEFAULT_MAX_TOKENS, type CompleteRequest } from './index.js';

const PRICES: PriceTable = {
  version: '2026-08-04',
  updatedAt: '2026-08-04',
  entries: [
    { alias: 'haiku-class', provider: 'anthropic', model: 'claude-haiku-4-5-20251001', inputPer1M: 1, outputPer1M: 5 },
    { alias: 'gpt-mini-class', provider: 'openai', model: 'gpt-4.1-mini-2025-04-14', inputPer1M: 0.4, outputPer1M: 1.6 },
    { alias: 'gemini-flash-class', provider: 'google', model: 'gemini-2.5-flash', inputPer1M: 0.3, outputPer1M: 2.5 },
    { alias: 'or-gpt-mini', provider: 'openrouter', model: 'openai/gpt-4.1-mini', inputPer1M: 0.4, outputPer1M: 1.6 },
  ],
};

const KEYS = { anthropic: 'sk-ant', openai: 'sk-oai', google: 'g-key', openrouter: 'sk-or' } as const;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function lastCall(): { url: string; init: RequestInit; body: Record<string, unknown> } {
  const [url, init] = fetchMock.mock.calls.at(-1)! as [string, RequestInit];
  return { url, init, body: JSON.parse(String(init.body)) as Record<string, unknown> };
}

const MESSAGES: CompleteRequest['messages'] = [
  { role: 'system', content: 'Be terse.' },
  { role: 'user', content: 'Say OK' },
];

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('anthropic transport', () => {
  it('maps messages → system + turns, parses usage tokens', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        model: 'claude-haiku-4-5-20251001',
        content: [{ type: 'text', text: 'OK' }],
        usage: { input_tokens: 11, output_tokens: 2 },
      }),
    );
    const p = createProviders({ prices: PRICES, apiKeys: { ...KEYS } });
    const res = await p.anthropic.complete({ model: 'haiku-class', messages: MESSAGES });

    const { url, init, body } = lastCall();
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    const headers = init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('sk-ant');
    expect(headers['anthropic-version']).toBe('2023-06-01');
    expect(body.model).toBe('claude-haiku-4-5-20251001'); // alias resolved
    expect(body.system).toBe('Be terse.');
    expect(body.messages).toEqual([{ role: 'user', content: 'Say OK' }]);
    expect(body.max_tokens).toBe(1024); // default

    expect(res.text).toBe('OK');
    expect(res.usage).toEqual({ inputTokens: 11, outputTokens: 2 });
    expect(res.logprobConfidence).toBeUndefined(); // Anthropic has no logprobs
    expect(res.modelVersion).toBe('claude-haiku-4-5-20251001');
  });

  it('has no embed (undefined)', () => {
    const p = createProviders({ prices: PRICES, apiKeys: { ...KEYS } });
    expect(p.anthropic.embed).toBeUndefined();
  });
});

describe('openai transport', () => {
  it('sends Bearer auth + logprobs, computes exp(mean(logprob)) confidence', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        model: 'gpt-4.1-mini-2025-04-14',
        choices: [
          {
            message: { content: 'OK' },
            logprobs: { content: [{ logprob: -0.1 }, { logprob: -0.3 }] },
          },
        ],
        usage: { prompt_tokens: 9, completion_tokens: 2 },
      }),
    );
    const p = createProviders({ prices: PRICES, apiKeys: { ...KEYS } });
    const res = await p.openai.complete({
      model: 'gpt-mini-class',
      messages: MESSAGES,
      params: { logprobs: true, maxTokens: 20, seed: 7, temperature: 0 },
    });

    const { url, init, body } = lastCall();
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer sk-oai');
    expect(body.model).toBe('gpt-4.1-mini-2025-04-14');
    expect(body.logprobs).toBe(true);
    expect(body.max_completion_tokens).toBe(20);
    expect(body.seed).toBe(7);
    expect(body.temperature).toBe(0);
    expect(body.messages).toEqual(MESSAGES); // system kept inline

    expect(res.text).toBe('OK');
    expect(res.usage).toEqual({ inputTokens: 9, outputTokens: 2 });
    expect(res.logprobConfidence).toBeCloseTo(Math.exp(-0.2), 9); // exp(mean(-0.1,-0.3))
    expect(res.modelVersion).toBe('gpt-4.1-mini-2025-04-14');
  });

  it('omits logprobConfidence when the response has no logprobs', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        model: 'gpt-4.1-mini-2025-04-14',
        choices: [{ message: { content: 'OK' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
    );
    const p = createProviders({ prices: PRICES, apiKeys: { ...KEYS } });
    const res = await p.openai.complete({ model: 'gpt-mini-class', messages: MESSAGES });
    expect(res.logprobConfidence).toBeUndefined();
    expect('logprobConfidence' in res).toBe(false);
  });

  it('always sends max_tokens — DEFAULT_MAX_TOKENS when params omit it (estimator bound)', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        model: 'gpt-4.1-mini-2025-04-14',
        choices: [{ message: { content: 'OK' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
    );
    const p = createProviders({ prices: PRICES, apiKeys: { ...KEYS } });
    await p.openai.complete({ model: 'gpt-mini-class', messages: MESSAGES });
    // OpenAI-native chat rejects the deprecated 'max_tokens' — the enforced
    // cap rides 'max_completion_tokens' there (OpenRouter keeps max_tokens).
    expect(lastCall().body.max_completion_tokens).toBe(DEFAULT_MAX_TOKENS);
    expect(lastCall().body.max_tokens).toBeUndefined();
  });

  // M3 #25 (OpenAI parity): tools/tool_choice forwarded UNMODIFIED; recorded
  // OpenAI tool_calls response fixture parsed verbatim onto CompleteResponse.
  it('tool calling: forwards tools/tool_choice unmodified, preserves tool_calls', async () => {
    const tools = [
      {
        type: 'function' as const,
        function: {
          name: 'get_weather',
          description: 'Get the current weather for a city',
          parameters: { type: 'object', properties: { city: { type: 'string' } } },
        },
      },
    ];
    // Recorded OpenAI chat.completion tool-call shape (content null).
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        model: 'gpt-4.1-mini-2025-04-14',
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: 'call_abc123',
                  type: 'function',
                  function: { name: 'get_weather', arguments: '{"city":"Paris"}' },
                },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 42, completion_tokens: 11 },
      }),
    );
    const p = createProviders({ prices: PRICES, apiKeys: { ...KEYS } });
    const res = await p.openai.complete({
      model: 'gpt-mini-class',
      messages: [{ role: 'user', content: 'Weather in Paris?' }],
      params: { tools, tool_choice: 'auto' },
    });

    const { body } = lastCall();
    expect(body.tools).toEqual(tools); // unmodified
    expect(body.tool_choice).toBe('auto');

    expect(res.text).toBe('');
    expect(res.toolCalls).toEqual([
      {
        id: 'call_abc123',
        type: 'function',
        function: { name: 'get_weather', arguments: '{"city":"Paris"}' },
      },
    ]);
    expect(res.usage).toEqual({ inputTokens: 42, outputTokens: 11 });
  });

  it('embed: text-embedding-3-small pinned to platform-canonical 384 dims', async () => {
    const vec = Array.from({ length: 384 }, (_, i) => i / 384);
    fetchMock.mockResolvedValue(
      jsonResponse(200, { data: [{ index: 0, embedding: vec }] }),
    );
    const p = createProviders({ prices: PRICES, apiKeys: { ...KEYS } });
    const out = await p.openai.embed!(['hello']);
    const { url, body } = lastCall();
    expect(url).toBe('https://api.openai.com/v1/embeddings');
    expect(body.model).toBe('text-embedding-3-small');
    expect(body.dimensions).toBe(384);
    expect(body.input).toEqual(['hello']);
    expect(out).toEqual([vec]);
    expect(out[0]).toHaveLength(384);
  });
});

describe('google transport', () => {
  it('maps messages → contents (user/model), key in URL, usageMetadata parsed', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        modelVersion: 'gemini-2.5-flash-001',
        candidates: [{ content: { parts: [{ text: 'OK' }] } }],
        usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 2 },
      }),
    );
    const p = createProviders({ prices: PRICES, apiKeys: { ...KEYS } });
    const res = await p.google.complete({
      model: 'gemini-flash-class',
      messages: [
        ...MESSAGES,
        { role: 'assistant', content: 'OK' },
        { role: 'user', content: 'Again' },
      ],
    });

    const { url, body } = lastCall();
    expect(url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=g-key',
    );
    expect(body.systemInstruction).toEqual({ parts: [{ text: 'Be terse.' }] });
    expect(body.contents).toEqual([
      { role: 'user', parts: [{ text: 'Say OK' }] },
      { role: 'model', parts: [{ text: 'OK' }] },
      { role: 'user', parts: [{ text: 'Again' }] },
    ]);
    expect(res.text).toBe('OK');
    expect(res.usage).toEqual({ inputTokens: 7, outputTokens: 2 });
    expect(res.modelVersion).toBe('gemini-2.5-flash-001');
    expect(res.logprobConfidence).toBeUndefined();
  });

  it('embed: text-embedding-004 batch (768-dim native — not the canonical 384)', async () => {
    const values = Array.from({ length: 768 }, () => 0.5);
    fetchMock.mockResolvedValue(jsonResponse(200, { embeddings: [{ values }] }));
    const p = createProviders({ prices: PRICES, apiKeys: { ...KEYS } });
    const out = await p.google.embed!(['hello']);
    const { url, body } = lastCall();
    expect(url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:batchEmbedContents?key=g-key',
    );
    expect((body.requests as unknown[]).length).toBe(1);
    expect(out[0]).toHaveLength(768);
  });
});

describe('openrouter transport', () => {
  it('is OpenAI-shaped with HTTP-Referer header', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        model: 'openai/gpt-4.1-mini',
        choices: [{ message: { content: 'OK' }, logprobs: { content: [{ logprob: 0 }] } }],
        usage: { prompt_tokens: 5, completion_tokens: 1 },
      }),
    );
    const p = createProviders({ prices: PRICES, apiKeys: { ...KEYS } });
    const res = await p.openrouter.complete({
      model: 'openai/gpt-4.1-mini', // native id passthrough (no alias)
      messages: MESSAGES,
      params: { logprobs: true },
    });
    const { url, init, body } = lastCall();
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer sk-or');
    expect(headers['HTTP-Referer']).toBeDefined();
    expect(body.model).toBe('openai/gpt-4.1-mini');
    expect(res.logprobConfidence).toBeCloseTo(1, 9); // exp(0)
    expect(res.modelVersion).toBe('openai/gpt-4.1-mini');
    expect(p.openrouter.embed).toBeUndefined();
  });

  it('sends the exact M1b smoke-live shape (alias or-gpt-mini, "Say OK", max_tokens 20)', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        model: 'openai/gpt-4.1-mini',
        choices: [{ message: { content: 'OK' } }],
        usage: { prompt_tokens: 9, completion_tokens: 1 },
      }),
    );
    const p = createProviders({ prices: PRICES, apiKeys: { ...KEYS } });
    const res = await p.openrouter.complete({
      model: 'or-gpt-mini', // prices.json alias → native id resolution
      messages: [{ role: 'user', content: 'Say OK' }],
      params: { maxTokens: 20 },
    });
    const { url, init, body } = lastCall();
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer sk-or');
    expect(headers['HTTP-Referer']).toBe('https://github.com/potion-ai/potion');
    expect(headers['X-Title']).toBe('Potion');
    expect(body.model).toBe('openai/gpt-4.1-mini'); // alias resolved to native id
    expect(body.messages).toEqual([{ role: 'user', content: 'Say OK' }]);
    expect(body.max_tokens).toBe(20);
    expect(res.text).toBe('OK');
    expect(res.usage).toEqual({ inputTokens: 9, outputTokens: 1 });
  });
});
