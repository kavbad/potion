// The generator's ONE model surface: a structured-extraction call through
// ServingClient (potion-auto, metered, budget-gated — the generator is a
// model call and pays like everything else). Hard-bounded at
// GEN_MAX_MODEL_CALLS (extraction + one repair). The model may only fill
// the strict extraction schema; it never free-writes spec fields.
import { z } from 'zod';
import type { ChatMessage } from '@potion/core';
import type { ServingClientLike } from '@potion/lab-runtime';
import { scanRawValue, SPEC_LIMITS } from '@potion/lab-spec';
import { GEN_MAX_MODEL_CALLS } from './constants.js';
import { TAXONOMY_CLUSTERS, type InterviewAnswers } from './interview.js';

export const ExtractionSchema = z
  .object({
    /** The goal, normalized: imperative, self-contained, ≤ the spec cap. */
    normalizedGoal: z.string().min(1).max(SPEC_LIMITS.MAX_GOAL_CHARS),
    /** Task missions only: the done-definition, sharpened to be checkable. */
    doneDefinition: z.string().min(1).max(SPEC_LIMITS.MAX_GOAL_CHARS).optional(),
    /** Short kebab-case harness name. */
    nameSlug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,58}[a-z0-9]$/),
    /** The model's cluster opinion — reconciled with the lexical score,
     * never trusted alone. Enum-bound to the taxonomy. */
    clusterHint: z.enum(TAXONOMY_CLUSTERS),
    /** Other kinds of work the mission genuinely contains (the work
     * PROFILE — a real agent's run is a mix, and serving routes each step
     * per-request). Enum-bound, capped, deduped against the primary by
     * code. Optional so pre-profile extractions stay parseable. */
    alsoClusters: z.array(z.enum(TAXONOMY_CLUSTERS)).max(3).optional(),
  })
  .strict();

export type Extraction = z.infer<typeof ExtractionSchema>;

export type ExtractResult =
  | { ok: true; extraction: Extraction; calls: number }
  | { ok: false; reason: 'extraction-unparseable' | 'serving-error'; detail: string; calls: number };

function extractionPrompt(answers: InterviewAnswers): string {
  return [
    'You convert a mission interview into a STRICT JSON object. Reply with JSON only — no prose, no code fences.',
    'Schema: {"normalizedGoal": string, "doneDefinition"?: string, "nameSlug": string (kebab-case, <=60 chars), "clusterHint": one of ' +
      JSON.stringify(TAXONOMY_CLUSTERS) + ', "alsoClusters"?: up to 3 more from the same list}',
    'Rules: normalizedGoal restates the goal imperatively and self-contained. ' +
      'doneDefinition ONLY for kind=task, sharpened to be objectively checkable (fold in the quality bar and deliverable shape when given). ' +
      'clusterHint is the single best-fitting cluster for the goal. ' +
      'alsoClusters are OTHER kinds of work the mission genuinely contains — omit rather than pad.',
    'Interview answers:',
    JSON.stringify({
      goal: answers.goal,
      kind: answers.kind,
      ...(answers.doneDefinition !== undefined ? { doneDefinition: answers.doneDefinition } : {}),
      ...(answers.qualityBar !== undefined ? { doneWellMeans: answers.qualityBar } : {}),
      ...(answers.produces !== undefined ? { shouldProduce: answers.produces } : {}),
      ...(answers.exampleResult !== undefined ? { exampleOfAGreatResult: answers.exampleResult } : {}),
    }),
  ].join('\n');
}

function tryParse(text: string): { ok: true; extraction: Extraction } | { ok: false; issues: string } {
  // Tolerate fence-wrapped JSON (models do this); nothing else.
  const stripped = text.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
  let raw: unknown;
  try {
    raw = JSON.parse(stripped);
  } catch (e) {
    return { ok: false, issues: `not JSON: ${(e as Error).message}` };
  }
  const parsed = ExtractionSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
  // The model surface is fully gated: control characters, key-shaped
  // content, or other raw-scan issues in the extraction are a parse
  // failure (repairable once), never something the assembler passes
  // through to fail the closure gate downstream.
  const rawIssues = scanRawValue(parsed.data);
  if (rawIssues.length > 0) {
    return { ok: false, issues: rawIssues.map((i) => `${i.path}: ${i.code}`).join('; ') };
  }
  return { ok: true, extraction: parsed.data };
}

export async function extractMission(client: ServingClientLike, answers: InterviewAnswers): Promise<ExtractResult> {
  let calls = 0;
  let lastIssues = '';
  let messages: ChatMessage[] = [{ role: 'user', content: extractionPrompt(answers) }];
  while (calls < GEN_MAX_MODEL_CALLS) {
    const res = await client.complete({ messages });
    calls += 1;
    if (res.kind !== 'ok') {
      return { ok: false, reason: 'serving-error', detail: `${res.kind === 'error' ? res.code : res.kind}`, calls };
    }
    const parsed = tryParse(res.text);
    if (parsed.ok) {
      // Task missions must end up with a doneDefinition; standing must not.
      if (answers.kind === 'task' && parsed.extraction.doneDefinition === undefined) {
        lastIssues = 'doneDefinition required for kind=task';
      } else if (answers.kind === 'standing' && parsed.extraction.doneDefinition !== undefined) {
        // Standing: drop it deterministically rather than round-tripping.
        const { doneDefinition: _dropped, ...rest } = parsed.extraction;
        return { ok: true, extraction: rest as Extraction, calls };
      } else {
        return { ok: true, extraction: parsed.extraction, calls };
      }
    } else {
      lastIssues = parsed.issues;
    }
    messages = [
      ...messages,
      { role: 'assistant', content: res.text },
      { role: 'user', content: `Your last reply failed validation (${lastIssues}). Reply with the corrected JSON object only.` },
    ];
  }
  return { ok: false, reason: 'extraction-unparseable', detail: lastIssues, calls };
}
