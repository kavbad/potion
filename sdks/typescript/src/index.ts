/**
 * @potion/sdk — thin OpenAI-compatible SDK for the Potion gateway (SPEC §13.2).
 *
 * Wraps the official `openai` client and adds:
 *
 * - per-request policy override via the `policy` param (sends
 *   `X-Potion-Policy: <policyId | policyName>`);
 * - `.frontierTrace` on responses (parsed `x-frontier-trace` header);
 * - `.cost` on responses (`usage.cost` when the server reports one);
 * - a {@link PotionError} hierarchy mapping the platform's OpenAI-shaped
 *   error codes (policy_not_found, budget_exceeded, rate_limit_exceeded).
 */

export { Potion, PotionChatCompletion } from './client.js';
export type {
  OutcomeReceipt,
  OutcomeSignals,
  PotionChatCompletionCreateParams,
  PotionOptions,
  PotionRequestOptions,
} from './client.js';
export {
  BudgetExceededError,
  ERROR_CODE_MAP,
  mapError,
  PolicyNotFoundError,
  PotionError,
  RateLimitExceededError,
} from './errors.js';
export type { PotionErrorBody, PotionErrorOptions } from './errors.js';
export { FrontierTrace } from './types.js';
export type { PotionRouting } from './types.js';

export const VERSION = '0.1.0';
