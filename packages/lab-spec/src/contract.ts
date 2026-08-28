// The output contract (P1, "the mouth") — the deliverable's schema and its
// parser. A contract-bearing standing check may not complete until its final
// answer parses as the deliverable; the runtime enforces that law, this file
// defines what "parses" means. One contract type in v1: the BRIEF.
//
// Design rules:
//  · every headline claim CARRIES ITS SOURCE URL — the contract is where
//    claim-binding starts (P4 verifies; P1 requires the field);
//  · "quiet" is first-class: entities checked with nothing to report are
//    part of the deliverable, not an omission;
//  · coverage is honest: how many sources were checked, and a note when
//    coverage was partial ("TechCrunch was down").
import { z } from 'zod';

export const BRIEF_LIMITS = {
  MAX_HEADLINE: 5,
  MAX_CLAIM_CHARS: 400,
  MAX_URL_CHARS: 600,
  MAX_ENTITY_CHARS: 120,
  MAX_ENTITIES: 24,
  MAX_ITEMS_PER_ENTITY: 10,
  MAX_NOTE_CHARS: 400,
  MAX_QUIET: 24,
  MAX_COVERAGE_NOTE_CHARS: 400,
} as const;

const HttpUrl = z
  .string()
  .max(BRIEF_LIMITS.MAX_URL_CHARS)
  .refine((u) => /^https?:\/\//.test(u), 'sourceUrl must be an http(s) URL');

export const BriefSchema = z
  .object({
    /** The act-now items, most important first. */
    headline: z
      .array(
        z
          .object({
            claim: z.string().min(1).max(BRIEF_LIMITS.MAX_CLAIM_CHARS),
            sourceUrl: HttpUrl,
            entity: z.string().min(1).max(BRIEF_LIMITS.MAX_ENTITY_CHARS).optional(),
          })
          .strict(),
      )
      .max(BRIEF_LIMITS.MAX_HEADLINE),
    /** The by-entity roll: what happened, per thing being watched. */
    byEntity: z
      .array(
        z
          .object({
            entity: z.string().min(1).max(BRIEF_LIMITS.MAX_ENTITY_CHARS),
            items: z
              .array(
                z
                  .object({
                    note: z.string().min(1).max(BRIEF_LIMITS.MAX_NOTE_CHARS),
                    sourceUrl: HttpUrl.optional(),
                  })
                  .strict(),
              )
              .min(1)
              .max(BRIEF_LIMITS.MAX_ITEMS_PER_ENTITY),
          })
          .strict(),
      )
      .max(BRIEF_LIMITS.MAX_ENTITIES),
    /** Checked, nothing to report — silence stated, never implied. */
    quiet: z.array(z.string().min(1).max(BRIEF_LIMITS.MAX_ENTITY_CHARS)).max(BRIEF_LIMITS.MAX_QUIET),
    coverage: z
      .object({
        checked: z.number().int().min(0),
        note: z.string().min(1).max(BRIEF_LIMITS.MAX_COVERAGE_NOTE_CHARS).optional(),
      })
      .strict(),
  })
  .strict();

export type Brief = z.infer<typeof BriefSchema>;

export type ParseBriefResult =
  | { ok: true; brief: Brief }
  | { ok: false; issues: string[] };

/** Parse a model's final answer as the brief deliverable. Tolerates a fenced
 * JSON block (models do this) and text around a single JSON object; nothing
 * else. Deterministic — replay derives the SAME verdict from the recorded
 * response text. */
export function parseBrief(text: string): ParseBriefResult {
  let candidate = text.trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(candidate);
  if (fence?.[1] !== undefined) candidate = fence[1].trim();
  if (!candidate.startsWith('{')) {
    // Text around a single object: take first '{' .. last '}'.
    const a = candidate.indexOf('{');
    const b = candidate.lastIndexOf('}');
    if (a === -1 || b === -1 || b <= a) return { ok: false, issues: ['no JSON object found in the reply'] };
    candidate = candidate.slice(a, b + 1);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(candidate);
  } catch (e) {
    return { ok: false, issues: [`not valid JSON: ${(e as Error).message}`] };
  }
  const parsed = BriefSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).slice(0, 10) };
  }
  return { ok: true, brief: parsed.data };
}

/** The contract's instructions to the worker — appended to the system prompt
 * ONLY for contract-bearing specs (contract-less prompts stay byte-identical,
 * the A2 discipline). Kept in lab-spec so the runtime and replay quote the
 * same constant. */
export const BRIEF_CONTRACT_PROMPT = [
  'Deliverable contract: when your check is complete, reply with ONLY a JSON object (no prose before or after) of shape:',
  '{"headline": [{"claim": string, "sourceUrl": "https://…", "entity"?: string}] (max 5, most important first),',
  ' "byEntity": [{"entity": string, "items": [{"note": string, "sourceUrl"?: "https://…"}]}],',
  ' "quiet": [string] (entities you checked with nothing to report),',
  ' "coverage": {"checked": number, "note"?: string (say plainly if any source was unreachable)}}',
  'Every headline claim MUST carry the URL of the page it came from. Do not invent sources. An empty headline is valid when nothing is act-now.',
].join('\n');
