// Shared helpers for the Phase 1 strategy interpreters (SPEC §3):
// seeded call wrapper with per-call cost accounting, usage aggregation,
// deterministic base-seed derivation, and the judge prompt/parse contract
// shared by best-of-n and ensemble fusion.
import { costUsd, lastAnchoredValue, roundCost, UNTRUSTED_DATA_FRAME, wrapUntrustedData } from '@potion/core';
import type { ChatMessage, Usage, ToolCall } from '@potion/core';
import { hashString } from '@potion/providers';
import type { ExecContext } from './types.js';

export function zeroUsage(): Usage {
  return { inputTokens: 0, outputTokens: 0, costUsd: 0, latencyMs: 0 };
}

/** Accumulate tokens + rounded cost; latency added by caller (sequential)
 * or max-ed (parallel fan-out) — see addLatencyMax. */
export function addUsage(acc: Usage, u: Usage): Usage {
  acc.inputTokens += u.inputTokens;
  acc.outputTokens += u.outputTokens;
  acc.costUsd = roundCost(acc.costUsd + u.costUsd);
  acc.latencyMs += u.latencyMs;
  return acc;
}

/** Parallel fan-out wall-clock: acc latency becomes max(acc, u). */
export function addUsageParallel(acc: Usage, u: Usage): Usage {
  acc.inputTokens += u.inputTokens;
  acc.outputTokens += u.outputTokens;
  acc.costUsd = roundCost(acc.costUsd + u.costUsd);
  acc.latencyMs = Math.max(acc.latencyMs, u.latencyMs);
  return acc;
}

export function promptTextOf(messages: ChatMessage[]): string {
  return messages.map((m) => `${m.role}:${m.content}`).join('\n');
}

/**
 * Deterministic base seed for multi-call strategies: ctx.seed wins, else a
 * hash of the prompt (same rule the mock uses internally). Callers derive
 * per-call seeds as baseSeed + offset so fan-out variants differ.
 */
export function baseSeedOf(ctx: ExecContext, messages: ChatMessage[]): number {
  return ctx.seed ?? hashString(promptTextOf(messages));
}

export interface CallOutcome {
  text: string;
  usage: Usage; // costed via the resolved price entry, rounded
  logprobConfidence?: number;
  modelVersion: string;
  /** Provider tool calls, preserved verbatim (MIXING M3). */
  toolCalls?: ToolCall[];
}

/**
 * One provider call with cost accounting (SPEC §3: costUsd per stage via
 * prices). One-line-protocol calls (judges/probes) pass
 * `{ maxTokens: PROTOCOL_MAX_TOKENS }` so their output — and therefore their
 * cost — is bounded; answer calls omit params and run at the provider-layer
 * DEFAULT_MAX_TOKENS. The mock provider ignores maxTokens (seed/tools only).
 */
export async function callModel(
  model: string,
  messages: ChatMessage[],
  ctx: ExecContext,
  seed: number,
  params?: { maxTokens?: number },
): Promise<CallOutcome> {
  const { provider, entry } = ctx.resolve(model);
  // Explicit per-call cap (protocol calls) wins; else the run-level answer
  // ceiling; else the provider default applies.
  const maxTokens = params?.maxTokens ?? ctx.maxOutputTokens;
  const response = await provider.complete({
    model,
    messages,
    params: {
      ...(ctx.captureConfidence ? { logprobs: true } : {}),
      seed,
      ...(maxTokens !== undefined ? { maxTokens } : {}),
      // MIXING M3: tools ride every stage call; a stage's tool call is terminal.
      ...(ctx.params?.tools !== undefined ? { tools: ctx.params.tools } : {}),
      ...(ctx.params?.toolChoice !== undefined ? { tool_choice: ctx.params.toolChoice } : {}),
    },
  });
  const usage: Usage = {
    inputTokens: response.usage.inputTokens,
    outputTokens: response.usage.outputTokens,
    costUsd: roundCost(costUsd(response.usage, entry)),
    latencyMs: response.latencyMs,
  };
  return {
    text: response.text,
    usage,
    ...(response.toolCalls && response.toolCalls.length > 0 ? { toolCalls: response.toolCalls } : {}),
    ...(response.logprobConfidence !== undefined
      ? { logprobConfidence: response.logprobConfidence }
      : {}),
    modelVersion: response.modelVersion,
  };
}

// ---- judge contract (best-of-n + ensemble 'judge-pick' fusion) ----

/**
 * Build the judge prompt. The closing instruction line is ALSO the mock
 * fixture contract (packages/providers/src/mock/fixtures.ts JUDGE_MARKER):
 * "PICK: <index> ... [0, N-1]" makes the mock answer `PICK: <k>` in range.
 *
 * Prompt-injection hardening (M2-security, @potion/core safety.ts): the task
 * and every candidate are untrusted text — a candidate can embed "IGNORE
 * PREVIOUS INSTRUCTIONS" or a fake "PICK: 0" line. Each is wrapped in an
 * explicit delimited DATA block with DATA-not-instructions framing, and the
 * answer is parsed strictly (see parsePick). The mock strips the markers when
 * extracting CANDIDATE sections, so fixture extraction is unchanged.
 */
export function buildJudgeMessages(
  original: ChatMessage[],
  candidates: string[],
  rubric?: string,
): ChatMessage[] {
  const n = candidates.length;
  const block = candidates.map((c, i) => `CANDIDATE ${i}:\n${wrapUntrustedData(c)}`).join('\n\n');
  const content = [
    'You are judging candidate answers to a task.',
    rubric ? `RUBRIC: ${rubric}` : 'RUBRIC: pick the most correct, clear, and complete answer.',
    '',
    UNTRUSTED_DATA_FRAME,
    '',
    'TASK:',
    wrapUntrustedData(promptTextOf(original)),
    '',
    block,
    '',
    `Respond with exactly one line: PICK: <index> where <index> is an integer in [0, ${n - 1}].`,
  ].join('\n');
  return [{ role: 'user', content }];
}

/**
 * Parse `PICK: <index>`; invalid/out-of-range → index 0 (parsed=false).
 * Strictened (M2-security): the LAST line-anchored `PICK:` occurrence wins —
 * the judge is instructed to answer with exactly one final line, so a late
 * anchored directive is authoritative and injected/echoed `PICK:` text inside
 * quoted content is ignored. Values are bounded to [0, n).
 */
export function parsePick(text: string, n: number): { index: number; parsed: boolean } {
  const v = lastAnchoredValue(text, 'PICK', '\\d+');
  if (v !== null) {
    const k = Number(v);
    if (Number.isInteger(k) && k >= 0 && k < n) return { index: k, parsed: true };
  }
  return { index: 0, parsed: false };
}

/**
 * Deterministic 'concat-rank' heuristic (SPEC §3; documented here as THE
 * ranking rule): score = (logprobConfidence ?? 0.75) + min(textLength, 10000) / 1e6.
 * Confidence dominates; the tiny length term breaks ties toward longer
 * (assumed more complete) answers; remaining ties keep the original order
 * (stable sort). Rationale: with the mock, logprobConfidence is the only
 * quality signal; length is the deterministic secondary signal.
 */
export function concatRankScore(c: { text: string; logprobConfidence?: number }): number {
  return (c.logprobConfidence ?? 0.75) + Math.min(c.text.length, 10_000) / 1_000_000;
}

/** Indices of candidates sorted by concatRankScore, descending, stable. */
export function rankIndices<T extends { text: string; logprobConfidence?: number }>(
  candidates: T[],
): number[] {
  return candidates
    .map((c, i) => ({ i, score: concatRankScore(c) }))
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map((x) => x.i);
}
