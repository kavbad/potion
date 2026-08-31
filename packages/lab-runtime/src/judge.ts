// X3 — THE JUDGE. The measurement religion applied to the worker's own
// craft: every completed deliverable is scored against the operator's
// stated bar, per criterion, with the rationale stored.
//
// Laws (the panel's validity criteria, 2026-08-28):
//   · ADVISORY: a judgment never blocks or fails a run — it is measurement,
//     recorded on the run row AFTER the terminal state (outside the leg
//     record, so replay determinism is untouched);
//   · the rubric is COMPILED from the spec (the "Done well means" rule, the
//     exemplar, the contract's own requirements) — never invented;
//   · the judgment stores WHAT SERVED IT (frontierTrace) beside what served
//     the worker, so "judge ≠ worker's point" is inspectable, not asserted;
//   · strict JSON out, integer scores 0–10, bounded criteria — unparseable
//     judgments are recorded AS unparseable (a typed miss, never a guess);
//   · metered like everything else: the judge call rides the org's serving
//     path and shows up in receipts.
import type { HarnessSpec } from '@potion/lab-spec';

export interface JudgeCriterion {
  name: string;
  score: number; // 0–10 integer
  note: string;
}

export interface Judgment {
  overall: number; // 0–10 integer
  criteria: JudgeCriterion[];
  rationale: string;
  /** What served the JUDGE call (worker's own trace lives on its steps). */
  judgeTrace: string | null;
  judgeCompletionId: string | null;
  estCostUsd: number;
  /** Always false until the calibration discipline (G8-style) marks the
   * rubric class calibrated — the UI must say "advisory" while false. */
  calibrated: false;
}

export interface JudgeMiss {
  error: string;
  judgeTrace: string | null;
  estCostUsd: number;
}

export const JUDGE_LIMITS = {
  MAX_CRITERIA: 8,
  MAX_NOTE_CHARS: 300,
  MAX_RATIONALE_CHARS: 1200,
  MAX_DELIVERABLE_CHARS: 12_000,
} as const;

/** The rubric, compiled from the spec — the criteria a deliverable is
 * scored against. Deterministic; shown to the user beside every score. */
export function compileRubric(spec: HarnessSpec): string[] {
  const criteria: string[] = [];
  const bar = spec.rules.find((r) => r.startsWith('Done well means: '));
  if (bar !== undefined) criteria.push(bar.replace('Done well means: ', ''));
  const deliverable = spec.rules.find((r) => r.startsWith('Deliverable: '));
  if (deliverable !== undefined) criteria.push(`matches the promised shape: ${deliverable.replace('Deliverable: ', '')}`);
  if (spec.contract?.type === 'brief') {
    criteria.push('every load-bearing claim carries its source');
    criteria.push('coverage is honest — gaps named, nothing padded');
  }
  if (spec.exemplar !== undefined) criteria.push('meets the standard of the operator’s exemplar');
  // P5: a watchdog is judged on a DIFFERENT law — precision over volume.
  // "Nothing worth your attention — N sources checked" is a valid, judged
  // deliverable; firing without evidence is the failure mode.
  if (spec.mission.kind === 'standing' && spec.mission.shape === 'watchdog') {
    criteria.push('fires ONLY on a true condition — every alert carries its evidence (the diff, the line, the number)');
    criteria.push('no false alarms — a quiet check that states its coverage is a GOOD result, not a lazy one');
  }
  if (criteria.length === 0) criteria.push('the mission’s goal is served accurately and usefully');
  return criteria.slice(0, JUDGE_LIMITS.MAX_CRITERIA);
}

export function buildJudgeMessages(
  spec: HarnessSpec,
  deliverableText: string,
  /** 2026-08-31: the run's PRODUCED FILES — evidence the judge must see.
   * Without it, honest runs that put their substance in artifacts get
   * scored "provides no artifacts" (observed live, 2/10 on a correct
   * run). Names and sizes only — the files themselves are downloadable
   * on the run page. */
  evidence?: { files?: Array<{ name: string; size: number }> },
): Array<{ role: 'user'; content: string }> {
  const rubric = compileRubric(spec);
  const filesLine =
    evidence?.files !== undefined && evidence.files.length > 0
      ? `\nFiles this run produced (verified artifacts in its workspace): ${evidence.files.map((f) => `${f.name} (${f.size} bytes)`).join(', ')}\n`
      : '';
  return [
    {
      role: 'user',
      content:
        `You are a strict quality judge. Score the DELIVERABLE against each criterion. ` +
        `Reply with STRICT JSON only — no prose, no fences: ` +
        `{"overall": 0-10 integer, "criteria": [{"name": string, "score": 0-10 integer, "note": string}], "rationale": string}. ` +
        `One criteria entry per rubric line, in order. Keep every note under 12 words and the rationale under 30 words — brevity is part of the format. ` +
        `Judge what is present, never what is claimed.\n\n` +
        `Mission: ${spec.mission.goal}\n` +
        `Rubric:\n${rubric.map((c, i) => `${i + 1}. ${c}`).join('\n')}\n` +
        (spec.exemplar !== undefined ? `\nThe operator's exemplar (the standard):\n${spec.exemplar}\n` : '') +
        filesLine +
        `\nDELIVERABLE:\n${deliverableText.slice(0, JUDGE_LIMITS.MAX_DELIVERABLE_CHARS)}`,
    },
  ];
}

export function parseJudgment(text: string, rubric: string[]): { ok: true; overall: number; criteria: JudgeCriterion[]; rationale: string } | { ok: false; error: string } {
  const stripped = text.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
  let raw: unknown;
  try {
    raw = JSON.parse(stripped);
  } catch (e) {
    return { ok: false, error: `not JSON: ${(e as Error).message}` };
  }
  const j = raw as { overall?: unknown; criteria?: unknown; rationale?: unknown };
  const intScore = (v: unknown): number | null =>
    typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 10 ? v : null;
  const overall = intScore(j.overall);
  if (overall === null) return { ok: false, error: 'overall must be an integer 0–10' };
  if (!Array.isArray(j.criteria) || j.criteria.length === 0 || j.criteria.length > JUDGE_LIMITS.MAX_CRITERIA) {
    return { ok: false, error: `criteria must be 1–${JUDGE_LIMITS.MAX_CRITERIA} entries` };
  }
  const criteria: JudgeCriterion[] = [];
  for (let i = 0; i < j.criteria.length; i++) {
    const c = j.criteria[i] as { name?: unknown; score?: unknown; note?: unknown };
    const score = intScore(c.score);
    if (score === null) return { ok: false, error: `criteria[${i}].score must be an integer 0–10` };
    criteria.push({
      name: typeof c.name === 'string' && c.name.trim() !== '' ? c.name.slice(0, 200) : (rubric[i] ?? `criterion ${i + 1}`).slice(0, 200),
      score,
      note: typeof c.note === 'string' ? c.note.slice(0, JUDGE_LIMITS.MAX_NOTE_CHARS) : '',
    });
  }
  const rationale = typeof j.rationale === 'string' ? j.rationale.slice(0, JUDGE_LIMITS.MAX_RATIONALE_CHARS) : '';
  return { ok: true, overall, criteria, rationale };
}
