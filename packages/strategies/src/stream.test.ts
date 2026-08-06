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
  { role: 'user', content: 'Say something deterministic.' },
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

describe("ctx.stream is honored ONLY by type:'single' (SPEC §3)", () => {
  it('single streams chunks that concatenate to the final text', async () => {
    const chunks: string[] = [];
    const r = await execute(
      { type: 'single', model: 'mock-cheap' },
      MESSAGES,
      makeCtx({ seed: 3, stream: (t) => chunks.push(t) }),
    );
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join('')).toBe(r.text);
  });

  it.each([
    [
      {
        type: 'cascade',
        stages: [{ model: 'mock-cheap', escalateIf: { confidenceBelow: 0.9 } }, { model: 'mock-frontier' }],
        confidenceMethod: 'logprob',
      },
    ],
    [{ type: 'best-of-n', model: 'mock-cheap', n: 2, judge: { model: 'mock-frontier' } }],
    [{ type: 'draft-verify', draftModel: 'mock-cheap', verifierModel: 'mock-frontier' }],
    [{ type: 'ensemble', models: ['mock-cheap', 'mock-frontier'], fusion: { method: 'concat-rank' } }],
    [{ type: 'decompose', decomposerModel: 'mock-frontier', routing: { '*': 'mock-cheap' } }],
  ] as const)('%o ignores ctx.stream (no chunks emitted)', async (strategy) => {
    const chunks: string[] = [];
    const r = await execute(
      strategy as StrategyConfig,
      MESSAGES,
      makeCtx({ seed: 3, stream: (t) => chunks.push(t) }),
    );
    expect(chunks).toEqual([]);
    expect(r.text.length).toBeGreaterThan(0);
  });
});
