import { describe, expect, it } from 'vitest';
import type { ChatMessage, PriceTable, StrategyConfig } from '@potion/core';
import { createProviders } from '@potion/providers';
import { createResolver, execute, type ExecContext } from './index.js';

const PRICES: PriceTable = {
  version: '2026-08-04',
  updatedAt: '2026-08-04',
  entries: [
    { alias: 'sonnet-class', provider: 'anthropic', model: 'claude-sonnet-4-5-20250929', inputPer1M: 3, outputPer1M: 15 },
    { alias: 'mock-cheap', provider: 'mock', model: 'mock-cheap-v1', inputPer1M: 0, outputPer1M: 0 },
    { alias: 'mock-frontier', provider: 'mock', model: 'mock-frontier-v1', inputPer1M: 0, outputPer1M: 0 },
  ],
};

function makeCtx(extra?: Partial<ExecContext>): ExecContext {
  const providers = createProviders({ prices: PRICES });
  return {
    providers,
    prices: PRICES,
    resolve: createResolver(providers, PRICES),
    ...extra,
  };
}

const MESSAGES: ChatMessage[] = [
  { role: 'system', content: 'You are terse.' },
  { role: 'user', content: 'Summarize the plot of Hamlet briefly.' },
];

describe("execute type:'single'", () => {
  it('runs one call and returns text + trace + usage', async () => {
    const strategy: StrategyConfig = { type: 'single', model: 'mock-frontier' };
    const result = await execute(strategy, MESSAGES, makeCtx({ seed: 7 }));
    expect(result.text.startsWith('[mock:mock-frontier] ')).toBe(true);
    expect(result.trace).toHaveLength(1);
    expect(result.trace[0]?.stage).toBe('single');
    expect(result.trace[0]?.model).toBe('mock-frontier');
    expect(result.trace[0]?.text).toBe(result.text);
    expect(result.trace[0]?.confidence).toBeGreaterThanOrEqual(0.5);
    expect(result.usage.latencyMs).toBe(1800);
  });

  it('is deterministic for a fixed ctx.seed', async () => {
    const strategy: StrategyConfig = { type: 'single', model: 'mock-frontier' };
    const a = await execute(strategy, MESSAGES, makeCtx({ seed: 7 }));
    const b = await execute(strategy, MESSAGES, makeCtx({ seed: 7 }));
    expect(a).toEqual(b);
  });

  it('honors ctx.stream: chunks concatenate to the final text', async () => {
    const chunks: string[] = [];
    const strategy: StrategyConfig = { type: 'single', model: 'mock-cheap' };
    const result = await execute(strategy, MESSAGES, makeCtx({ seed: 3, stream: (t) => chunks.push(t) }));
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join('')).toBe(result.text);
  });

  // M3 #25 (OpenAI parity): ctx.params tools/toolChoice are forwarded
  // UNMODIFIED to the provider and provider toolCalls surface on the result.
  it('forwards ctx.params tools/toolChoice and surfaces toolCalls', async () => {
    const tools = [
      { type: 'function' as const, function: { name: 'get_weather', parameters: { type: 'object' } } },
    ];
    const strategy: StrategyConfig = { type: 'single', model: 'mock-frontier' };
    const result = await execute(strategy, MESSAGES, makeCtx({
      seed: 7,
      params: { tools, toolChoice: 'auto' },
    }));
    expect(result.text).toBe(''); // mock tool-call echo answers with a call, not prose
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls![0]!.function.name).toBe('get_weather');
    expect(result.toolCalls![0]!.id).toMatch(/^call_[0-9a-f]{8}$/);
  });

  it('cost accounting matches hand-computed totals', async () => {
    // mock entries are $0 → cost is exactly 0
    const r1 = await execute({ type: 'single', model: 'mock-frontier' }, MESSAGES, makeCtx({ seed: 7 }));
    expect(r1.usage.costUsd).toBe(0);
    // hand-computed against a priced entry: mock provider answers regardless of
    // model name, so we can drive usage through 'sonnet-class' prices.
    const providers = createProviders({ prices: PRICES });
    const res = await providers.mock.complete({ model: 'sonnet-class', messages: MESSAGES, params: { seed: 7 } });
    const expected = (res.usage.inputTokens * 3 + res.usage.outputTokens * 15) / 1_000_000;
    const r2 = await execute({ type: 'single', model: 'sonnet-class' }, MESSAGES, {
      providers: { ...providers, anthropic: providers.mock }, // route alias through mock transport
      prices: PRICES,
      resolve: createResolver({ ...providers, anthropic: providers.mock }, PRICES),
      seed: 7,
    });
    expect(r2.usage.costUsd).toBeCloseTo(expected, 6);
  });
});

describe('createResolver', () => {
  it('resolves aliases and native ids, rejects unknown models', () => {
    const providers = createProviders({ prices: PRICES });
    const resolve = createResolver(providers, PRICES);
    expect(resolve('mock-cheap').provider.id).toBe('mock');
    expect(resolve('mock-cheap-v1').entry.alias).toBe('mock-cheap');
    expect(() => resolve('no-such-model')).toThrow(/unknown model/);
  });
});
