import type { PriceEntry } from './types.js';

/** Cost in USD for a single call's token usage under a price entry. */
export function costUsd(
  u: { inputTokens: number; outputTokens: number },
  e: PriceEntry,
): number {
  return (u.inputTokens * e.inputPer1M + u.outputTokens * e.outputPer1M) / 1_000_000;
}

/** Round to 6 decimals (tenth of a micro-cent) to keep accounting deterministic. */
export function roundCost(usd: number): number {
  return Math.round(usd * 1_000_000) / 1_000_000;
}
