// Serve-time judge scoring (G0.1, guarantee product): score a SAMPLED served
// answer with a REAL llm-judge call — the guarantee loop's quality signal.
// Replaces the retired Jaccard-vs-prompt stub (which measured lexical prompt
// overlap, not quality).
//
// Honesty contract: the serving path has NO reference answer, so the rubric
// judges task completion / correctness / instruction-following against the
// request itself — this is reference-free judging and is labeled as such in
// the evidence row (`scorer: 'llm-judge:<model>'`). Reference-anchored
// replays and judge calibration land in G0.2/G1.4.
//
// Reuses scoreLlmJudge wholesale: hardened prompt (UNTRUSTED_DATA framing),
// PROTOCOL_MAX_TOKENS output cap, LAST-line-anchored SCORE parse, clamped
// scale, judge usage/cost accounting. Deterministic in mock mode: the mock
// judge fixture answers the SCORE protocol seeded by
// hash(judgeModel|requestId|answer), corruption 0.
import type { ChatMessage, EvalItem } from '@potion/core';
import { scoreLlmJudge, type LlmJudgeOutcome, type ScorerDeps } from './scorers.js';

/**
 * Reference-free serve rubric. Style is explicitly out of scope — the
 * guarantee floor is about task outcomes, not tone.
 */
export const SERVE_JUDGE_RUBRIC =
  "Score how well the ANSWER completes the user's request in the TASK. " +
  'Judge task completion, correctness, and instruction-following only; ' +
  'ignore style and verbosity. There is no reference answer — evaluate ' +
  'against the request itself. Use the full scale: 0 = fails the request ' +
  'entirely, 10 = fully and correctly completes it.';

/** Serve-judge scale ([0,10] → normalized 0..1 by scoreLlmJudge). */
export const SERVE_JUDGE_SCALE: [number, number] = [0, 10];

/**
 * Platform default judge aliases (prices.json): a real judge-class model on
 * live provider sets, the deterministic mock judge fixture otherwise. A
 * policy's guarantee.judgeModel overrides both.
 */
export const DEFAULT_SERVE_JUDGE_MODELS = { live: 'judge-class', mock: 'mock-judge' } as const;

export function defaultServeJudgeModel(providerMode: 'live' | 'mock' | 'unknown'): string {
  return providerMode === 'live' ? DEFAULT_SERVE_JUDGE_MODELS.live : DEFAULT_SERVE_JUDGE_MODELS.mock;
}

export interface ScoreServedAnswerParams {
  /** Chat completion id (chatcmpl-…) — seeds the judge deterministically. */
  requestId: string;
  clusterId: string;
  /** The served request's messages, verbatim (the TASK block). */
  messages: ChatMessage[];
  /** The served answer text. */
  answerText: string;
  /** Judge model alias (caller resolves config override vs platform default). */
  judgeModel: string;
}

export interface ServedAnswerScore extends LlmJudgeOutcome {
  /** Evidence label, e.g. 'llm-judge:judge-class'. */
  scorer: string;
}

/**
 * Score one served answer. Throws on unknown judge alias or judge-call
 * failure — callers on the serving path wrap in their own never-throws
 * boundary (runGuaranteeSample) and drop the sample loudly.
 */
export async function scoreServedAnswer(
  params: ScoreServedAnswerParams,
  deps: ScorerDeps,
): Promise<ServedAnswerScore> {
  const scoring = {
    kind: 'llm-judge' as const,
    rubric: SERVE_JUDGE_RUBRIC,
    judgeModel: params.judgeModel,
    scale: SERVE_JUDGE_SCALE,
  };
  const item: EvalItem = {
    id: params.requestId,
    clusterId: params.clusterId,
    prompt: params.messages,
    scoring,
  };
  const outcome = await scoreLlmJudge(item, params.answerText, scoring, deps);
  return { ...outcome, scorer: `llm-judge:${params.judgeModel}` };
}
