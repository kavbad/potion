// PROMPT VARIANTS (C4 rung 2, docs/INFERENCE-COMPILER-PLAN.md): how the
// request is ASKED, as a compiler parameter.
//
// WHY A CLOSED VOCABULARY. The obvious design is a free-text system prompt on
// the call node, and it is wrong for a compiler. A program is data: its hash
// is its identity, its cost is computable before it runs, and a reader can
// tell what it does without running it. Arbitrary English on a node destroys
// all three — the search space stops being enumerable, two programs that
// differ by a comma are different mechanisms, and "what does this program do"
// becomes a reading-comprehension exercise. So a variant is a NAME drawn from
// a fixed set, and the text behind each name lives here, in one place, under
// review, like the judge prompt and the self-report probe.
//
// The variant is added as an extra SYSTEM turn. Every live transport joins
// multiple system messages (see splitSystem), and the customer's own messages
// are never rewritten — a variant adds an instruction, it never edits the
// request.
import type { ChatMessage } from './types.js';

export const PROMPT_VARIANT = ['terse', 'step-by-step', 'json-only'] as const;
export type PromptVariant = (typeof PROMPT_VARIANT)[number];

/** The one place the text lives. Reviewed like any other prompt we ship. */
export const PROMPT_VARIANT_TEXT: Record<PromptVariant, string> = {
  terse:
    'Answer with the shortest response that is fully correct. No preamble, no ' +
    'restatement of the question, no closing summary.',
  'step-by-step':
    'Work through the problem step by step, then give the final answer.',
  'json-only':
    'Respond with a single JSON object and nothing else. No prose before or ' +
    'after it, and no code fences.',
};

/** Input tokens the instruction itself costs, per variant. Measured from the
 *  text above at the repo's 4-chars-per-token estimate, rounded up — the
 *  preflight is an upper bound, so rounding goes against us. */
export const PROMPT_VARIANT_TOKENS: Record<PromptVariant, number> = Object.fromEntries(
  PROMPT_VARIANT.map((v) => [v, Math.ceil(PROMPT_VARIANT_TEXT[v].length / 4)]),
) as Record<PromptVariant, number>;

/** Add the variant's instruction to a request. Pure; the customer's turns are
 *  untouched. */
export function applyPromptVariant(
  messages: ChatMessage[],
  variant: PromptVariant | undefined,
): ChatMessage[] {
  if (variant === undefined) return messages;
  return [...messages, { role: 'system', content: PROMPT_VARIANT_TEXT[variant] }];
}

/**
 * DOES THIS WORKLOAD'S INSTRUMENT TOLERATE THE MODEL THINKING OUT LOUD?
 *
 * One property, named once, because more than one axis causes it. Prose before
 * an answer breaks anything that reads the answer's SHAPE: an `exact` scorer
 * fails a correct answer wrapped in reasoning, and a `field-match` or
 * `field-contains` one cannot parse JSON with an essay in front of it — which
 * also breaks the json GATE a structured workload would use.
 *
 * MEASURED, not assumed. `step-by-step` was refused on these instruments from
 * the start on this argument. Then the first live run (2026-09-05,
 * extraction-authored-v1) put `effort-escalation` LAST of eleven strategies —
 * 0.862 against 0.962 for the same model answering plainly. Reasoning effort
 * buys deliberation with a thinking budget instead of with English, and the
 * instrument cannot tell the difference. So both axes ask this one question.
 *
 * `code-exec` tolerates it: the answer is extracted from a fence, so thinking
 * in front of it survives — and code generation is where deliberation earns
 * the most.
 */
export function toleratesDeliberation(scoringKinds: string[]): boolean {
  return !scoringKinds.some((k) => k === 'exact' || k === 'field-match' || k === 'field-contains');
}

/**
 * THE INSTRUCTION SET AND THE GATE SPACE ARE COUPLED.
 *
 * A variant that changes the SHAPE of the answer can break the instrument that
 * grades it, and the gate that reads it. `step-by-step` asks for prose before
 * the answer: on an `exact`-scored workload that fails the scorer even when
 * the reasoning is right, and on a `field-match` one it breaks JSON parsing —
 * so it also breaks the very json gate a structured workload would use.
 *
 * This is not a lint. It is the reason the compiler cannot treat its axes as
 * independent: instructions and checks have to agree about what an answer
 * looks like.
 */
export function promptVariantFitsScoring(variant: PromptVariant, scoringKinds: string[]): boolean {
  switch (variant) {
    case 'terse':
      // Shorter is never the wrong shape; it is only ever the wrong content,
      // which is what measurement is for.
      return true;
    case 'json-only':
      // Only where the answer is supposed to be an object.
      return scoringKinds.some((k) => k === 'field-match' || k === 'field-contains');
    case 'step-by-step':
      // Not a second list — the same property reasoning effort asks about.
      return toleratesDeliberation(scoringKinds);
  }
}
