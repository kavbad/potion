// metered-providers unit tests (post-capstone item 1): per-call spend
// reporting, awaited-before-return ordering, identity memoization (the
// detectProviderMode contract), unknown-alias behavior, and sink-failure
// propagation. Pure fakes — no db, no keys.
import { describe, expect, it } from 'vitest';
import type { PriceTable, ProviderId } from '@potion/core';
import type { CompleteResponse, Provider } from '@potion/providers';
import { detectProviderMode } from './runner.js';
import { meteredProviders, type SpendCall } from './metered-providers.js';

const PRICES: PriceTable = {
  version: 'metered-test-v1',
  updatedAt: '2026-08-09',
  entries: [
    // $2/M in, $10/M out → 1000 in + 500 out = 0.002 + 0.005 = $0.007
    { alias: 'm-a', provider: 'mock', model: 'm-a-v1', inputPer1M: 2.0, outputPer1M: 10.0 },
    { alias: 'or-b', provider: 'openrouter', model: 'or-b-v1', inputPer1M: 4.0, outputPer1M: 20.0 },
  ],
};

function fakeProvider(id: ProviderId, log?: string[]): Provider {
  return {
    id,
    async complete(req): Promise<CompleteResponse> {
      log?.push(`complete:${req.model}`);
      return {
        text: `answer from ${id}`,
        usage: { inputTokens: 1000, outputTokens: 500 },
        latencyMs: 42,
        modelVersion: `${req.model}-resolved`,
      };
    },
  };
}

function recordOf(p: Provider): Record<ProviderId, Provider> {
  return { anthropic: p, openai: p, google: p, openrouter: p, mock: p };
}

describe('meteredProviders', () => {
  it('meters each successful call with provider id, tokens, and rounded cost', async () => {
    const calls: SpendCall[] = [];
    const wrapped = meteredProviders(recordOf(fakeProvider('mock')), PRICES, (c) => {
      calls.push(c);
    });
    const res = await wrapped.mock.complete({ model: 'm-a', messages: [] });
    expect(res.text).toBe('answer from mock');
    expect(calls).toEqual([
      {
        provider: 'mock',
        model: 'm-a',
        resolvedModel: 'm-a-resolved',
        inputTokens: 1000,
        outputTokens: 500,
        costUsd: 0.007,
        latencyMs: 42,
      },
    ]);
  });

  it('awaits the sink BEFORE returning the response (the under-metering bug in miniature)', async () => {
    const order: string[] = [];
    const wrapped = meteredProviders(recordOf(fakeProvider('mock')), PRICES, async () => {
      await new Promise((r) => setTimeout(r, 5));
      order.push('sink');
    });
    await wrapped.mock.complete({ model: 'm-a', messages: [] }).then(() => order.push('returned'));
    expect(order).toEqual(['sink', 'returned']);
  });

  it('preserves reference identity across keys — a mock set stays mock', () => {
    const one = fakeProvider('mock');
    const wrapped = meteredProviders(recordOf(one), PRICES, () => {});
    // All five keys were the SAME instance → all five wrapped keys are too.
    expect(wrapped.anthropic).toBe(wrapped.mock);
    expect(wrapped.openrouter).toBe(wrapped.mock);
    expect(detectProviderMode(wrapped)).toBe('mock');
  });

  it('distinct underlying instances stay distinct — a live set stays live', () => {
    const live = {
      ...recordOf(fakeProvider('mock')),
      openrouter: fakeProvider('openrouter'),
    };
    const wrapped = meteredProviders(live, PRICES, () => {});
    expect(wrapped.openrouter).not.toBe(wrapped.mock);
    expect(detectProviderMode(wrapped)).toBe('live');
  });

  it('scopes price lookup to the provider id', async () => {
    const calls: SpendCall[] = [];
    const live = {
      ...recordOf(fakeProvider('mock')),
      openrouter: fakeProvider('openrouter'),
    };
    const wrapped = meteredProviders(live, PRICES, (c) => {
      calls.push(c);
    });
    await wrapped.openrouter.complete({ model: 'or-b', messages: [] });
    // $4/M in, $20/M out → 0.004 + 0.010
    expect(calls[0]!.costUsd).toBe(0.014);
    expect(calls[0]!.provider).toBe('openrouter');
  });

  it('meters tokens with costUsd 0 when no price entry matches (never throws on bookkeeping)', async () => {
    const calls: SpendCall[] = [];
    const wrapped = meteredProviders(recordOf(fakeProvider('mock')), PRICES, (c) => {
      calls.push(c);
    });
    await wrapped.mock.complete({ model: 'unlisted-model', messages: [] });
    expect(calls[0]).toMatchObject({ costUsd: 0, inputTokens: 1000, outputTokens: 500 });
  });

  it('does not meter failed calls (no usage returned, nothing to bill) and rethrows', async () => {
    const calls: SpendCall[] = [];
    const failing: Provider = {
      id: 'mock',
      async complete() {
        throw new Error('provider down');
      },
    };
    const wrapped = meteredProviders(recordOf(failing), PRICES, (c) => {
      calls.push(c);
    });
    await expect(wrapped.mock.complete({ model: 'm-a', messages: [] })).rejects.toThrow(
      'provider down',
    );
    expect(calls).toHaveLength(0);
  });

  it('a sink failure fails the call — spend must not proceed invisibly', async () => {
    const wrapped = meteredProviders(recordOf(fakeProvider('mock')), PRICES, () => {
      throw new Error('spend journal unavailable');
    });
    await expect(wrapped.mock.complete({ model: 'm-a', messages: [] })).rejects.toThrow(
      'spend journal unavailable',
    );
  });

  it('passes embed through and leaves it undefined when absent', async () => {
    const withEmbed: Provider = {
      ...fakeProvider('mock'),
      async embed(texts) {
        return texts.map(() => [1, 2, 3]);
      },
    };
    const wrapped = meteredProviders(recordOf(withEmbed), PRICES, () => {});
    expect(await wrapped.mock.embed!(['x'])).toEqual([[1, 2, 3]]);
    const without = meteredProviders(recordOf(fakeProvider('mock')), PRICES, () => {});
    expect(without.mock.embed).toBeUndefined();
  });
});
