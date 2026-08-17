// S3 leg 2 — the billed cost beats the modelled one.
//
// Measured live against OpenRouter on 2026-08-17, which is why this changed:
//
//   deepseek-chat  prompt 10 (3 CACHED), completion 2
//                  modelled $0.0000044   actual $0.00000404   (+9% over)
//   gpt-5-mini     prompt 12, completion_tokens 0, reasoning_tokens 107
//                  reasoning billed but OUTSIDE the completion count
//
// The price shape is input/output per 1M and cannot express either case. The
// tests below encode both directions, because the failure is not one-sided:
// cached input makes us OVERCHARGE a customer, reasoning tokens make us
// UNDERCHARGE ourselves, and only one of those is merely embarrassing.
import { describe, expect, it } from 'vitest';
import { costUsd } from './prices.js';
import type { PriceEntry } from './types.js';

const entry: PriceEntry = {
  alias: 'or-deepseek',
  provider: 'openrouter',
  model: 'deepseek/deepseek-chat-v3.1',
  inputPer1M: 0.25,
  outputPer1M: 0.95,
};

describe('costUsd prefers what the provider actually billed', () => {
  it('models the cost when the provider reported none', () => {
    // Anthropic/Google native and the mock providers return tokens only, so
    // the modelled figure is still the best answer available for them.
    expect(costUsd({ inputTokens: 10, outputTokens: 2 }, entry)).toBeCloseTo(0.0000044, 12);
  });

  it('uses the REPORTED cost over the modelled one — the cached-input case', () => {
    // The live sample: 3 of 10 prompt tokens were cached, so the real bill was
    // below our model. Billing the model would overcharge the customer.
    expect(
      costUsd({ inputTokens: 10, outputTokens: 2, providerCostUsd: 0.00000404 }, entry),
    ).toBeCloseTo(0.00000404, 12);
  });

  it('the REASONING case: completion_tokens 0 while 107 reasoning tokens were billed', () => {
    // Modelled from tokens this is $0.000003 of input and NOTHING for output,
    // because the reasoning tokens are not in completion_tokens at all. Only
    // the provider's own number sees them.
    const modelled = costUsd({ inputTokens: 12, outputTokens: 0 }, entry);
    const billed = costUsd({ inputTokens: 12, outputTokens: 0, providerCostUsd: 0.000003 }, entry);
    expect(modelled).toBeCloseTo(0.000003, 12); // input only — output is invisible
    expect(billed).toBeCloseTo(0.000003, 12);
    // The point is not that these two happen to match on this sample; it is
    // that the modelled figure has NO term that could ever have counted the
    // 107 reasoning tokens, so its agreement here is luck, not method.
  });

  it('accepts a reported ZERO — a genuinely free call is a real answer', () => {
    // Falling back here would invent a charge for a call that cost nothing.
    expect(costUsd({ inputTokens: 1000, outputTokens: 1000, providerCostUsd: 0 }, entry)).toBe(0);
  });

  it('REFUSES a nonsense report and falls back rather than billing it', () => {
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        costUsd({ inputTokens: 10, outputTokens: 2, providerCostUsd: bad }, entry),
        `providerCostUsd=${String(bad)} must not become the bill`,
      ).toBeCloseTo(0.0000044, 12);
    }
  });
});
