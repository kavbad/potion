import { describe, expect, it } from 'vitest';
import type { ChatMessage, PriceTable, StrategyConfig } from '@potion/core';
import { createProviders } from '@potion/providers';
import { createResolver, execute, parsePick, type ExecContext } from './index.js';

const PRICES: PriceTable = {
  version: '2026-08-04',
  updatedAt: '2026-08-04',
  entries: [
    { alias: 'mock-cheap', provider: 'mock', model: 'mock-cheap-v1', inputPer1M: 0, outputPer1M: 0 },
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

const STRATEGY: StrategyConfig = {
  type: 'best-of-n',
  model: 'mock-cheap',
  n: 3,
  judge: { model: 'mock-judge', rubric: 'Prefer correctness.' },
};

describe('best-of-n', () => {
  it('runs n seeded candidates + one judge call; judge pick is the result — golden transcript', async () => {
    const r = await execute(STRATEGY, MESSAGES, makeCtx({ seed: 11 }));
    expect(r.trace.map((t) => t.stage)).toEqual([
      'candidate-0',
      'candidate-1',
      'candidate-2',
      'judge',
    ]);
    // Deterministic candidates (seeds 11, 12, 13):
    expect(r.trace[0]!.text).toBe(
      '[mock:mock-cheap] example field list direct data answer example field valid edge direct compute query response given therefore because check step list value field list compute.',
    );
    expect(r.trace[1]!.text).toBe(
      '[mock:mock-cheap] answer list reason given the response table item complete a context consider example concise table example robust method.',
    );
    expect(r.trace[2]!.text).toBe(
      '[mock:mock-cheap] assume answer result a the output assume item analysis table concise however given item step list field value table return table consider output concise check.',
    );
    // Judge (seed 14) deterministically answers `PICK: 1`:
    expect(r.trace[3]).toMatchObject({
      stage: 'judge',
      model: 'mock-judge',
      text: 'PICK: 1',
      decision: 'pick:1',
    });
    // Result is the picked candidate's text:
    expect(r.text).toBe(r.trace[1]!.text);
  });

  it('aggregates usage across all candidates + judge; fan-out latency is max + judge', async () => {
    const r = await execute(STRATEGY, MESSAGES, makeCtx({ seed: 11 }));
    // Judge prompt tokens grew 193 → 313 (M2-security: DATA-block delimiters +
    // injection framing around the untrusted task/candidates; mock token rule
    // is ceil(chars/4)). Candidates are unchanged.
    expect(r.usage.inputTokens).toBe(16 * 3 + 313);
    expect(r.usage.outputTokens).toBe(44 + 35 + 45 + 2);
    expect(r.usage.costUsd).toBe(0); // mock entries are $0
    expect(r.usage.latencyMs).toBe(300 + 900); // max(candidates) + judge
  });

  it('is deterministic for a fixed ctx.seed', async () => {
    const a = await execute(STRATEGY, MESSAGES, makeCtx({ seed: 11 }));
    const b = await execute(STRATEGY, MESSAGES, makeCtx({ seed: 11 }));
    expect(a).toEqual(b);
  });

  it('parsePick validates range and falls back to 0 on garbage', () => {
    expect(parsePick('PICK: 2', 3)).toEqual({ index: 2, parsed: true });
    expect(parsePick('pick: 0', 3)).toEqual({ index: 0, parsed: true });
    expect(parsePick('PICK: 3', 3)).toEqual({ index: 0, parsed: false }); // out of range
    expect(parsePick('no pick here', 3)).toEqual({ index: 0, parsed: false });
  });

  it('rejects n < 1', async () => {
    await expect(
      execute(
        { type: 'best-of-n', model: 'mock-cheap', n: 0, judge: { model: 'mock-judge' } },
        MESSAGES,
        makeCtx({ seed: 1 }),
      ),
    ).rejects.toThrow(/n >= 1/);
  });
});
