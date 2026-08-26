// JOURNEY execution (eval-review adoption, 2026-08-25): task completion as
// the atomic outcome. Promoted from scripts/journey-equivalence.ts, where
// this exact chaining measured 9 journeys × 3 arms × 2 reps live.
//
// One journey = one EvalItem: `prompt` is step 1, `journeySteps` the
// follow-ons; each step's prompt is templated with earlier outputs and the
// SAME strategy answers every step. Only the final artifact reaches the
// scorer — a journey that fails at its last step after three perfect ones
// scores what the customer got: a failed job. Usage sums over every step
// (each step is real spend) and latencyMs is whole-job time, because
// journey latency IS the sum a caller waits through.
//
// The constraint-erosion lesson rides in the DATA, not here: journey
// authors carry constraints forward explicitly in step prompts (the
// experiment's run 1 lost a function-name contract at a restate step in
// EVERY arm until the spec pinned it). Step clusterIds are documentation +
// future routed-arm replay; the harness itself never routes mid-journey.
import type { ChatMessage, EvalItem } from '@potion/core';

export interface JourneyStepOutcome {
  text: string;
  usage: { inputTokens: number; outputTokens: number; costUsd: number; latencyMs: number };
}

/**
 * {{prev}} = the last output; {{prevN}} = N+1 steps back ({{prev1}} is the
 * output before last). Unknown/out-of-range references resolve to '' — an
 * authored template bug shows up as a scored failure, never a crash.
 */
export function templateJourneyPrompt(prompt: string, outputs: readonly string[]): string {
  return prompt.replace(/\{\{prev(\d*)\}\}/g, (_, n: string) => {
    const back = n === '' ? 0 : Number(n);
    return outputs[outputs.length - 1 - back] ?? '';
  });
}

/**
 * Run a journey item end-to-end with one execute function (the strategy is
 * bound inside `runStep` by the caller — the runner passes its own
 * execute(strategy, …) with the per-step seed). Returns the same shape the
 * runner's single-shot path consumes: final text + summed usage.
 */
export async function executeJourney(
  item: EvalItem,
  runStep: (messages: ChatMessage[], stepIndex: number) => Promise<JourneyStepOutcome>,
): Promise<JourneyStepOutcome> {
  const steps = item.journeySteps ?? [];
  const outputs: string[] = [];
  const usage = { inputTokens: 0, outputTokens: 0, costUsd: 0, latencyMs: 0 };
  // Step 1 is the item's own prompt, untemplated.
  const first = await runStep(item.prompt, 0);
  outputs.push(first.text);
  usage.inputTokens += first.usage.inputTokens;
  usage.outputTokens += first.usage.outputTokens;
  usage.costUsd += first.usage.costUsd;
  usage.latencyMs += first.usage.latencyMs;
  for (const [i, step] of steps.entries()) {
    const content = templateJourneyPrompt(step.prompt, outputs);
    const r = await runStep([{ role: 'user', content }], i + 1);
    outputs.push(r.text);
    usage.inputTokens += r.usage.inputTokens;
    usage.outputTokens += r.usage.outputTokens;
    usage.costUsd += r.usage.costUsd;
    usage.latencyMs += r.usage.latencyMs;
  }
  return { text: outputs[outputs.length - 1]!, usage };
}
