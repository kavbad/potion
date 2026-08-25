// `ensemble` strategy interpreter (SPEC §3): all models in parallel
// (Promise.all), then fusion per FusionConfig:
//  - 'judge-pick'   : one judge call returns `PICK: <index>`; that candidate wins.
//  - 'concat-rank'  : deterministic ranking (see concatRankScore in helpers.ts:
//                     confidence primary, length tiebreak, stable) and the
//                     candidates are concatenated in ranked order with headers.
//  - 'exec-pick'    : R4 (2026-08-24). A test-writer model derives a JS test
//                     snippet FROM THE REQUEST ONLY (in parallel with the
//                     candidates — it needs nothing from them), every
//                     candidate runs against it in the code-exec sandbox,
//                     highest pass count wins. Ties — including "the tests
//                     were unusable", which scores every candidate -1 —
//                     fall back to judge-pick over the tied candidates,
//                     then to confidence rank. The reference answer is
//                     never visible to any of this: the shape is servable
//                     verbatim.
// Usage/cost aggregated across all calls; candidate fan-out latency = max.
import type { ChatMessage, StrategyConfig } from '@potion/core';
import { PROTOCOL_MAX_TOKENS } from '@potion/core';
import {
  addUsage,
  addUsageParallel,
  baseSeedOf,
  buildJudgeMessages,
  callModel,
  parsePick,
  rankIndices,
  zeroUsage,
} from './helpers.js';
import { runCodeWithTests, stripCodeFences } from './exec-sandbox.js';
import type { ExecContext, StageTrace, StrategyResult } from './types.js';

type EnsembleConfig = Extract<StrategyConfig, { type: 'ensemble' }>;

/** The test-writer wire: request context + an instruction to write tests for
 * the sandbox's exact dialect. Deliberately forbids an implementation — a
 * writer that answers the request instead of testing it produces a snippet
 * whose load fails, which scores every candidate -1 and degrades to the
 * judge/confidence fallback rather than crowning anyone. */
export function buildTestWriterMessages(original: ChatMessage[]): ChatMessage[] {
  return [
    ...original,
    {
      role: 'user',
      content:
        'Do NOT answer the request above. Instead, write a JavaScript test snippet for the requested functionality. ' +
        'The sandbox provides: test(name, fn), assert(cond, msg), assertDeepEqual(actual, expected). ' +
        'Write 3 to 8 focused test() cases derived ONLY from what the request itself states or clearly implies. ' +
        'Do not define or include the implementation. Return only the test code — no markdown fences, no prose.',
    },
  ];
}

export async function runEnsemble(
  strategy: EnsembleConfig,
  messages: ChatMessage[],
  ctx: ExecContext,
): Promise<StrategyResult> {
  if (strategy.models.length === 0) throw new Error('ensemble requires at least one model');
  const baseSeed = baseSeedOf(ctx, messages);
  const trace: StageTrace[] = [];
  const total = zeroUsage();

  const execPick = strategy.fusion.method === 'exec-pick';
  // Selector stabilization (2026-08-25): one wrong test suite used to BE the
  // verdict. With N independent writers the candidate score is the mean pass
  // rate across suites — majority by execution. testWriters wins over the
  // legacy singular field; writer 0 keeps the singular field's seed so every
  // existing single-writer shape stays cache-identical.
  const writers = execPick
    ? strategy.fusion.testWriters && strategy.fusion.testWriters.length > 0
      ? strategy.fusion.testWriters
      : strategy.fusion.testWriter
        ? [strategy.fusion.testWriter]
        : []
    : [];
  if (execPick && writers.length === 0) {
    throw new Error("ensemble fusion 'exec-pick' requires fusion.testWriter or fusion.testWriters");
  }

  // exec-pick's test-writers need only the request, so they ride the same
  // parallel fan-out as the candidates — zero added latency on the happy path.
  const [candidates, writerOutcomes] = await Promise.all([
    Promise.all(strategy.models.map((model, i) => callModel(model, messages, ctx, baseSeed + i))),
    Promise.all(
      writers.map((w, wi) =>
        callModel(w.model, buildTestWriterMessages(messages), ctx, baseSeed + strategy.models.length + 1 + wi),
      ),
    ),
  ]);
  candidates.forEach((c, i) => {
    addUsageParallel(total, c.usage);
    trace.push({
      stage: `candidate-${i}`,
      model: strategy.models[i]!,
      text: c.text,
      usage: c.usage,
      ...(c.logprobConfidence !== undefined ? { confidence: c.logprobConfidence } : {}),
    });
  });

  if (execPick) {
    const suites: string[] = [];
    writerOutcomes.forEach((o, wi) => {
      addUsageParallel(total, o.usage);
      trace.push({
        stage: writers.length === 1 ? 'test-writer' : `test-writer-${wi}`,
        model: writers[wi]!.model,
        text: o.text,
        usage: o.usage,
      });
      suites.push(stripCodeFences(o.text));
    });
    // Sandbox runs are sequential (one worker at a time, same as the scorer);
    // structural failure or zero registered cases → -1 = "cannot attest".
    // A candidate whose own code fails to load earns its -1 in every suite;
    // a suite broken for everyone gives everyone the same -1 — no bias.
    const scores: number[] = new Array<number>(candidates.length).fill(0);
    const verdicts: string[] = candidates.map(() => '');
    for (let wi = 0; wi < suites.length; wi++) {
      for (let ci = 0; ci < candidates.length; ci++) {
        const report = await runCodeWithTests(stripCodeFences(candidates[ci]!.text), suites[wi]!);
        const unusable = report.error !== undefined || report.total === 0;
        const rate = unusable ? -1 : report.passed / report.total;
        scores[ci]! += rate / suites.length;
        verdicts[ci] +=
          (wi > 0 ? '+' : '') +
          (unusable ? `error(${(report.error ?? 'no cases').slice(0, 60)})` : `${report.passed}/${report.total}`);
      }
    }
    const top = Math.max(...scores);
    const tied = scores.map((s, i) => (s === top ? i : -1)).filter((i) => i >= 0);
    let index = tied[0]!;
    let how = `exec:${verdicts.join('|')}`;
    if (tied.length > 1) {
      const judge = strategy.fusion.judge;
      if (judge) {
        const judgeOutcome = await callModel(
          judge.model,
          buildJudgeMessages(messages, tied.map((i) => candidates[i]!.text), judge.rubric),
          ctx,
          baseSeed + strategy.models.length,
          { maxTokens: PROTOCOL_MAX_TOKENS },
        );
        addUsage(total, judgeOutcome.usage);
        const { index: within, parsed } = parsePick(judgeOutcome.text, tied.length);
        index = tied[within]!;
        how += `;tie-judge:${index}${parsed ? '' : ';unparseable-judge-answer-default-0'}`;
        trace.push({ stage: 'tie-judge', model: judge.model, text: judgeOutcome.text, usage: judgeOutcome.usage });
      } else {
        const order = rankIndices(candidates);
        index = order.find((i) => tied.includes(i)) ?? tied[0]!;
        how += `;tie-confidence:${index}`;
      }
    }
    trace.push({
      stage: 'fusion-exec',
      model: 'sandbox',
      text: candidates[index]!.text,
      usage: zeroUsage(),
      decision: `exec-pick:${index};${how}`,
    });
    return { text: candidates[index]!.text, trace, usage: total };
  }

  if (strategy.fusion.method === 'judge-pick') {
    const judge = strategy.fusion.judge;
    if (!judge) throw new Error("ensemble fusion 'judge-pick' requires fusion.judge");
    const judgeOutcome = await callModel(
      judge.model,
      buildJudgeMessages(messages, candidates.map((c) => c.text), judge.rubric),
      ctx,
      baseSeed + strategy.models.length,
      { maxTokens: PROTOCOL_MAX_TOKENS },
    );
    addUsage(total, judgeOutcome.usage);
    const { index, parsed } = parsePick(judgeOutcome.text, candidates.length);
    trace.push({
      stage: 'fusion-judge',
      model: judge.model,
      text: judgeOutcome.text,
      usage: judgeOutcome.usage,
      decision: `judge-pick:${index}${parsed ? '' : ';unparseable-judge-answer-default-0'}`,
    });
    return { text: candidates[index]!.text, trace, usage: total };
  }

  // concat-rank: deterministic, no extra calls.
  const order = rankIndices(candidates);
  const text = order
    .map((idx, rank) => `## ${strategy.models[idx]} (rank ${rank + 1})\n${candidates[idx]!.text}`)
    .join('\n\n');
  trace.push({
    stage: 'fusion',
    model: 'deterministic',
    text,
    usage: zeroUsage(),
    decision: `concat-rank:order=[${order.join(',')}]`,
  });
  return { text, trace, usage: total };
}
