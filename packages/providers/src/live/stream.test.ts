import { describe, expect, it } from 'vitest';
import type { PriceTable, Tool } from '@potion/core';
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

const prices: PriceTable = { version: 't', updatedAt: '2026-01-01T00:00:00Z', entries: [{ alias: 'or-mid', provider: 'openrouter', model: 'vendor/mid', inputPer1M: 1, outputPer1M: 2 }] };

describe('openAiCompatibleCompleteStream', () => {
  it('relays deltas in order as they arrive and keeps the final chunk’s usage and billed cost', async () => {
    const seen: string[] = [];
    let sentBody: Record<string, unknown> = {};
    const fetchFn: typeof fetch = async (_url, init) => {
      sentBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return sse([
        JSON.stringify({ model: 'vendor/mid-2026', choices: [{ delta: { role: 'assistant' } }] }),
        JSON.stringify({ choices: [{ delta: { content: 'Hel' } }] }),
        JSON.stringify({ choices: [{ delta: { content: 'lo' } }] }),
        JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
        JSON.stringify({ choices: [], usage: { prompt_tokens: 7, completion_tokens: 2, cost: 0.00042 } }),
        '[DONE]',
      ]);
    };
    const res = await openAiCompatibleCompleteStream('openrouter', 'http://x', {}, { apiKey: 'k', prices, fetchFn }, { model: 'or-mid', messages: [{ role: 'user', content: 'hi' }] }, (t) => seen.push(t));
    expect(seen).toEqual(['Hel', 'lo']);
    expect(res.text).toBe('Hello');
    expect(res.usage).toMatchObject({ inputTokens: 7, outputTokens: 2, providerCostUsd: 0.00042 });
    expect(res.modelVersion).toBe('vendor/mid-2026');
    expect(sentBody.stream).toBe(true);
    expect(sentBody.stream_options).toEqual({ include_usage: true });
    expect(sentBody.usage).toEqual({ include: true });
  });

  it('a non-2xx is a provider error, not a stream', async () => {
    const fetchFn: typeof fetch = async () => new Response('nope', { status: 503 });
    await expect(openAiCompatibleCompleteStream('openrouter', 'http://x', {}, { apiKey: 'k', prices, fetchFn }, { model: 'or-mid', messages: [] }, () => undefined)).rejects.toThrow(/HTTP 503/);
  });
});

describe('createProviders exposes the stream', () => {
  it('openrouter and openai carry completeStream through the lazy wrapper and resilient()', async () => {
    const { createProviders } = await import('../factory.js');
    const providers = createProviders({ prices, apiKeys: { openrouter: 'k', openai: 'k' } });
    expect(typeof providers.openrouter.completeStream).toBe('function');
    expect(typeof providers.openai.completeStream).toBe('function');
    expect(providers.anthropic.completeStream).toBeUndefined();
  });
});

describe('tool-call fragments over the stream', () => {
  it('are assembled by index into whole calls on the response, and the tools are sent', async () => {
    let sentBody: Record<string, unknown> = {};
    const fetchFn: typeof fetch = async (_url, init) => {
      sentBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return sse([
        JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '' } }] } }] }),
        JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"city":' } }] } }] }),
        JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 1, id: 'call_2', type: 'function', function: { name: 'get_time', arguments: '{}' } }] } }] }),
        JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"Paris"}' } }] } }] }),
        JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
        JSON.stringify({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 9 } }),
        '[DONE]',
      ]);
    };
    const seen: string[] = [];
    const tools: Tool[] = [{ type: 'function', function: { name: 'get_weather', parameters: {} } }];
    const res = await openAiCompatibleCompleteStream('openrouter', 'http://x', {}, { apiKey: 'k', prices, fetchFn }, { model: 'or-mid', messages: [], params: { tools, tool_choice: 'auto' } }, (t) => seen.push(t));
    expect(sentBody.tools).toEqual(tools);
    expect(sentBody.tool_choice).toBe('auto');
    expect(seen).toEqual([]);
    expect(res.text).toBe('');
    expect(res.toolCalls).toEqual([
      { id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } },
      { id: 'call_2', type: 'function', function: { name: 'get_time', arguments: '{}' } },
    ]);
  });
});
