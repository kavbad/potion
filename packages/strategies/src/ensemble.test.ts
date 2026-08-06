import { describe, expect, it } from 'vitest';
import type { ChatMessage, PriceTable, StrategyConfig } from '@potion/core';
import { createProviders } from '@potion/providers';
import { createResolver, execute, type ExecContext } from './index.js';

const PRICES: PriceTable = {
  version: '2026-08-04',
  updatedAt: '2026-08-04',
  entries: [
    { alias: 'mock-cheap', provider: 'mock', model: 'mock-cheap-v1', inputPer1M: 0, outputPer1M: 0 },
    { alias: 'mock-mid', provider: 'mock', model: 'mock-mid-v1', inputPer1M: 0, outputPer1M: 0 },
    { alias: 'mock-frontier', provider: 'mock', model: 'mock-frontier-v1', inputPer1M: 0, outputPer1M: 0 },
    { alias: 'mock-judge', provider: 'mock', model: 'mock-judge-v1', inputPer1M: 0, outputPer1M: 0 },
  ],
};

const MESSAGES: ChatMessage[] = [
  { role: 'system', content: 'You are terse.' },
  { role: 'user', content: 'Summarize the plot of Hamlet briefly.' },
];

function makeCtx(extra?: Partial<ExecContext>): ExecContext {
  const providers = createProviders({ prices: PRICES });
  return {
    providers,
    prices: PRICES,
    resolve: createResolver(providers, PRICES),
    ...extra,
  };
}

const MODELS = ['mock-cheap', 'mock-mid', 'mock-frontier'];

describe("ensemble fusion: 'judge-pick'", () => {
  const STRATEGY: StrategyConfig = {
    type: 'ensemble',
    models: MODELS,
    fusion: { method: 'judge-pick', judge: { model: 'mock-judge' } },
  };

  it('runs all models in parallel, judge picks the winner — golden transcript', async () => {
    const r = await execute(STRATEGY, MESSAGES, makeCtx({ seed: 21 }));
    expect(r.trace.map((t) => t.stage)).toEqual([
      'candidate-0',
      'candidate-1',
      'candidate-2',
      'fusion-judge',
    ]);
    const judge = r.trace[3]!;
    expect(judge).toMatchObject({ model: 'mock-judge', text: 'PICK: 0', decision: 'judge-pick:0' });
    expect(r.text).toBe(r.trace[0]!.text); // candidate 0 (mock-cheap) wins
    expect(r.text).toBe(
      '[mock:mock-cheap] valid however step edge summary analysis assume return clear therefore consider field consider output context first item simple result edge then data.',
    );
    // parallel fan-out: latency = max(candidates) + judge = 1800 + 900
    expect(r.usage.latencyMs).toBe(2700);
    // Judge prompt tokens grew 193 → 313 (M2-security DATA-block hardening;
    // mock token rule is ceil(chars/4)). Candidates are unchanged.
    expect(r.usage.inputTokens).toBe(16 * 3 + 313);
  });

  it('is deterministic for a fixed ctx.seed', async () => {
    const a = await execute(STRATEGY, MESSAGES, makeCtx({ seed: 21 }));
    const b = await execute(STRATEGY, MESSAGES, makeCtx({ seed: 21 }));
    expect(a).toEqual(b);
  });

  it('throws when fusion.judge is missing', async () => {
    await expect(
      execute(
        { type: 'ensemble', models: MODELS, fusion: { method: 'judge-pick' } },
        MESSAGES,
        makeCtx({ seed: 21 }),
      ),
    ).rejects.toThrow(/requires fusion\.judge/);
  });
});

describe("ensemble fusion: 'concat-rank'", () => {
  it('ranks deterministically (confidence primary, length tiebreak) and concatenates with headers', async () => {
    const r = await execute(
      { type: 'ensemble', models: MODELS, fusion: { method: 'concat-rank' } },
      MESSAGES,
      makeCtx({ seed: 21 }),
    );
    // Documented heuristic: score = logprobConfidence + min(len,10000)/1e6, desc.
    // Seed 21 confidences: frontier 0.73140 > cheap 0.72819 > mid 0.72737 → order [2,0,1].
    const fusion = r.trace[3]!;
    expect(fusion.stage).toBe('fusion');
    expect(fusion.decision).toBe('concat-rank:order=[2,0,1]');
    expect(r.text).toBe(
      '## mock-frontier (rank 1)\n' +
        r.trace[2]!.text +
        '\n\n## mock-cheap (rank 2)\n' +
        r.trace[0]!.text +
        '\n\n## mock-mid (rank 3)\n' +
        r.trace[1]!.text,
    );
    // no judge call: usage = candidates only
    expect(r.usage.inputTokens).toBe(48);
    expect(r.usage.latencyMs).toBe(1800); // pure parallel max
  });
});
