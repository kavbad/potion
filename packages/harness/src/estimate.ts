// Preflight cost projection (SPEC §5): refuse to start a run whose PROJECTED
// spend exceeds budgetCapUsd. The projection is a WORST-CASE UPPER BOUND BY
// CONSTRUCTION, not a typical-cost estimate (M1b lesson: the old 80-token
// output model was calibrated to mock answers and actuals ran 2.3× over —
// preflight refusal must dominate actuals or it is theater):
//
//   · Every answering call's output is bounded by the provider layer:
//     DEFAULT_MAX_TOKENS is now sent on EVERY live transport (openai-shaped
//     included), so ANSWER_OUTPUT_TOKENS = DEFAULT_MAX_TOKENS is an enforced
//     ceiling, not a guess.
//   · Every one-line-protocol call (judge PICK / SCORE, self-report
//     CONFIDENCE) runs with maxTokens: PROTOCOL_MAX_TOKENS at its call site,
//     so PROTOCOL_OUTPUT_TOKENS = PROTOCOL_MAX_TOKENS is likewise enforced.
//   · Any answer embedded in a judge/verify/probe prompt is modeled at its
//     producer's ceiling (DEFAULT_MAX_TOKENS input tokens).
//   · calls(strategy) is the worst case: every cascade stage escalates and
//     every non-final stage with an escalateIf threshold probes (the logprob
//     method ALSO probes when the provider returns no logprobs); decompose
//     fans out to MAX_SUBTASKS subtasks, each priced at the most expensive
//     routable model; composite starts, probes, and upgrades.
//   · llm-judge scoring adds ONE judge call per (strategy × item); its
//     scaffolding is measured from the REAL prompt builder
//     (buildJudgeScoreMessages) so template drift cannot silently break the
//     bound.
//
// Input tokens remain the chars/4 heuristic (mock-consistent; tokenizers
// vary ±30%). The enforced output ceilings dominate the total — validated
// against the recorded M1b sweep (artifacts/m1b-sweep-*.json): projection
// ≥ actual per suite, per (suite × strategy), and in total; see
// estimate-m1b-regression.test.ts.
//
// Cost per call = (input·inputPer1M + output·outputPer1M) / 1e6 with the
// call's model price entry.
import { PROMPT_VARIANT_TOKENS, REASONING_BUDGET_TOKENS } from '@potion/core';
import type { ChatMessage, EvalItem, PriceEntry, PriceTable, ProgramCheck, ProgramNode, StrategyConfig, Tool } from '@potion/core';
import { PROTOCOL_MAX_TOKENS } from '@potion/core';
import { DEFAULT_MAX_TOKENS } from '@potion/providers';
import { CODE_EXEC_TIMEOUT_MS, CODE_EXEC_WALL_SLACK_MS, MAX_SUBTASKS } from '@potion/strategies';
import { buildJudgeScoreMessages } from './scorers.js';

/** Enforced output ceiling for an answering call (provider-layer max_tokens). */
export const ANSWER_OUTPUT_TOKENS = DEFAULT_MAX_TOKENS;
/** Enforced output ceiling for one-line-protocol (judge/probe) calls. */
export const PROTOCOL_OUTPUT_TOKENS = PROTOCOL_MAX_TOKENS;
/**
 * Worst-case input tokens for an answer embedded in a judge/verify/probe
 * prompt: the embedded text was produced by a call bounded at
 * DEFAULT_MAX_TOKENS, so its ceiling is exactly that.
 */
export const EMBEDDED_ANSWER_TOKENS = DEFAULT_MAX_TOKENS;

export function promptCharsOf(messages: ChatMessage[]): number {
  return messages.reduce((a, m) => a + m.role.length + 1 + m.content.length, 0);
}

/** Tool DEFINITIONS are input, on every call. Serialized JSON is the honest
 *  proxy for what a transport sends — verbose schemas cost verbose money, and
 *  an agent offering twenty tools can pay more for the catalogue than for the
 *  question. Unpriced until C4 rung 4, which is the direction this bound must
 *  never get wrong. */
export function toolCharsOf(tools: Tool[] | undefined): number {
  return tools === undefined ? 0 : JSON.stringify(tools).length;
}

export function inputTokensOf(item: EvalItem): number {
  return Math.ceil((promptCharsOf(item.prompt) + toolCharsOf(item.tools)) / 4);
}

interface CallEstimate {
  model: string;
  inputTokens: number;
  outputTokens: number;
  /**
   * Runtime-routed calls (decompose subtasks): the model is decided by the
   * decomposer's output, so the worst case prices the call at the most
   * expensive candidate. When set, `model` is just the first candidate.
   */
  candidateModels?: string[];
}

/**
 * Worst-case per-item call plan for a strategy (model + token bound per call).
 */
/**
 * @param answerOutputTokens the ENFORCED per-call output ceiling for answer
 * calls in this run (RunEvalOptions.maxOutputTokens → ExecContext; default
 * DEFAULT_MAX_TOKENS). The projection binds to the configured value so a
 * workload that raises its ceiling gets a correspondingly larger bound —
 * never a bound achieved by silently truncating output.
 */
export function estimateCalls(
  strategy: StrategyConfig,
  baseInputTokens: number,
  answerOutputTokens: number = ANSWER_OUTPUT_TOKENS,
): CallEstimate[] {
  const OUT = answerOutputTokens;
  const EMBED = answerOutputTokens;
  switch (strategy.type) {
    case 'single':
      return [{ model: strategy.model, inputTokens: baseInputTokens, outputTokens: OUT }];
    case 'cascade': {
      const calls: CallEstimate[] = [];
      const stages = strategy.stages;
      stages.forEach((stage, i) => {
        calls.push({ model: stage.model, inputTokens: baseInputTokens, outputTokens: OUT });
        const isFinal = i === stages.length - 1;
        // Worst case probes for EVERY confidence method: 'logprob' falls back
        // to a self-report probe when the provider exposes no logprobs
        // (cascade.ts), so any non-final stage with a threshold may probe.
        if (!isFinal && stage.escalateIf?.confidenceBelow !== undefined) {
          calls.push({
            model: stage.model,
            inputTokens: baseInputTokens + EMBED,
            outputTokens: PROTOCOL_OUTPUT_TOKENS,
          });
        }
      });
      return calls;
    }
    case 'best-of-n': {
      const calls: CallEstimate[] = [];
      for (let i = 0; i < strategy.n; i++) {
        calls.push({ model: strategy.model, inputTokens: baseInputTokens, outputTokens: OUT });
      }
      calls.push({
        model: strategy.judge.model,
        inputTokens: baseInputTokens + strategy.n * EMBED,
        outputTokens: PROTOCOL_OUTPUT_TOKENS,
      });
      return calls;
    }
    case 'draft-verify':
      return [
        { model: strategy.draftModel, inputTokens: baseInputTokens, outputTokens: OUT },
        {
          model: strategy.verifierModel,
          inputTokens: baseInputTokens + EMBED,
          outputTokens: OUT,
        },
      ];
    case 'ensemble': {
      const calls: CallEstimate[] = strategy.models.map((model) => ({
        model,
        inputTokens: baseInputTokens,
        outputTokens: OUT,
      }));
      // exec-pick (R4): every test-writer answers the request-derived wire at
      // the answer ceiling; the judge is the tie-break and fires in the
      // worst case, so it is priced whenever configured.
      if (strategy.fusion.method === 'exec-pick' || strategy.fusion.method === 'verify-pick') {
        const writers = strategy.fusion.testWriters?.length
          ? strategy.fusion.testWriters
          : strategy.fusion.testWriter
            ? [strategy.fusion.testWriter]
            : [];
        for (const w of writers) {
          calls.push({ model: w.model, inputTokens: baseInputTokens, outputTokens: OUT });
        }
      }
      if ((strategy.fusion.method === 'judge-pick' || strategy.fusion.method === 'exec-pick' || strategy.fusion.method === 'verify-pick') && strategy.fusion.judge) {
        calls.push({
          model: strategy.fusion.judge.model,
          inputTokens: baseInputTokens + strategy.models.length * EMBED,
          outputTokens: PROTOCOL_OUTPUT_TOKENS,
        });
      }
      return calls;
    }
    case 'decompose': {
      // Worst-case fan-out (decompose.ts hardening caps): 1 decompose call +
      // MAX_SUBTASKS routed subtask calls + optional judge fusion. Routing is
      // decided at runtime by the decomposer's output, so each subtask is
      // priced at the MOST EXPENSIVE routable model.
      const calls: CallEstimate[] = [
        { model: strategy.decomposerModel, inputTokens: baseInputTokens, outputTokens: OUT },
      ];
      const routable = [...new Set([...Object.values(strategy.routing), strategy.decomposerModel])];
      for (let i = 0; i < MAX_SUBTASKS; i++) {
        calls.push({
          model: routable[0]!,
          candidateModels: routable,
          inputTokens: baseInputTokens + EMBED,
          outputTokens: OUT,
        });
      }
      if (strategy.fusion?.method === 'judge-pick' && strategy.fusion.judge) {
        calls.push({
          model: strategy.fusion.judge.model,
          inputTokens: baseInputTokens + MAX_SUBTASKS * EMBED,
          outputTokens: PROTOCOL_OUTPUT_TOKENS,
        });
      }
      return calls;
    }
    case 'program': {
      // Worst case: every call node fires once at the answer ceiling (the
      // interpreter memoizes per node, so never more); a judge pick costs one
      // judge call over the candidates' texts.
      const calls: CallEstimate[] = [];
      const walkCheck = (c: ProgramCheck): void => {
        if (c.kind === 'agree') { walk(c.of[0]); walk(c.of[1]); } else walk(c.of);
      };
      const walk = (n: ProgramNode): void => {
        switch (n.op) {
          // C4 — THE RULE FOR THIS BOUND: model everything that makes a call
          // MORE expensive, and nothing that makes it cheaper. A projection
          // that under-estimates is broken (the sweep starts a run it cannot
          // afford and finds out by spending); one that over-estimates is
          // merely loose, and stops early in the safe direction.
          //
          // So: reasoning effort is priced (thinking is billed as output) and
          // a prompt variant's instruction is priced (it is billed as input).
          // NOT priced: `terse` shortening the answer, and `contextSelect`
          // shrinking the prompt. Both are real savings and both show up in
          // MEASURED cost on the frontier — which is the number that decides
          // anything. A preflight claiming them would be guessing in the one
          // direction it must not guess.
          case 'call': calls.push({
            model: n.model,
            inputTokens: baseInputTokens + (n.promptVariant !== undefined ? PROMPT_VARIANT_TOKENS[n.promptVariant] : 0),
            outputTokens: OUT + (n.reasoningEffort !== undefined ? REASONING_BUDGET_TOKENS[n.reasoningEffort] : 0),
          }); return;
          case 'if': walkCheck(n.check); walk(n.then); walk(n.else); return;
          case 'vote': n.of.forEach(walk); return;
          case 'pick': n.of.forEach(walk); if (n.by.kind === 'judge') calls.push({ model: n.by.model, inputTokens: baseInputTokens + n.of.length * OUT, outputTokens: 64 }); return;
        }
      };
      walk(strategy.body);
      return calls;
    }
    case 'composite': {
      // M3 #23 (SPEC §12.6), worst case: start call + self-report probe (the
      // provider exposes no logprob confidence) + the upgrade fires with the
      // full start answer as context prefix.
      return [
        { model: strategy.startModel, inputTokens: baseInputTokens, outputTokens: OUT },
        {
          model: strategy.startModel,
          inputTokens: baseInputTokens + EMBED,
          outputTokens: PROTOCOL_OUTPUT_TOKENS,
        },
        {
          model: strategy.upgradeModel,
          inputTokens: baseInputTokens + EMBED,
          outputTokens: OUT,
        },
      ];
    }
  }
}

function entryFor(prices: PriceTable, model: string): PriceEntry {
  const entry = prices.entries.find((e) => e.alias === model || e.model === model);
  if (!entry) {
    throw new Error(`unknown model '${model}' — not an alias or native id in prices.json (version ${prices.version})`);
  }
  return entry;
}

export function estimateCallCostUsd(call: CallEstimate, prices: PriceTable): number {
  // Runtime-routed calls price at the most expensive candidate (worst case).
  const models = call.candidateModels?.length ? call.candidateModels : [call.model];
  return Math.max(
    ...models.map((m) => {
      const entry = entryFor(prices, m);
      return (call.inputTokens * entry.inputPer1M + call.outputTokens * entry.outputPer1M) / 1_000_000;
    }),
  );
}

/**
 * Estimated llm-judge SCORING call for an item (null for deterministic
 * scorers). The prompt scaffolding (instructions, rubric, TASK block,
 * DATA-framing) is MEASURED from the real builder with an empty answer, then
 * the candidate answer is added at its enforced ceiling — template drift in
 * scorers.ts automatically flows into the bound.
 */
export function estimateJudgeScoringCall(
  item: EvalItem,
  answerOutputTokens: number = ANSWER_OUTPUT_TOKENS,
  judgeOutputTokens: number = PROTOCOL_OUTPUT_TOKENS,
): CallEstimate | null {
  if (item.scoring.kind !== 'llm-judge') return null;
  const scaffolding = buildJudgeScoreMessages(item, '', item.scoring);
  return {
    model: item.scoring.judgeModel,
    inputTokens: Math.ceil(promptCharsOf(scaffolding) / 4) + answerOutputTokens,
    // G1.7: the projection binds to the CONFIGURED judge budget (G0.5/G1.1
    // lesson — enforcement caps are config; dependent calculations follow).
    outputTokens: judgeOutputTokens,
  };
}

/**
 * Estimated judge-scoring cost for an item: $0 for deterministic scorers,
 * one priced judge call for llm-judge items (M1b).
 */
export function estimateItemJudgeCostUsd(
  item: EvalItem,
  prices: PriceTable,
  answerOutputTokens: number = ANSWER_OUTPUT_TOKENS,
  judgeOutputTokens: number = PROTOCOL_OUTPUT_TOKENS,
): number {
  const call = estimateJudgeScoringCall(item, answerOutputTokens, judgeOutputTokens);
  return call === null ? 0 : estimateCallCostUsd(call, prices);
}

export function estimateItemCostUsd(
  strategy: StrategyConfig,
  item: EvalItem,
  prices: PriceTable,
  answerOutputTokens: number = ANSWER_OUTPUT_TOKENS,
  judgeOutputTokens: number = PROTOCOL_OUTPUT_TOKENS,
): number {
  const base = inputTokensOf(item);
  const costOf = (inputTokens: number): number =>
    estimateCalls(strategy, inputTokens, answerOutputTokens).reduce(
      (a, c) => a + estimateCallCostUsd(c, prices),
      0,
    );
  let strategyCost = costOf(base);
  // JOURNEY items (2026-08-25): every follow-on step is a real strategy call
  // the preflight must price, or the belt understates — theater. Each step's
  // input is its template plus whatever {{prevN}} injects; the injected text
  // is unknown before the run, so bound every reference at a full answer
  // (answerOutputTokens each) — an upper bound by construction.
  for (const step of item.journeySteps ?? []) {
    const refs = step.prompt.match(/\{\{prev\d*\}\}/g)?.length ?? 0;
    strategyCost += costOf(Math.ceil(step.prompt.length / 4) + refs * answerOutputTokens);
  }
  // llm-judge items are scored once per (strategy × item) → one judge call
  // each; preflight must project that spend (M1b — previously omitted).
  return strategyCost + estimateItemJudgeCostUsd(item, prices, answerOutputTokens, judgeOutputTokens);
}

/** Preflight projection: Σ over (item × strategy) of estimated cost, INCLUDING llm-judge scoring calls. */
export function projectRunCostUsd(
  strategies: StrategyConfig[],
  items: EvalItem[],
  prices: PriceTable,
  answerOutputTokens: number = ANSWER_OUTPUT_TOKENS,
  judgeOutputTokens: number = PROTOCOL_OUTPUT_TOKENS,
): number {
  let total = 0;
  for (const strategy of strategies) {
    for (const item of items) {
      total += estimateItemCostUsd(strategy, item, prices, answerOutputTokens, judgeOutputTokens);
    }
  }
  return total;
}

/**
 * R2 (inference-compiler roadmap): pre-spend p95 projection for a strategy,
 * mirroring the cost preflight's philosophy — a WORST-CASE UPPER BOUND BY
 * CONSTRUCTION, never a typical estimate. The measured lesson behind it: the
 * committed rewrite-edit cascade served p95 54s against 5.9s for a
 * comparable single — actuals exceed naive sums, so the bound must dominate.
 *
 *   · Sequential shapes (cascade, draft-verify, composite, decompose) SUM
 *     their calls' p95s — every stage escalates, every probe fires, exactly
 *     the worst case estimateCalls prices.
 *   · Parallel shapes credit their parallelism, because the executor really
 *     is parallel (Promise.all): best-of-n / ensemble drafts contribute
 *     max(member p95), then the judge call adds on top. program vote/pick
 *     likewise. decompose subtasks run SEQUENTIALLY (decompose.ts) and sum.
 *   · Probe/judge protocol calls are counted at the model's FULL p95. That
 *     overstates short calls, and deliberately so: this gate exists to
 *     refuse catastrophes before money is spent measuring them, and a bound
 *     that can understate is theater (the M1b cost lesson).
 *
 * Latency evidence comes from measured single-model cells on the same
 * cluster. A model with no evidence yields null — the projection refuses to
 * guess, and the CALLER must treat null as "cannot gate", never as "fast":
 * unknown is not slow, but it is also not a pass on the record.
 */
export function projectStrategyP95Ms(
  strategy: StrategyConfig,
  p95ByModel: ReadonlyMap<string, number>,
): number | null {
  const L = (model: string): number | null => p95ByModel.get(model) ?? null;
  const sum = (xs: Array<number | null>): number | null =>
    xs.some((x) => x === null) ? null : xs.reduce<number>((a, b) => a + (b as number), 0);
  const par = (xs: Array<number | null>): number | null =>
    xs.some((x) => x === null) ? null : Math.max(...(xs as number[]));
  switch (strategy.type) {
    case 'single':
      return L(strategy.model);
    case 'cascade':
      // every stage answers; every thresholded non-final stage probes
      return sum(
        strategy.stages.flatMap((s, i) => {
          const isFinal = i === strategy.stages.length - 1;
          return !isFinal && s.escalateIf?.confidenceBelow !== undefined ? [L(s.model), L(s.model)] : [L(s.model)];
        }),
      );
    case 'best-of-n': {
      const drafts = par(Array.from({ length: strategy.n }, () => L(strategy.model)));
      return sum([drafts, L(strategy.judge.model)]);
    }
    case 'draft-verify':
      return sum([L(strategy.draftModel), L(strategy.verifierModel)]);
    case 'ensemble': {
      // exec-pick's test-writer rides the candidate fan-out (parallel); the
      // sandbox runs are sequential per candidate at the hard wall bound;
      // the tie-judge fires in the worst case whenever configured.
      const execWriters =
        strategy.fusion.method === 'exec-pick' || strategy.fusion.method === 'verify-pick'
          ? (strategy.fusion.testWriters?.length
              ? strategy.fusion.testWriters
              : strategy.fusion.testWriter
                ? [strategy.fusion.testWriter]
                : [])
          : [];
      const fanout = par([...strategy.models.map((m) => L(m)), ...execWriters.map((w) => L(w.model))]);
      const sandbox =
        strategy.fusion.method === 'exec-pick'
          ? strategy.models.length * Math.max(1, execWriters.length) * (CODE_EXEC_TIMEOUT_MS + CODE_EXEC_WALL_SLACK_MS)
          : 0;
      const judge =
        (strategy.fusion.method === 'judge-pick' || strategy.fusion.method === 'exec-pick' || strategy.fusion.method === 'verify-pick') && strategy.fusion.judge
          ? L(strategy.fusion.judge.model)
          : 0;
      return sum([fanout, sandbox, judge]);
    }
    case 'composite':
      // start + probe (same model) + upgrade, all sequential
      return sum([L(strategy.startModel), L(strategy.startModel), L(strategy.upgradeModel)]);
    case 'decompose': {
      // decompose call + MAX_SUBTASKS sequential subtasks, each at the
      // slowest routable model, + optional judge fusion — mirrors the cost
      // worst case's most-expensive-candidate rule.
      const routable = [...new Set([...Object.values(strategy.routing), strategy.decomposerModel])];
      const slowest = par(routable.map((m) => L(m)));
      const judge =
        strategy.fusion?.method === 'judge-pick' && strategy.fusion.judge ? L(strategy.fusion.judge.model) : 0;
      return sum([L(strategy.decomposerModel), ...Array.from({ length: MAX_SUBTASKS }, () => slowest), judge]);
    }
    case 'program': {
      const walkCheck = (c: ProgramCheck): number | null =>
        c.kind === 'agree' ? par([walk(c.of[0]), walk(c.of[1])]) : walk(c.of);
      const walk = (n: ProgramNode): number | null => {
        switch (n.op) {
          case 'call':
            return L(n.model);
          case 'if':
            // worst case: the check runs, then the slower branch
            return sum([walkCheck(n.check), par([walk(n.then), walk(n.else)])]);
          case 'vote':
            return par(n.of.map(walk));
          case 'pick': {
            const members = par(n.of.map(walk));
            return n.by.kind === 'judge' ? sum([members, L(n.by.model)]) : members;
          }
        }
      };
      return walk(strategy.body);
    }
  }
}

/** Error thrown by runEval's preflight when the projection exceeds the cap. */
export class BudgetCapError extends Error {
  readonly projectedUsd: number;
  readonly capUsd: number;
  constructor(projectedUsd: number, capUsd: number) {
    super(
      `budget cap refusal: projected spend $${projectedUsd.toFixed(4)} exceeds budget cap ` +
        `$${capUsd.toFixed(4)} — reduce suites/strategies or raise --cap. Run NOT started.`,
    );
    this.name = 'BudgetCapError';
    this.projectedUsd = projectedUsd;
    this.capUsd = capUsd;
  }
}
