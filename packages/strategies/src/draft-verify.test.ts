import { describe, expect, it } from 'vitest';
import type { ChatMessage, PriceTable, StrategyConfig } from '@potion/core';
import { createProviders } from '@potion/providers';
import { createResolver, execute, type ExecContext } from './index.js';

const PRICES: PriceTable = {
  version: '2026-08-04',
  updatedAt: '2026-08-04',
  entries: [
    { alias: 'mock-cheap', provider: 'mock', model: 'mock-cheap-v1', inputPer1M: 0, outputPer1M: 0 },
    { alias: 'mock-frontier', provider: 'mock', model: 'mock-frontier-v1', inputPer1M: 0, outputPer1M: 0 },
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

const STRATEGY: StrategyConfig = {
  type: 'draft-verify',
  draftModel: 'mock-cheap',
  verifierModel: 'mock-frontier',
};

describe('draft-verify', () => {
  it('draft answers; verifier corrects; final = verifier output — golden transcript', async () => {
    const r = await execute(STRATEGY, MESSAGES, makeCtx({ seed: 5 }));
    expect(r.trace.map((t) => t.stage)).toEqual(['draft', 'verify']);
    expect(r.trace[0]).toMatchObject({
      stage: 'draft',
      model: 'mock-cheap',
      text: '[mock:mock-cheap] clear then record output list correct valid detail then clear complete query the valid note detail however concise complete finally the robust first because value edge method finally.',
    });
    expect(r.trace[1]).toMatchObject({
      stage: 'verify',
      model: 'mock-frontier',
      text: '[mock:mock-frontier] the query first data answer the context approach first context step a result valid clear record edge compute first method reason because reason analysis.',
      decision: 'final',
    });
    expect(r.text).toBe(r.trace[1]!.text);
  });

  it('aggregates usage across draft + verify', async () => {
    const r = await execute(STRATEGY, MESSAGES, makeCtx({ seed: 5 }));
    expect(r.usage.inputTokens).toBe(16 + 108); // verify prompt includes the draft
    expect(r.usage.outputTokens).toBe(51 + 44);
    expect(r.usage.latencyMs).toBe(300 + 1800);
  });

  it('is deterministic for a fixed ctx.seed', async () => {
    const a = await execute(STRATEGY, MESSAGES, makeCtx({ seed: 5 }));
    const b = await execute(STRATEGY, MESSAGES, makeCtx({ seed: 5 }));
    expect(a).toEqual(b);
  });
});
