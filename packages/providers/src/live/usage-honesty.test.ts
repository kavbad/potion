// Usage honesty (2026-09-01, the or-gemini-flash incident): a transport must
// never fabricate silent zero usage. During the incident window the route
// returned text while usage said completion_tokens 0 / cost 0 — the old
// parse forwarded the zeros verbatim, which billed real spend at $0, made
// the serving degeneracy rollup read text-bearing answers as empty
// completions, and corrupted every counterfactual computed from costUsd.
import { describe, expect, it } from 'vitest';
import { openAiCompatibleComplete, openAiCompatibleCompleteStream } from './openai.js';

const prices = { version: 't', entries: [{ alias: 'or-mid', provider: 'openrouter', model: 'vendor/mid', inputPer1M: 1, outputPer1M: 2 }] } as never;

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

function completeWith(body: unknown) {
  const fetchFn = (async () => jsonResponse(body)) as unknown as typeof fetch;
  return openAiCompatibleComplete(
    'openrouter',
    'http://x',
    {},
    { apiKey: 'k', prices, fetchFn } as never,
    { model: 'or-mid', messages: [{ role: 'user', content: 'hi there' }] },
  );
}

describe('honest usage on the JSON path', () => {
  it('a missing usage block with a text answer becomes a labeled estimate, never silent zeros', async () => {
    const res = await completeWith({ model: 'vendor/mid', choices: [{ message: { content: 'a'.repeat(80) }, finish_reason: 'stop' }] });
    expect(res.text).toHaveLength(80);
    expect(res.usage.usageEstimated).toBe(true);
    expect(res.usage.outputTokens).toBe(20); // chars/4
    expect(res.usage.inputTokens).toBeGreaterThan(0);
    expect(res.usage.providerCostUsd).toBeUndefined();
  });

  it("completion_tokens 0 against a text answer is contradicted: tokens re-estimated, the $0 'billed' cost dropped", async () => {
    const res = await completeWith({
      model: 'vendor/mid',
      choices: [{ message: { content: 'It is 18°C with light rain in Paris.' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 105, completion_tokens: 0, cost: 0 },
    });
    expect(res.usage.usageEstimated).toBe(true);
    expect(res.usage.outputTokens).toBeGreaterThan(0);
    expect(res.usage.inputTokens).toBe(105); // the reported prompt count survives
    expect(res.usage.providerCostUsd).toBeUndefined(); // $0 billed for text is part of the contradiction
  });

  it('a POSITIVE billed cost survives even when its token counts are garbage — the provider ledger beats the model', async () => {
    const res = await completeWith({
      model: 'vendor/mid',
      choices: [{ message: { content: 'answer text' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 50, completion_tokens: 0, cost: 0.00081 },
    });
    expect(res.usage.usageEstimated).toBe(true);
    expect(res.usage.providerCostUsd).toBe(0.00081);
  });

  it('a tool-call answer with completion_tokens 0 is contradicted too', async () => {
    const res = await completeWith({
      model: 'vendor/mid',
      choices: [{ message: { content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } }] }, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 86, completion_tokens: 0, cost: 0 },
    });
    expect(res.usage.usageEstimated).toBe(true);
    expect(res.usage.outputTokens).toBeGreaterThan(0);
  });

  it('a genuinely empty completion with reported zeros stays verbatim — no flag, no estimate', async () => {
    const res = await completeWith({
      model: 'vendor/mid',
      choices: [{ message: { content: '' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 105, completion_tokens: 0, cost: 0.0000315 },
    });
    expect(res.usage.usageEstimated).toBeUndefined();
    expect(res.usage.outputTokens).toBe(0);
    expect(res.usage.providerCostUsd).toBe(0.0000315);
  });

  it('normal reported usage passes through untouched', async () => {
    const res = await completeWith({
      model: 'vendor/mid',
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 3, cost: 0.00002 },
    });
    expect(res.usage).toMatchObject({ inputTokens: 10, outputTokens: 3, providerCostUsd: 0.00002 });
    expect(res.usage.usageEstimated).toBeUndefined();
  });
});

describe('honest usage on the stream path', () => {
  function sseRaw(raw: string): Response {
    const enc = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode(raw));
        c.close();
      },
    });
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }

  it('the tail flush: a final usage-only event with NO trailing newline is still parsed', async () => {
    // The stream closes right after the usage event — no trailing newline,
    // no [DONE]. The old parser discarded the buffered tail and fabricated
    // zero usage for a fully-billed completion.
    const raw =
      `data: ${JSON.stringify({ model: 'vendor/mid', choices: [{ delta: { content: 'Hello' } }] })}\n\n` +
      `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 7, completion_tokens: 2, cost: 0.00042 } })}`;
    const fetchFn = (async () => sseRaw(raw)) as unknown as typeof fetch;
    const res = await openAiCompatibleCompleteStream(
      'openrouter', 'http://x', {}, { apiKey: 'k', prices, fetchFn } as never,
      { model: 'or-mid', messages: [{ role: 'user', content: 'hi' }] }, () => undefined,
    );
    expect(res.text).toBe('Hello');
    expect(res.usage).toMatchObject({ inputTokens: 7, outputTokens: 2, providerCostUsd: 0.00042 });
    expect(res.usage.usageEstimated).toBeUndefined();
  });

  it('a stream that never delivers usage yields a labeled estimate for the accumulated text', async () => {
    const raw =
      `data: ${JSON.stringify({ model: 'vendor/mid', choices: [{ delta: { content: 'stream' } }] })}\n\n` +
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'ed answer' }, finish_reason: 'stop' }] })}\n\n` +
      'data: [DONE]\n\n';
    const fetchFn = (async () => sseRaw(raw)) as unknown as typeof fetch;
    const res = await openAiCompatibleCompleteStream(
      'openrouter', 'http://x', {}, { apiKey: 'k', prices, fetchFn } as never,
      { model: 'or-mid', messages: [{ role: 'user', content: 'hi' }] }, () => undefined,
    );
    expect(res.text).toBe('streamed answer');
    expect(res.usage.usageEstimated).toBe(true);
    expect(res.usage.outputTokens).toBe(Math.ceil('streamed answer'.length / 4));
  });
});
