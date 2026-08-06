import { describe, expect, it } from 'vitest';
import type { ChatMessage, PriceTable, StrategyConfig } from '@potion/core';
import { PROTOCOL_MAX_TOKENS } from '@potion/core';
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

// One-line-protocol calls (judge PICK / self-report CONFIDENCE) must carry
// maxTokens: PROTOCOL_MAX_TOKENS — the preflight cost estimator's bound on
// judge/probe output is only real if the calls enforce it. Answer calls stay
// uncapped at this layer (provider DEFAULT_MAX_TOKENS applies on live paths).
describe('protocol-call output caps (estimator bound)', () => {
  function capturingCtx(seed: number) {
    const providers = createProviders({ prices: PRICES });
    const calls: Array<{ model: string; maxTokens: number | undefined }> = [];
    const base = createResolver(providers, PRICES);
    const resolve: ExecContext['resolve'] = (model) => {
      const r = base(model);
      return {
        ...r,
        provider: {
          ...r.provider,
          complete: (req: Parameters<typeof r.provider.complete>[0]) => {
            calls.push({ model: req.model, maxTokens: req.params?.maxTokens });
            return r.provider.complete(req);
          },
        },
      };
    };
    return { ctx: { providers, prices: PRICES, resolve, seed } satisfies ExecContext, calls };
  }

  it('best-of-n: n uncapped candidates + one capped judge', async () => {
    const { ctx, calls } = capturingCtx(11);
    await execute(
      { type: 'best-of-n', model: 'mock-cheap', n: 3, judge: { model: 'mock-frontier', rubric: 'r' } },
      MESSAGES,
      ctx,
    );
    expect(calls.map((c) => c.maxTokens)).toEqual([undefined, undefined, undefined, PROTOCOL_MAX_TOKENS]);
  });

  it('cascade self-report probe is capped; stage answers are not', async () => {
    const { ctx, calls } = capturingCtx(11);
    await execute(
      {
        type: 'cascade',
        stages: [{ model: 'mock-cheap', escalateIf: { confidenceBelow: 0.99 } }, { model: 'mock-frontier' }],
        confidenceMethod: 'self-report-calibrated',
      },
      MESSAGES,
      ctx,
    );
    const probes = calls.filter((c) => c.maxTokens !== undefined);
    expect(probes.length).toBeGreaterThanOrEqual(1);
    for (const p of probes) expect(p.maxTokens).toBe(PROTOCOL_MAX_TOKENS);
    expect(calls[0]!.maxTokens).toBeUndefined(); // stage-0 answer uncapped
  });

  it('ctx.maxOutputTokens caps answer calls; protocol calls still use PROTOCOL_MAX_TOKENS', async () => {
    const { ctx, calls } = capturingCtx(11);
    await execute(
      { type: 'best-of-n', model: 'mock-cheap', n: 2, judge: { model: 'mock-frontier', rubric: 'r' } },
      MESSAGES,
      { ...ctx, maxOutputTokens: 2048 },
    );
    expect(calls.map((c) => c.maxTokens)).toEqual([2048, 2048, PROTOCOL_MAX_TOKENS]);
    // single (direct provider path, not callModel) honors it too
    const single = capturingCtx(11);
    await execute({ type: 'single', model: 'mock-cheap' }, MESSAGES, { ...single.ctx, maxOutputTokens: 2048 });
    expect(single.calls.map((c) => c.maxTokens)).toEqual([2048]);
  });

  it('ensemble judge-pick fusion judge is capped', async () => {
    const { ctx, calls } = capturingCtx(11);
    await execute(
      {
        type: 'ensemble',
        models: ['mock-cheap', 'mock-frontier'],
        fusion: { method: 'judge-pick', judge: { model: 'mock-frontier', rubric: 'r' } },
      },
      MESSAGES,
      ctx,
    );
    expect(calls.map((c) => c.maxTokens)).toEqual([undefined, undefined, PROTOCOL_MAX_TOKENS]);
  });
});
