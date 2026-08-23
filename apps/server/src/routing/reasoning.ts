// Reasoning models under small output budgets (2026-08-23).
//
// Found live on the extraction cluster: the pick was a reasoning model that
// spends a customer-sized max_tokens entirely on thinking; the empty-answer
// retry then served the NEXT point — another reasoning model — and the
// customer paid twice for nothing. The roster carries no such flag, so the
// server learns it from evidence it already has: a response whose usage
// reports reasoning tokens, or an empty answer that exhausted its budget.
// Below REASONING_MIN_BUDGET a marked model is skipped BEFORE the call.
//
// In-process memory, deliberately: a restart forgets, the first empty
// answer re-teaches it, and nothing here can be wrong for long. Persisting
// it on the registry is the next step once the flag has earned trust.

/** Output budgets below this are not enough for a reasoning model to think
 * AND answer; above it the model's own judgement is trusted. */
export const REASONING_MIN_BUDGET = 1024;

const marked = new Map<string, { at: number; why: 'reasoning_tokens' | 'empty_length' }>();

export function markReasoning(model: string, why: 'reasoning_tokens' | 'empty_length', now: number = Date.now()): void {
  if (!marked.has(model)) marked.set(model, { at: now, why });
}

export function isReasoningModel(model: string): boolean {
  return marked.has(model);
}

/** True when this single-model point should not be asked at this budget. */
export function tooSmallForReasoning(model: string, maxOutputTokens: number | undefined): boolean {
  return maxOutputTokens !== undefined && maxOutputTokens < REASONING_MIN_BUDGET && isReasoningModel(model);
}

/** Learn from a served answer. */
export function learnFromAnswer(
  model: string,
  result: { text: string; finishReason?: string; usage: { outputTokens: number; reasoningTokens?: number } },
  maxOutputTokens: number | undefined,
): void {
  if ((result.usage.reasoningTokens ?? 0) > 0) markReasoning(model, 'reasoning_tokens');
  else if (result.text.trim() === '' && (result.finishReason === 'length' || (maxOutputTokens !== undefined && result.usage.outputTokens >= maxOutputTokens))) {
    markReasoning(model, 'empty_length');
  }
}

/** Seed marks from POTION_REASONING_MODELS (comma-separated aliases) so a
 * restart does not re-pay the cold-start cost for models already known. */
export function seedReasoningMarks(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.POTION_REASONING_MODELS ?? '';
  const aliases = raw.split(',').map((a) => a.trim()).filter(Boolean);
  for (const a of aliases) markReasoning(a, 'reasoning_tokens');
  return aliases;
}
seedReasoningMarks();

/** Test seam. */
export function clearReasoningMarks(): void {
  marked.clear();
}
