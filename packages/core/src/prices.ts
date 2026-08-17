import type { PriceEntry } from './types.js';

/**
 * Cost in USD for a single call.
 *
 * PREFERS THE PROVIDER'S OWN BILLED NUMBER when the transport reported one,
 * and models it from the price table only as a fallback. That ordering is the
 * whole point, and it was the other way round until S3 leg 2.
 *
 * WHY MODELLING IS NOT GOOD ENOUGH TO BILL ON — measured live against
 * OpenRouter, 2026-08-17, not assumed:
 *
 *   deepseek-chat  prompt 10 (3 of them CACHED), completion 2
 *                  modelled $0.0000044   actual $0.00000404   (+9% over)
 *   gpt-5-mini     prompt 12, completion_tokens 0, reasoning_tokens 107
 *                  reasoning is NOT inside completion_tokens
 *
 * The price shape here is input/output per 1M and nothing else, so it cannot
 * express a cached-input discount (we over-charge) or reasoning tokens that
 * arrive outside the completion count (we under-charge). Extending the shape
 * would mean re-deriving every provider's billing rules and keeping them
 * current forever. Reading the number the provider already computed is both
 * more accurate and less to maintain — and it reconciles exactly against the
 * provider invoice, which the modelled figure demonstrably did not (the Step 5
 * campaign closed with a ~0.3% residual against the OpenRouter dashboard).
 *
 * The fallback stays because not every transport reports a cost: Anthropic and
 * Google native return tokens only, and the mock providers have no bill at all.
 * For those the modelled figure IS the best available answer — it is just no
 * longer preferred over a real one.
 */
export function costUsd(
  u: { inputTokens: number; outputTokens: number; providerCostUsd?: number },
  e: PriceEntry,
): number {
  // Guarded rather than trusted: a negative or non-finite value from a
  // provider must not silently become the bill. Zero IS accepted — a
  // genuinely free call is a real answer, and refusing it would fall back to
  // a modelled number that invents a charge.
  if (u.providerCostUsd !== undefined && Number.isFinite(u.providerCostUsd) && u.providerCostUsd >= 0) {
    return u.providerCostUsd;
  }
  return (u.inputTokens * e.inputPer1M + u.outputTokens * e.outputPer1M) / 1_000_000;
}

/** Round to 6 decimals (tenth of a micro-cent) to keep accounting deterministic. */
export function roundCost(usd: number): number {
  return Math.round(usd * 1_000_000) / 1_000_000;
}
