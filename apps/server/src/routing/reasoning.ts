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
// The in-process map stays the fast path; since P1-8 (migration 0052) the
// mark also persists onto the registry (models.reasoning) so a restart no
// longer re-pays one wasted customer call per known model: boot loads the
// persisted marks, and a fresh mark writes through best-effort — a failed
// write costs nothing but the old cold-start behavior.

/** Output budgets below this are not enough for a reasoning model to think
 * AND answer; above it the model's own judgement is trusted. */
export const REASONING_MIN_BUDGET = 1024;

const marked = new Map<string, { at: number; why: 'reasoning_tokens' | 'empty_length' }>();

/** P1-8 write-through, installed by boot (context.ts). Best-effort: the
 * in-process mark already protects this process; persistence only spares
 * the NEXT one. Never throws into the serving path. */
let persist: ((model: string) => Promise<void>) | null = null;
export function setReasoningPersistence(fn: ((model: string) => Promise<void>) | null): void {
  persist = fn;
}

/** Load marks persisted on the registry (boot) — no write-back. */
export function loadReasoningMarks(aliases: string[], now: number = Date.now()): void {
  for (const a of aliases) if (!marked.has(a)) marked.set(a, { at: now, why: 'reasoning_tokens' });
}

export function markReasoning(model: string, why: 'reasoning_tokens' | 'empty_length', now: number = Date.now()): void {
  if (marked.has(model)) return;
  marked.set(model, { at: now, why });
  if (persist) void persist(model).catch(() => {});
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

/** Aliases currently marked — boot persists these (env-seeded ones included). */
export function listMarkedReasoning(): string[] {
  return [...marked.keys()];
}

/** Test seam. */
export function clearReasoningMarks(): void {
  marked.clear();
  persist = null;
}
