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

export function scoreExact(
  answer: string,
  reference: unknown,
  scoring: Extract<ScoringMethod, { kind: 'exact' }>,
): number {
  let ref = reference;
  if (scoring.field && ref !== null && typeof ref === 'object') {
    ref = (ref as Record<string, unknown>)[scoring.field];
  }
  return normalizeText(String(ref ?? '')) === normalizeText(answer) ? 1 : 0;
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
  const seed = hashString(`${scoring.judgeModel}|${item.id}|${answer}`);
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
    case 'llm-judge': {
      if (!deps) throw new Error('llm-judge scoring requires ScorerDeps (providers + prices)');
      const judged = await scoreLlmJudge(item, answer, scoring, deps);
      return {
        quality: judged.quality,
        scorer: `llm-judge:${scoring.judgeModel}`,
        scorerUsage: judged.usage,
      };
    }
  }
}
