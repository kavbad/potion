import { describe, expect, it } from 'vitest';
import { openAiCompatibleCompleteStream } from './openai.js';

function sse(lines: string[]): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const l of lines) c.enqueue(enc.encode(`data: ${l}\n\n`));
      c.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const prices = { version: 't', entries: [{ alias: 'or-mid', provider: 'openrouter', model: 'vendor/mid', inputPer1M: 1, outputPer1M: 2 }] } as never;

describe('openAiCompatibleCompleteStream', () => {
  it('relays deltas in order as they arrive and keeps the final chunk’s usage and billed cost', async () => {
    const seen: string[] = [];
    let sentBody: Record<string, unknown> = {};
    const fetchFn = (async (_url: string, init?: RequestInit) => {
      sentBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return sse([
        JSON.stringify({ model: 'vendor/mid-2026', choices: [{ delta: { role: 'assistant' } }] }),
        JSON.stringify({ choices: [{ delta: { content: 'Hel' } }] }),
        JSON.stringify({ choices: [{ delta: { content: 'lo' } }] }),
        JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
        JSON.stringify({ choices: [], usage: { prompt_tokens: 7, completion_tokens: 2, cost: 0.00042 } }),
        '[DONE]',
      ]);
    }) as unknown as typeof fetch;
    const res = await openAiCompatibleCompleteStream('openrouter', 'http://x', {}, { apiKey: 'k', prices, fetchFn } as never, { model: 'or-mid', messages: [{ role: 'user', content: 'hi' }] }, (t) => seen.push(t));
    expect(seen).toEqual(['Hel', 'lo']);
    expect(res.text).toBe('Hello');
    expect(res.usage).toMatchObject({ inputTokens: 7, outputTokens: 2, providerCostUsd: 0.00042 });
    expect(res.modelVersion).toBe('vendor/mid-2026');
    expect(sentBody.stream).toBe(true);
    expect(sentBody.stream_options).toEqual({ include_usage: true });
    expect(sentBody.usage).toEqual({ include: true });
  });

  it('a non-2xx is a provider error, not a stream', async () => {
    const fetchFn = (async () => new Response('nope', { status: 503 })) as unknown as typeof fetch;
    await expect(openAiCompatibleCompleteStream('openrouter', 'http://x', {}, { apiKey: 'k', prices, fetchFn } as never, { model: 'or-mid', messages: [] }, () => undefined)).rejects.toThrow(/HTTP 503/);
  });
});

describe('createProviders exposes the stream', () => {
  it('openrouter and openai carry completeStream through the lazy wrapper and resilient()', async () => {
    const { createProviders } = await import('../factory.js');
    const providers = createProviders({ prices, apiKeys: { openrouter: 'k', openai: 'k' } } as never);
    expect(typeof providers.openrouter.completeStream).toBe('function');
    expect(typeof providers.openai.completeStream).toBe('function');
    expect(providers.anthropic.completeStream).toBeUndefined();
  });
});
