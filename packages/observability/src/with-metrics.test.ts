// withMetrics contract tests (SPEC §12.3): the proxy is behavior-identical
// (same returns/throws/embed presence) while observing success AND error
// paths, with cost computed via the existing costOf helper.
import { describe, expect, it } from 'vitest';
import type { PriceTable, ProviderId } from '@potion/core';
import type { CompleteRequest, CompleteResponse, Provider } from '@potion/providers';
import { NoopMetrics, createMetrics, withMetrics, type Metrics } from './index.js';

const PRICES: PriceTable = {
  version: 'test',
  updatedAt: '2026-08-04T00:00:00Z',
  entries: [
    {
      alias: 'mock-mid',
      provider: 'mock',
      model: 'mock-mid-v1',
      inputPer1M: 1_000_000, // $1 per 1M input tokens → easy math
      outputPer1M: 2_000_000,
    },
  ],
};

function fakeProvider(overrides: Partial<Provider> = {}): Provider {
  return {
    id: 'mock',
    complete: async (req: CompleteRequest): Promise<CompleteResponse> => ({
      text: `[mock:${req.model}] ok`,
      usage: { inputTokens: 100, outputTokens: 50 },
      latencyMs: 300,
      modelVersion: 'mock-mid-v1',
    }),
    ...overrides,
  };
}

/** withMetrics takes the FULL provider set. These tests exercise one
 * transport at a time, so every slot holds it and the test reads back the
 * slot matching the provider's own id. */
function setOf(provider: Provider): Record<ProviderId, Provider> {
  return {
    anthropic: provider,
    openai: provider,
    google: provider,
    openrouter: provider,
    mock: provider,
  };
}

/** A Metrics that records provider-call observations; the rest of the
 * contract no-ops (the proxy calls nothing else). */
function recordingMeter(calls: unknown[]): Metrics {
  return {
    incRequest: () => undefined,
    observeProviderCall: (o) => {
      calls.push(o);
    },
    observeFrontierDecision: () => undefined,
    setBreakerState: () => undefined,
  };
}

const REQ: CompleteRequest = { model: 'mock-mid', messages: [{ role: 'user', content: 'hi' }] };

describe('withMetrics', () => {
  it('returns the underlying response unchanged and observes duration+cost', async () => {
    const underlying = fakeProvider();
    const meter = createMetrics();
    const wrapped = withMetrics(setOf(underlying), meter, { prices: PRICES });
    const res = await wrapped.mock.complete(REQ);
    // Behavior-identical: the exact response object comes back.
    expect(res.text).toBe('[mock:mock-mid] ok');
    expect(res.usage).toEqual({ inputTokens: 100, outputTokens: 50 });
    expect(wrapped.mock.id).toBe('mock');
    const text = await meter.render();
    expect(text).toContain(
      'potion_provider_calls_total{provider="mock",model="mock-mid",error="none"} 1',
    );
    expect(text).toContain(
      'potion_provider_call_duration_ms_count{provider="mock",model="mock-mid"} 1',
    );
    // cost = (100 in * $1M/1M + 50 out * $2M/1M) / 1M = $200
    expect(text).toContain(
      'potion_provider_call_cost_usd_total{provider="mock",model="mock-mid"} 200',
    );
  });

  it('rethrows the SAME error and records the error label', async () => {
    const boom = new Error('upstream exploded');
    const underlying = fakeProvider({
      complete: async () => {
        throw boom;
      },
    });
    const meter = createMetrics();
    const wrapped = withMetrics(setOf(underlying), meter, { prices: PRICES });
    const caught = await wrapped.mock.complete(REQ).catch((e: unknown) => e);
    expect(caught).toBe(boom);
    const text = await meter.render();
    expect(text).toContain(
      'potion_provider_calls_total{provider="mock",model="mock-mid",error="Error"} 1',
    );
    // Failures record no duration/cost samples.
    expect(text).not.toContain('potion_provider_call_duration_ms_count');
  });

  it('keeps embed undefined when the provider has none', () => {
    const meter = createMetrics();
    const wrapped = withMetrics(setOf(fakeProvider()), meter);
    expect(wrapped.mock.embed).toBeUndefined();
  });

  it('wraps embed when present (success + error paths)', async () => {
    const meter = createMetrics();
    const okEmbed = async (texts: string[]): Promise<number[][]> => texts.map(() => [1, 2, 3]);
    const wrapped = withMetrics(setOf(fakeProvider({ embed: okEmbed })), meter);
    const vectors = await wrapped.mock.embed!(['a', 'b']);
    expect(vectors).toEqual([
      [1, 2, 3],
      [1, 2, 3],
    ]);
    const boom = new Error('embed failed');
    const failEmbed = async (): Promise<number[][]> => {
      throw boom;
    };
    const wrapped2 = withMetrics(setOf(fakeProvider({ embed: failEmbed })), meter);
    const caught = await wrapped2.mock.embed!(['x']).catch((e: unknown) => e);
    expect(caught).toBe(boom);
    const text = await meter.render();
    expect(text).toContain('potion_provider_calls_total{provider="mock",model="embed",error="none"} 1');
    expect(text).toContain('potion_provider_calls_total{provider="mock",model="embed",error="Error"} 1');
  });

  it('records zero cost when no price entry matches (still observes the call)', async () => {
    const meter = createMetrics();
    const wrapped = withMetrics(setOf(fakeProvider()), meter, { prices: PRICES });
    await wrapped.mock.complete({ ...REQ, model: 'unpriced-model' });
    const text = await meter.render();
    expect(text).toContain(
      'potion_provider_calls_total{provider="mock",model="unpriced-model",error="none"} 1',
    );
    expect(text).toContain(
      'potion_provider_call_cost_usd_total{provider="mock",model="unpriced-model"} 0',
    );
  });

  it('works without a price table (cost 0)', async () => {
    const meter = createMetrics();
    const wrapped = withMetrics(setOf(fakeProvider()), meter);
    await wrapped.mock.complete(REQ);
    const text = await meter.render();
    expect(text).toContain(
      'potion_provider_calls_total{provider="mock",model="mock-mid",error="none"} 1',
    );
  });
});

describe('withMetrics keeps the stream (2026-08-22)', () => {
  it('forwards completeStream, relays tokens, and meters it once', async () => {
    const calls: unknown[] = [];
    const meter = recordingMeter(calls);
    const base: Provider = {
      id: 'openrouter',
      complete: async () => { throw new Error('not used'); },
      completeStream: async (_req: CompleteRequest, onToken: (t: string) => void) => {
        onToken('a'); onToken('b');
        return { text: 'ab', usage: { inputTokens: 1, outputTokens: 2 }, latencyMs: 5, modelVersion: 'm' };
      },
    };
    const wrapped = withMetrics(setOf(base), meter);
    const seen: string[] = [];
    const res = await wrapped.openrouter.completeStream!({ model: 'x', messages: [] }, (t) => seen.push(t));
    expect(seen).toEqual(['a', 'b']);
    expect(res.text).toBe('ab');
    expect(calls).toHaveLength(1);
    expect(wrapped.openrouter.complete).toBeTypeOf('function');
  });
  it('leaves completeStream absent when the transport has none', () => {
    const streamless: Provider = {
      id: 'mock',
      complete: async () => ({ text: '', usage: { inputTokens: 0, outputTokens: 0 }, latencyMs: 0, modelVersion: '' }),
    };
    const wrapped = withMetrics(setOf(streamless), new NoopMetrics());
    expect(wrapped.mock.completeStream).toBeUndefined();
  });
});
