// `decompose` strategy interpreter (SPEC §3): the decomposer model must emit
// JSON `[{"kind":"...","prompt":"..."}]`; parse tolerantly (strip markdown
// fences); route each subtask via routing[kind] with routing['*'] fallback;
// execute each with `single`; fuse results via FusionConfig if provided, else
// concatenate with headers. Trace records subtasks + routing decisions.
import type { ChatMessage, StrategyConfig } from '@potion/core';
import {
  addUsage,
  baseSeedOf,
  buildJudgeMessages,
  callModel,
  parsePick,
  rankIndices,
  zeroUsage,
} from './helpers.js';
import { runSingle } from './single.js';
import type { ExecContext, StageTrace, StrategyResult } from './types.js';

type DecomposeConfig = Extract<StrategyConfig, { type: 'decompose' }>;

export interface Subtask {
  kind: string;
  prompt: string;
}

// Decompose hardening caps (M2-security, ROADMAP §19): the decomposer output
// is untrusted model text. Unbounded arrays = fan-out DoS (each subtask is a
// paid model call); unbounded prompts = token-budget abuse; arbitrary kind
// strings = routing-key probing (prototype keys like 'constructor') and
// trace-entry forgery via the `subtask-<i>:<kind>` stage label.
/** Max subtasks executed; longer decomposer arrays are truncated. */
export const MAX_SUBTASKS = 8;
/** Max chars per subtask prompt; longer prompts are truncated. */
export const MAX_SUBTASK_PROMPT_CHARS = 4000;
/** Safe routing-key shape; other kinds are coerced to INVALID_KIND. */
const KIND_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,31}$/;
/** Replacement kind for decomposer output with an unsafe kind string. */
export const INVALID_KIND = 'invalid-kind';

/**
 * The decompose instruction. This wording is ALSO the mock fixture contract
 * (DECOMPOSE_MARKER + DECOMPOSE_SHAPE_MARKER): "JSON array of subtasks" +
 * `{"kind"` makes the mock answer with a valid deterministic JSON array.
 */
export const DECOMPOSE_INSTRUCTION =
  'Break the task above into subtasks. Respond with a JSON array of subtasks, ' +
  'each of the form {"kind": "...", "prompt": "..."}, and nothing else.';

/**
 * Tolerant subtask parse: strip markdown fences, slice the outermost [...],
 * then apply the hardening caps (M2-security): at most MAX_SUBTASKS subtasks
 * (first-N wins), each prompt truncated to MAX_SUBTASK_PROMPT_CHARS, and each
 * kind coerced to INVALID_KIND unless it matches the safe routing-key shape
 * (routing itself is an allowlist against the routing table's own keys — see
 * runDecompose).
 */
export function parseSubtasks(text: string): Subtask[] {
  let cleaned = text.trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(cleaned);
  if (fence) cleaned = fence[1]!.trim();
  const start = cleaned.indexOf('[');
  const end = cleaned.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`decompose: could not find a JSON array in decomposer output: ${text}`);
  }
  const parsed: unknown = JSON.parse(cleaned.slice(start, end + 1));
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('decompose: decomposer output is not a non-empty JSON array');
  }
  return parsed.slice(0, MAX_SUBTASKS).map((item, i) => {
    const s = item as Partial<Subtask>;
    if (typeof s?.kind !== 'string' || typeof s?.prompt !== 'string') {
      throw new Error(`decompose: subtask ${i} lacks string kind/prompt fields`);
    }
    return {
      kind: KIND_PATTERN.test(s.kind) ? s.kind : INVALID_KIND,
      prompt: s.prompt.slice(0, MAX_SUBTASK_PROMPT_CHARS),
    };
  });
}

export async function runDecompose(
  strategy: DecomposeConfig,
  messages: ChatMessage[],
  ctx: ExecContext,
): Promise<StrategyResult> {
  const baseSeed = baseSeedOf(ctx, messages);
  const trace: StageTrace[] = [];
  const total = zeroUsage();

  const decomposed = await callModel(
    strategy.decomposerModel,
    [...messages, { role: 'user', content: DECOMPOSE_INSTRUCTION }],
    ctx,
    baseSeed,
  );
  addUsage(total, decomposed.usage);
  trace.push({
    stage: 'decompose',
    model: strategy.decomposerModel,
    text: decomposed.text,
    usage: decomposed.usage,
  });

  const subtasks = parseSubtasks(decomposed.text);

  // Execute each subtask via `single` (sequential → latency summed). ctx.stream
  // is deliberately NOT propagated: streaming is honored only by top-level 'single'.
  const results: string[] = [];
  for (let i = 0; i < subtasks.length; i++) {
    const st = subtasks[i]!;
    // Kind allowlist (M2-security): direct routing ONLY for kinds that are
    // OWN enumerable keys of the routing table — never inherited prototype
    // keys ('constructor', 'hasOwnProperty', …). Everything else falls back
    // to '*' or throws.
    const direct = Object.hasOwn(strategy.routing, st.kind) ? strategy.routing[st.kind] : undefined;
    const model = direct ?? (Object.hasOwn(strategy.routing, '*') ? strategy.routing['*'] : undefined);
    if (!model) {
      throw new Error(
        `decompose: no routing for subtask kind '${st.kind}' and no '*' fallback`,
      );
    }
    const subCtx: ExecContext = {
      providers: ctx.providers,
      prices: ctx.prices,
      resolve: ctx.resolve,
      seed: baseSeed + 1 + i,
    };
    const r = await runSingle(model, [{ role: 'user', content: st.prompt }], subCtx);
    addUsage(total, r.usage);
    results.push(r.text);
    trace.push({
      stage: `subtask-${i}:${st.kind}`,
      model,
      text: r.text,
      usage: r.usage,
      decision: direct ? `routed:${st.kind}->${model}` : `routed:*->${model}`,
    });
  }

  // Fusion: judge-pick / concat-rank when configured, else header concat.
  if (strategy.fusion?.method === 'judge-pick') {
    const judge = strategy.fusion.judge;
    if (!judge) throw new Error("decompose fusion 'judge-pick' requires fusion.judge");
    const judgeOutcome = await callModel(
      judge.model,
      buildJudgeMessages(messages, results, judge.rubric),
      ctx,
      baseSeed + 1 + subtasks.length,
    );
    addUsage(total, judgeOutcome.usage);
    const { index, parsed } = parsePick(judgeOutcome.text, results.length);
    trace.push({
      stage: 'fusion-judge',
      model: judge.model,
      text: judgeOutcome.text,
      usage: judgeOutcome.usage,
      decision: `judge-pick:${index}${parsed ? '' : ';unparseable-judge-answer-default-0'}`,
    });
    return { text: results[index]!, trace, usage: total };
  }

  if (strategy.fusion?.method === 'concat-rank') {
    const ranked = rankIndices(results.map((t) => ({ text: t })));
    const text = ranked
      .map((idx, rank) => `## Subtask ${idx} (${subtasks[idx]!.kind}) (rank ${rank + 1})\n${results[idx]}`)
      .join('\n\n');
    trace.push({
      stage: 'fusion',
      model: 'deterministic',
      text,
      usage: zeroUsage(),
      decision: `concat-rank:order=[${ranked.join(',')}]`,
    });
    return { text, trace, usage: total };
  }

  const text = subtasks
    .map((st, i) => `## Subtask ${i} (${st.kind})\n${results[i]}`)
    .join('\n\n');
  return { text, trace, usage: total };
}
