// Scorers (SPEC §5): real scoring logic over mock-world answers.
//   exact       — normalized string compare (case/whitespace) vs reference.
//   field-match — tolerant JSON.parse + per-field compare vs reference object,
//                 score = matched/total, type coercion per schema.
//   code-exec   — generated JS + the item's `tests` snippet in an ISOLATED
//                 worker_threads sandbox (./code-exec-sandbox.ts: 2s wall
//                 timeout + terminate, 32MB heap cap, stripped globals;
//                 M2-security — was in-process node:vm).
//   llm-judge   — judge model answers `SCORE: <x>` in rubric scale; normalized 0..1.
import { costUsd, lastAnchoredValue, PROTOCOL_MAX_TOKENS, roundCost, UNTRUSTED_DATA_FRAME, wrapUntrustedData, type EvalItem, type PriceTable, type ProviderId, type ScoringMethod, type Usage } from '@potion/core';
import { hashString, type Provider } from '@potion/providers';
import { scoreCodeExec } from './code-exec-sandbox.js';

// The code-exec public surface lives in ./code-exec-sandbox.ts (worker
// sandbox); re-exported here so existing imports from './scorers.js' and the
// package index keep working unchanged.
export {
  activeCodeExecWorkers,
  CODE_EXEC_TIMEOUT_MS,
  CODE_EXEC_WALL_SLACK_MS,
  CODE_EXEC_WORKER_MEMORY_MB,
  runCodeWithTests,
  scoreCodeExec,
  type CodeExecReport,
} from './code-exec-sandbox.js';

export interface ScoreOutcome {
  quality: number; // normalized 0..1
  scorer: string; // 'exact' | 'code-exec' | 'field-match' | 'llm-judge:<model>'
  /**
   * Usage of the SCORING call itself (llm-judge only): tokens from the judge
   * response, cost priced via the judgeModel's prices entry, latencyMs of the
   * judge call. Undefined for deterministic scorers (exact / field-match /
   * code-exec make no model calls). Runners MUST fold this into spend
   * accounting — the judge call is real provider spend (M1b fix: it was
   * previously discarded).
   */
  scorerUsage?: Usage;
}

/** Providers/prices needed only by the llm-judge scorer. */
export interface ScorerDeps {
  providers: Record<ProviderId, Provider>;
  prices: PriceTable;
}

// ---- exact ------------------------------------------------------------------

/** Normalization contract: trim, collapse all whitespace runs to one space, lowercase. */
export function normalizeText(s: string): string {
  return s.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * The number an answer LANDS ON: a labelled "final answer: N" if the text
 * carries one (the last such label wins), else the last number in the text.
 * Thousands separators, currency signs and markdown bold are read through.
 * Returns null when the text holds no number at all.
 */
export function finalNumber(text: string): number | null {
  const cleaned = text.replace(/,(?=\d{3}(?!\d))/g, '').replace(/[$*`]/g, '');
  const labelled = [...cleaned.matchAll(/final\s+answer\s*[:=]?\s*(-?\d+(?:\.\d+)?)/gi)];
  const picked =
    labelled.length > 0
      ? labelled[labelled.length - 1]![1]!
      : (cleaned.match(/-?\d+(?:\.\d+)?/g) ?? []).at(-1);
  if (picked === undefined) return null;
  const n = Number(picked);
  return Number.isFinite(n) ? n : null;
}

/**
 * The answer a response LANDS ON when the gold is not a number: the text
 * after the last "Final answer:" label, with markdown emphasis and trailing
 * sentence punctuation stripped. Returns null when the response carries no
 * such label — callers then fall back to whole-text compare, so this is never
 * STRICTER than plain exact, only more forgiving of visible reasoning.
 */
export function finalAnswer(text: string): string | null {
  const matches = [...text.matchAll(/final\s+answer\s*[:=]?\s*(.*)$/gim)];
  const last = matches.at(-1)?.[1];
  if (last === undefined) return null;
  const cleaned = last.replace(/[*`]/g, '').trim().replace(/[.!]+$/, '').trim();
  return cleaned === '' ? null : cleaned;
}

export function scoreExact(
  answer: string,
  reference: unknown,
  scoring: Extract<ScoringMethod, { kind: 'exact' }>,
): number {
  let ref = reference;
  if (scoring.field && ref !== null && typeof ref === 'object') {
    ref = (ref as Record<string, unknown>)[scoring.field];
  }
  if (scoring.extract === 'final-number') {
    const got = finalNumber(answer);
    const want = finalNumber(String(ref ?? ''));
    return got !== null && want !== null && Math.abs(got - want) < 1e-9 ? 1 : 0;
  }
  const compared = scoring.extract === 'final-answer' ? (finalAnswer(answer) ?? answer) : answer;
  return normalizeText(String(ref ?? '')) === normalizeText(compared) ? 1 : 0;
}

// ---- field-match --------------------------------------------------------------

/** Tolerant JSON extraction: strips ```json fences and surrounding prose-free whitespace. */
export function parseJsonAnswer(answer: string): unknown {
  const stripped = answer
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
  return JSON.parse(stripped);
}

/**
 * Coerce an answer value to the schema type for comparison. Returns
 * { ok: false } when the value cannot be coerced (counts as a mismatch).
 */
function coerceField(value: unknown, type: 'string' | 'number' | 'boolean' | 'array'): { ok: boolean; value: unknown } {
  switch (type) {
    case 'string':
      return typeof value === 'string'
        ? { ok: true, value }
        : value === null || value === undefined || typeof value === 'object'
          ? { ok: false, value }
          : { ok: true, value: String(value) };
    case 'number': {
      const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value.replace(/[$,]/g, '')) : NaN;
      return Number.isFinite(n) ? { ok: true, value: n } : { ok: false, value };
    }
    case 'boolean':
      if (typeof value === 'boolean') return { ok: true, value };
      if (value === 'true') return { ok: true, value: true };
      if (value === 'false') return { ok: true, value: false };
      return { ok: false, value };
    case 'array': {
      if (Array.isArray(value)) return { ok: true, value };
      if (typeof value === 'string') {
        try {
          const p = JSON.parse(value) as unknown;
          if (Array.isArray(p)) return { ok: true, value: p };
        } catch {
          /* fall through */
        }
      }
      return { ok: false, value };
    }
  }
}

/**
 * JOURNEY end-artifact check (eval-review adoption, 2026-08-25) — promoted
 * verbatim from the journey-equivalence experiment's proven scorer. Strips a
 * markdown fence, parses JSON, resolves each dotted path, and matches
 * case-insensitively by CONTAINS against the accepted spellings. Score =
 * matched paths / total; unparseable → 0. Deterministic, no reference field:
 * the fields object IS the check.
 */
export function scoreFieldContains(
  answer: string,
  scoring: Extract<ScoringMethod, { kind: 'field-contains' }>,
): number {
  const paths = Object.keys(scoring.fields);
  if (paths.length === 0) return 0;
  const stripped = answer
    .trim()
    .replace(/^```[a-z0-9_-]*\s*\n?/i, '')
    .replace(/\n?\s*```$/, '')
    .trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    return 0;
  }
  let hit = 0;
  for (const [path, want] of Object.entries(scoring.fields)) {
    let cur: unknown = parsed;
    for (const part of path.split('.')) {
      if (cur === null || typeof cur !== 'object') {
        cur = undefined;
        break;
      }
      cur = (cur as Record<string, unknown>)[part];
    }
    if (cur === undefined) continue;
    const hay = String(cur).toLowerCase();
    const accepted = (Array.isArray(want) ? want : [want]).map((w) => w.toLowerCase());
    if (hay !== '' && accepted.some((w) => hay.includes(w))) hit += 1;
  }
  return hit / paths.length;
}

/** score = matched fields / total schema fields; unparseable answer → 0. */
export function scoreFieldMatch(
  answer: string,
  reference: unknown,
  scoring: Extract<ScoringMethod, { kind: 'field-match' }>,
): number {
  const fields = Object.keys(scoring.schema);
  if (fields.length === 0) return 0;
  let parsed: unknown;
  try {
    parsed = parseJsonAnswer(answer);
  } catch {
    return 0;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return 0;
  const answerObj = parsed as Record<string, unknown>;
  const refObj = (reference ?? {}) as Record<string, unknown>;
  let matched = 0;
  for (const f of fields) {
    if (!(f in answerObj)) continue;
    const coerced = coerceField(answerObj[f], scoring.schema[f]!);
    if (!coerced.ok) continue;
    matched += JSON.stringify(coerced.value) === JSON.stringify(refObj[f]) ? 1 : 0;
  }
  return matched / fields.length;
}

// ---- code-exec ---------------------------------------------------------------
//
// Design (documented, SPEC §5 leaves the multi-case rule to us): the item's
// `tests` snippet registers named cases via the sandboxed `test(name, fn)`;
// each fn uses `assert(cond)` / `assertDeepEqual(a, b)` and throws on failure.
// Score = passed / total registered cases (fractional credit). If the
// generated code or the tests snippet itself throws (syntax error, timeout,
// forbidden global), or no cases register, score = 0.
//
// Sandbox (M2-security): execution happens in ./code-exec-sandbox.ts — a
// dedicated worker_threads Worker with a 2s vm timeout + hard wall-clock
// termination, a 32MB V8 heap cap, stripped worker globals (no require /
// process / fs / net / timers / fetch even after a context escape), and
// message-passing-only results. Threat model: docs/security/CODE-EXEC.md.
// The scoring contract above is unchanged; `runCodeWithTests`/`scoreCodeExec`
// are re-exported from the sandbox module at the top of this file.

// ---- llm-judge ---------------------------------------------------------------

/**
 * Judge prompt contract (also the mock fixture contract: SCORE_MARKER +
 * ANSWER block). Prompt-injection hardening (M2-security, @potion/core
 * safety.ts): the task and the answer are untrusted text — an answer can
 * embed "IGNORE PREVIOUS INSTRUCTIONS" or a fake "SCORE: 10" line aimed at
 * the judge. Both are wrapped in delimited DATA blocks with
 * DATA-not-instructions framing; the mock strips the markers when extracting
 * the ANSWER section, so fixture extraction is unchanged. The score itself is
 * parsed strictly (see scoreLlmJudge): LAST line-anchored SCORE wins and the
 * value is clamped to the rubric scale.
 */
export function buildJudgeScoreMessages(
  item: EvalItem,
  answer: string,
  scoring: Extract<ScoringMethod, { kind: 'llm-judge' }>,
): { role: 'user'; content: string }[] {
  const [lo, hi] = scoring.scale;
  const task = item.prompt.map((m) => `${m.role}: ${m.content}`).join('\n');
  // G1.4 reference anchoring: when the item carries a reference (replay items
  // hold the ORIGINAL session answer, redacted), the judge compares rather
  // than scoring absolutely — comparative judging is the contract-grade path
  // (reference-free judges plateaued ~0.5-0.6 pearson-vs-truth). The block
  // sits BETWEEN TASK and ANSWER: the mock judge fixture extracts the answer
  // as everything between 'ANSWER:' and the final instruction line, so a
  // trailing block would corrupt every mock score. Non-string references
  // (field-match objects) are JSON-stringified — one explicit rule.
  const referenceText =
    item.reference === undefined
      ? null
      : typeof item.reference === 'string'
        ? item.reference
        : JSON.stringify(item.reference);
  return [
    {
      role: 'user',
      content: [
        'You are an impartial judge. Score the ANSWER to the TASK using the rubric.' +
          (referenceText !== null
            ? ' A REFERENCE answer is provided; judge the ANSWER primarily by comparison against it.'
            : ''),
        `RUBRIC: ${scoring.rubric}`,
        '',
        UNTRUSTED_DATA_FRAME,
        '',
        'TASK:',
        wrapUntrustedData(task),
        ...(referenceText !== null ? ['', 'REFERENCE:', wrapUntrustedData(referenceText)] : []),
        '',
        'ANSWER:',
        wrapUntrustedData(answer),
        '',
        `Respond with exactly one line: SCORE: <number> where <number> is in [${lo}, ${hi}].`,
      ].join('\n'),
    },
  ];
}

export interface LlmJudgeOutcome {
  quality: number; // normalized 0..1
  /**
   * Usage of the judge call: tokens from the judge response, costUsd priced
   * via the judgeModel's prices entry, latencyMs of the judge call. This is
   * REAL provider spend on live runs and must be counted (M1b).
   */
  usage: Usage;
}

/**
 * Judge call + parse + normalize. Deterministic per (judgeModel, item, answer):
 * the seed derives from all three, so two judge models get INDEPENDENT noise
 * (the calibration story — see runJudgeCalibration).
 */
export async function scoreLlmJudge(
  item: EvalItem,
  answer: string,
  scoring: Extract<ScoringMethod, { kind: 'llm-judge' }>,
  deps: ScorerDeps,
  /** Judge completion budget override (G1.1: verbose judges — sonnet-class
   * emits field-by-field analysis before its SCORE line and truncates at
   * the default protocol cap → parse-fail → 0). Callers that raise it MUST
   * bind their cost projection to the same value. */
  maxTokens: number = PROTOCOL_MAX_TOKENS,
): Promise<LlmJudgeOutcome> {
  const entry = deps.prices.entries.find(
    (e) => e.alias === scoring.judgeModel || e.model === scoring.judgeModel,
  );
  if (!entry) throw new Error(`llm-judge: unknown judge model '${scoring.judgeModel}' in prices table`);
  const provider = deps.providers[entry.provider];
  // Masked to 31 bits — the seed-range bug's THIRD instance (2026-08-24):
  // FNV is unsigned 32-bit, and several OpenRouter upstreams reject seeds
  // >= 2^31 with the generic 'Provider returned error'. First found in
  // baseSeedOf (multi-stage strategies), then here, where it deterministically
  // killed every live judge call whose (judge, item, answer) hashed high —
  // including the whole G8 calibration run.
  const seed = hashString(`${scoring.judgeModel}|${item.id}|${answer}`) & 0x7fffffff;
  const response = await provider.complete({
    model: scoring.judgeModel,
    messages: buildJudgeScoreMessages(item, answer, scoring),
    // One-line protocol ("SCORE: <x>") → bounded output, so the preflight
    // estimator can bound judge spend. Truncation past the cap makes the
    // strict last-line parse fail loudly, never a silently wrong score.
    params: { seed, maxTokens },
  });
  const usage: Usage = {
    inputTokens: response.usage.inputTokens,
    outputTokens: response.usage.outputTokens,
    // Same deterministic rounding as strategy usage accounting (core/prices.ts).
    costUsd: roundCost(costUsd(response.usage, entry)),
    latencyMs: response.latencyMs,
  };
  // Strictened (M2-security): LAST line-anchored `SCORE:` occurrence wins
  // (the judge is instructed to answer with exactly one final line; injected
  // or echoed SCORE text earlier in the response is ignored), and the value
  // is clamped to the rubric scale. Unparseable → quality floor 0 (documented
  // conservative rule).
  const v = lastAnchoredValue(response.text, 'SCORE', '-?\\d+(?:\\.\\d+)?');
  const [lo, hi] = scoring.scale;
  if (v === null) return { quality: 0, usage };
  const raw = Math.min(hi, Math.max(lo, Number(v)));
  return { quality: (raw - lo) / (hi - lo), usage };
}

// ---- dispatch ------------------------------------------------------------------

export async function scoreAnswer(
  item: EvalItem,
  answer: string,
  deps?: ScorerDeps,
  judgeMaxTokens?: number,
  /** The answer's tool calls, for 'tool-call' scoring (MIXING M3). */
  toolCalls?: { function: { name: string; arguments: string } }[],
): Promise<ScoreOutcome> {
  const scoring = item.scoring;
  switch (scoring.kind) {
    case 'exact':
      return { quality: scoreExact(answer, item.reference, scoring), scorer: 'exact' };
    case 'field-match':
      return { quality: scoreFieldMatch(answer, item.reference, scoring), scorer: 'field-match' };
    case 'code-exec': {
      const { quality } = await scoreCodeExec(answer, scoring);
      return { quality, scorer: 'code-exec' };
    }
    case 'tool-call':
      return { quality: scoreToolCall(toolCalls, scoring.expect), scorer: 'tool-call' };
    case 'field-contains':
      return { quality: scoreFieldContains(answer, scoring), scorer: 'field-contains' };
    case 'llm-judge': {
      if (!deps) throw new Error('llm-judge scoring requires ScorerDeps (providers + prices)');
      // G1.7: judge completion budget (verbose live judges truncate at the
      // 128-token protocol default — G1.1 finding); the runner binds the
      // projection to the SAME value.
      const judged = await scoreLlmJudge(item, answer, scoring, deps, judgeMaxTokens);
      return {
        quality: judged.quality,
        scorer: `llm-judge:${scoring.judgeModel}`,
        scorerUsage: judged.usage,
      };
    }
  }
}

/** MIXING M3 instrument: the expected tool, with the expected arguments
 * present and equal (a subset match — the model may add optional ones). */
export function scoreToolCall(
  toolCalls: { function: { name: string; arguments: string } }[] | undefined,
  expect: { name: string; arguments?: Record<string, unknown> },
): number {
  const call = toolCalls?.[0];
  if (!call) return 0;
  if (call.function.name !== expect.name) return 0;
  if (!expect.arguments) return 1;
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(call.function.arguments) as Record<string, unknown>; } catch { return 0.5; }
  for (const [k, v] of Object.entries(expect.arguments)) {
    if (JSON.stringify(parsed[k]) !== JSON.stringify(v)) return 0.5;
  }
  return 1;
}
