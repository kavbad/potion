// A logprob cascade is only the strategy that was MEASURED if the stage call
// actually asks the provider for logprobs. The harness sets captureConfidence
// on every cell (runner.ts); until 2026-09-08 the serve path never did, so in
// production stage 1 came back without a confidence, cascade.ts fell back to
// the self-report probe — a SECOND paid call, calibrated on the mock — and
// the served strategy was not the one on the frontier. The built-in mock
// cannot show this (it always exposes a confidence), so this provider behaves
// like a live OpenAI-compatible one: confidence only when logprobs were asked for.
import { describe, expect, it } from 'vitest';
import type { ChatMessage, PriceTable, StrategyConfig } from '@potion/core';
import { createProviders } from '@potion/providers';
import type { CompleteRequest, Provider } from '@potion/providers';
import { createResolver, execute, type ExecContext } from './index.js';

const PRICES: PriceTable = {
  version: 't', updatedAt: 't',
  entries: [
    { alias: 'cheap', provider: 'mock', model: 'live-shaped-cheap', inputPer1M: 1, outputPer1M: 1 },
    { alias: 'strong', provider: 'mock', model: 'live-shaped-strong', inputPer1M: 10, outputPer1M: 10 },
  ],
};
const CASCADE: StrategyConfig = {
  type: 'cascade', confidenceMethod: 'logprob',
  stages: [{ model: 'cheap', escalateIf: { confidenceBelow: 0.5 } }, { model: 'strong' }],
};
const MESSAGES: ChatMessage[] = [{ role: 'user', content: 'Which line has the bug?' }];

function liveShaped(): { provider: Provider; calls: CompleteRequest[] } {
  const calls: CompleteRequest[] = [];
  const provider: Provider = {
    id: 'mock',
    complete: async (req) => {
      calls.push(req);
      const probe = req.messages.some((m) => /CONFIDENCE: 0\.xx/.test(m.content));
      return {
        text: probe ? 'CONFIDENCE: 0.90' : '3',
        usage: { inputTokens: 10, outputTokens: 2 },
        latencyMs: 1,
        modelVersion: req.model,
        // The live contract: a confidence exists ONLY when logprobs were requested.
        ...(req.params?.logprobs === true ? { logprobConfidence: 0.97 } : {}),
      };
    },
  };
  return { provider, calls };
}
function ctxWith(provider: Provider, extra?: Partial<ExecContext>): ExecContext {
  const providers = { ...createProviders({ prices: PRICES }), mock: provider };
  return { providers, prices: PRICES, resolve: createResolver(providers, PRICES), ...extra };
}

describe('a logprob cascade on a live-shaped provider', () => {
  it('WITH captureConfidence: one stage call, logprobs requested, confidence from the provider, no probe', async () => {
    const { provider, calls } = liveShaped();
    const r = await execute(CASCADE, MESSAGES, ctxWith(provider, { captureConfidence: true }));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.params?.logprobs).toBe(true);
    expect(r.trace.map((t) => t.stage)).toEqual(['stage-0']);
    expect(r.trace[0]).toMatchObject({ confidence: 0.97, decision: 'accept' });
  });

  it('WITHOUT it: the same strategy makes a second, paid self-report call — a different strategy than the one measured', async () => {
    const { provider, calls } = liveShaped();
    const r = await execute(CASCADE, MESSAGES, ctxWith(provider));
    expect(calls).toHaveLength(2);
    expect(calls[0]?.params?.logprobs).toBeUndefined();
    // The warning entry IS the record of the substitution: the contract asked
    // for logprobs, the provider returned none, a probe was bought instead.
    expect(r.trace.map((t) => t.stage)).toEqual(['stage-0', 'stage-0-warning', 'stage-0-self-report']);
    expect(r.trace[1]?.decision).toMatch(/no-logprob-confidence-from-provider;fallback:self-report-calibrated/);
  });
});
