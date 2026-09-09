// COMPILE-DOWN (C2, docs/INFERENCE-COMPILER-PLAN.md): the handwritten strategy
// shapes expressed AS PROGRAMS, so `single` and `cascade` stop being separate
// mechanisms and become sugar over one IR.
//
// The point of doing this is not tidiness. A shape that compiles is a shape
// the synthesizer can reach — it can start from a known-good mechanism and
// mutate it — and a shape that does NOT compile names, precisely, an
// instruction the IR is missing. So the refusals below are the real output of
// this module: they are the C4 work list, derived rather than guessed.
//
// It lives in @potion/core, beside programModels and programCallCount, because
// it is pure data → data: a compiler over the IR, with no execution in it. The
// PROOF that the compile is faithful needs execution and lives in
// packages/strategies/src/compile.test.ts. Keeping the compiler here is what
// lets the synthesizer (@potion/core only, deliberately) mutate a compiled
// incumbent without dragging providers into a pure package.
//
// WHAT COMPILES, EXACTLY
//   single(m)                     → call(m)
//   cascade(logprob, escalateIf)  → nested if/confidence  (one caveat, below)
//   ensemble(judge-pick)          → pick by judge         (since the IR's
//                                   judge became the repo's judge)
//
// WHAT DOES NOT, AND WHY
//   best-of-n      the IR memoizes per NODE STRUCTURE, so n identical
//                  `call(m)` nodes collapse to one call. The grammar cannot
//                  say "sample this model n times independently" because a
//                  call node carries no seed and no temperature. Needs a
//                  sampling instruction — NOT a bug in the memo, which is what
//                  makes a parsed program cost what a built one costs.
//   cascade(self-report-calibrated)
//                  the escalation signal is a second model call that rates the
//                  first answer. The IR has no probe instruction.
//   draft-verify   a verifier that REVISES rather than replaces. No op.
//   composite      mid-stream upgrade on token-batch confidence. Streaming is
//                  not in the grammar at all.
//   decompose      split, route per subtask, fuse. No op.
//   ensemble(concat-rank | exec-pick | verify-pick)
//                  deterministic rankers and a code-exec sandbox. No ops.
//
// THE ONE CAVEAT ON CASCADE. `runCascade` with confidenceMethod 'logprob'
// falls back to a self-report probe when the provider returns no logprob; the
// compiled program has no probe, so it takes the `else` branch instead. The
// two agree on every input where confidence is present and diverge where it is
// absent — stated here, and proven by a test that asserts the divergence
// rather than hiding it.
import type { ProgramNode, StrategyConfig } from './types.js';

export interface CompileRefusal {
  /** The shape that did not compile. */
  type: StrategyConfig['type'];
  /** The instruction the IR would need. This is the C4 work list. */
  missing: string;
}

export type CompileResult =
  | { ok: true; body: ProgramNode; exact: boolean; note?: string }
  | { ok: false; refusal: CompileRefusal };

const refuse = (type: StrategyConfig['type'], missing: string): CompileResult => ({
  ok: false,
  refusal: { type, missing },
});

/** Compile a strategy config to the equivalent program body, or refuse with
 *  the name of the missing instruction. */
export function compileToProgram(config: StrategyConfig): CompileResult {
  switch (config.type) {
    case 'single':
      return { ok: true, body: { op: 'call', model: config.model }, exact: true };

    case 'program':
      return { ok: true, body: config.body, exact: true };

    case 'cascade': {
      if (!Array.isArray(config.stages) || config.stages.length === 0) {
        return refuse('cascade', 'a cascade with no stages is malformed, not compilable');
      }
      if (config.confidenceMethod !== 'logprob') {
        return refuse('cascade', 'probe: ask a model to rate its own answer (self-report + calibration)');
      }
      // Build from the last stage backwards: each non-final stage with a
      // threshold becomes `if confidence(call) >= τ then that call else rest`.
      // The `then` branch IS the checked node, so the structural memo pays for
      // the stage once — the same shape verified-cascade relies on.
      const stages = config.stages;
      let node: ProgramNode = { op: 'call', model: stages[stages.length - 1]!.model };
      for (let i = stages.length - 2; i >= 0; i--) {
        const stage = stages[i]!;
        const tau = stage.escalateIf?.confidenceBelow;
        const call: ProgramNode = { op: 'call', model: stage.model };
        // No threshold ⇒ runCascade accepts this stage and never escalates,
        // so everything after it is unreachable. Compiling it as the whole
        // program is not a shortcut; it is what the cascade does.
        node = tau === undefined ? call : { op: 'if', check: { kind: 'confidence', of: call, min: tau }, then: call, else: node };
      }
      return {
        ok: true,
        body: node,
        exact: false,
        note:
          'diverges from runCascade only when the provider returns no logprob confidence: ' +
          'the cascade probes with a self-report call, the program escalates',
      };
    }

    case 'ensemble': {
      if (config.fusion.method !== 'judge-pick') {
        return refuse('ensemble', `fusion '${config.fusion.method}': deterministic rankers and the code-exec sandbox have no ops`);
      }
      const judge = config.fusion.judge;
      if (!judge) return refuse('ensemble', "fusion 'judge-pick' without a judge is malformed");
      return {
        ok: true,
        body: {
          op: 'pick',
          of: config.models.map((model) => ({ op: 'call' as const, model })),
          by: { kind: 'judge', model: judge.model },
        },
        // A rubric on the judge config has nowhere to go in the IR's `by`.
        exact: judge.rubric === undefined,
        ...(judge.rubric !== undefined ? { note: 'the judge rubric is dropped — `by` carries a model, not a rubric' } : {}),
      };
    }

    case 'best-of-n':
      return refuse('best-of-n', 'sampling: n independent draws from ONE model (a call node carries no seed or temperature, and the structural memo collapses identical nodes)');
    case 'draft-verify':
      return refuse('draft-verify', 'revise: a verifier that edits the draft rather than replacing it');
    case 'composite':
      return refuse('composite', 'streaming: mid-stream upgrade on token-batch confidence');
    case 'decompose':
      return refuse('decompose', 'split/route/fuse over subtasks');
  }
}

/** Every shape that does not yet compile, with the instruction it needs.
 *  The C4 work list, derived from the IR rather than asserted. */
export function compileGaps(configs: StrategyConfig[]): CompileRefusal[] {
  const out: CompileRefusal[] = [];
  for (const c of configs) {
    const r = compileToProgram(c);
    if (!r.ok && !out.some((x) => x.type === r.refusal.type && x.missing === r.refusal.missing)) {
      out.push(r.refusal);
    }
  }
  return out;
}
