// Serve-time judge scoring tests (G0.1): the guarantee loop's quality signal
// is a REAL llm-judge call — deterministic on the mock judge fixture,
// protocol-capped, labeled, spend-accounted. Never Jaccard.
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import type { PriceTable, Provider, ProviderId } from '@potion/core';
import { PROTOCOL_MAX_TOKENS } from '@potion/core';
import { createMockProvider, loadPrices } from '@potion/providers';
import {
  DEFAULT_SERVE_JUDGE_MODELS,
  defaultServeJudgeModel,
  scoreServedAnswer,
  SERVE_JUDGE_RUBRIC,
} from './serve-judge.js';

const PRICES_PATH = fileURLToPath(new URL('../../../prices.json', import.meta.url));

function deps(capture?: Array<number | undefined>): { providers: Record<ProviderId, Provider>; prices: PriceTable } {
  const prices = loadPrices(PRICES_PATH).table;
  const mock = createMockProvider(prices);
  const wrapped: Provider = capture
    ? {
        ...mock,
        complete: (req) => {
          capture.push(req.params?.maxTokens);
          return mock.complete(req);
        },
      }
    : mock;
  return {
    providers: { anthropic: wrapped, openai: wrapped, google: wrapped, openrouter: wrapped, mock: wrapped },
    prices,
  };
}

const PARAMS = {
  requestId: 'chatcmpl-sj-1',
  clusterId: 'code-gen',
  messages: [{ role: 'user' as const, content: 'Write a function that reverses a string' }],
  answerText: 'def reverse(s): return s[::-1]',
  judgeModel: 'mock-judge',
};

describe('scoreServedAnswer', () => {
  it('is deterministic per (judge, requestId, answer), normalized, labeled, and usage-accounted', async () => {
    const d = deps();
    const a = await scoreServedAnswer(PARAMS, d);
    const b = await scoreServedAnswer(PARAMS, d);
    expect(a.quality).toBe(b.quality);
    expect(a.quality).toBeGreaterThanOrEqual(0);
    expect(a.quality).toBeLessThanOrEqual(1);
    expect(a.scorer).toBe('llm-judge:mock-judge');
    expect(a.usage.inputTokens).toBeGreaterThan(0);
    expect(a.usage.costUsd).toBe(0); // mock prices — recorded, not omitted
    // a different request id reseeds the judge
    const c = await scoreServedAnswer({ ...PARAMS, requestId: 'chatcmpl-sj-2' }, d);
    expect(typeof c.quality).toBe('number');
  });

  it('judge call is protocol-capped (maxTokens: PROTOCOL_MAX_TOKENS)', async () => {
    const seen: Array<number | undefined> = [];
    await scoreServedAnswer(PARAMS, deps(seen));
    expect(seen).toEqual([PROTOCOL_MAX_TOKENS]);
  });

  it('throws on an unknown judge alias (caller drops the sample loudly)', async () => {
    await expect(scoreServedAnswer({ ...PARAMS, judgeModel: 'no-such-judge' }, deps())).rejects.toThrow(
      /unknown judge model/,
    );
  });

  it('platform defaults: judge-class live, mock-judge otherwise; rubric is reference-free', () => {
    expect(defaultServeJudgeModel('live')).toBe(DEFAULT_SERVE_JUDGE_MODELS.live);
    expect(defaultServeJudgeModel('mock')).toBe(DEFAULT_SERVE_JUDGE_MODELS.mock);
    expect(defaultServeJudgeModel('unknown')).toBe(DEFAULT_SERVE_JUDGE_MODELS.mock);
    expect(SERVE_JUDGE_RUBRIC).toContain('no reference answer');
  });
});
