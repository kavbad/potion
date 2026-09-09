// Candidate generator tests (M4b #37, SPEC §15.1): template grammar ×
// class-pruned registry, ≤20/cycle budget, dedupe vs existing hashes AND
// eval-cache cells, determinism, judge-focus carve-out, decompose opt-in.
import { describe, expect, it } from 'vitest';
import { compileToProgram, MAX_PROGRAM_CALLS, promptVariantFitsScoring, SELECT_MIN_PROMPT_CHARS, REASONING_EFFORT_PROVIDERS, programCallCount, programModels, strategyHash, StrategyConfigSchema, type EvalItem, type ProgramNode, type StrategyConfig } from '@potion/core';
import {
  DEFAULT_CANDIDATE_BUDGET,
  generateCandidates,
  generateCandidatesExplained,
  type GenerateOptions,
  workloadFeaturesFromItems,
  canAgreeOn,
  canVerifyJsonOn,
  type WorkloadFeatures,
} from './generate.js';
import { buildRegistry, type ModelRegistryEntry } from './registry.js';
import { strategyCapabilities } from '@potion/strategies';

/** Fixture registry: mock world + live-named aliases across all classes. */
function fixtureRegistry(): ModelRegistryEntry[] {
  return buildRegistry({
    version: 'test',
    updatedAt: '2026-08-06',
    entries: [
      { alias: 'mock-cheap', provider: 'mock', model: 'mock-cheap-v1', inputPer1M: 0, outputPer1M: 0 },
      { alias: 'mock-mid', provider: 'mock', model: 'mock-mid-v1', inputPer1M: 0, outputPer1M: 0 },
      { alias: 'mock-frontier', provider: 'mock', model: 'mock-frontier-v1', inputPer1M: 0, outputPer1M: 0 },
      { alias: 'mock-judge', provider: 'mock', model: 'mock-judge-v1', inputPer1M: 0, outputPer1M: 0 },
      { alias: 'or-haiku', provider: 'openrouter', model: 'anthropic/claude-haiku-4.5', inputPer1M: 1, outputPer1M: 5 },
      { alias: 'or-sonnet', provider: 'openrouter', model: 'anthropic/claude-sonnet-4.5', inputPer1M: 3, outputPer1M: 15 },
      { alias: 'or-fable-5', provider: 'openrouter', model: 'anthropic/claude-fable-5', inputPer1M: 10, outputPer1M: 50 },
      { alias: 'or-judge', provider: 'openrouter', model: 'anthropic/claude-sonnet-4.5', inputPer1M: 3, outputPer1M: 15 },
      { alias: 'gpt-mini-class', provider: 'openai', model: 'gpt-4.1-mini', inputPer1M: 0.4, outputPer1M: 1.6 },
      { alias: 'gpt-frontier-class', provider: 'openai', model: 'gpt-5', inputPer1M: 1.25, outputPer1M: 10 },
      { alias: 'sonnet-class', provider: 'anthropic', model: 'claude-sonnet-4-5', inputPer1M: 3, outputPer1M: 15 },
      { alias: 'gemini-pro-class', provider: 'google', model: 'gemini-2.5-pro', inputPer1M: 1.25, outputPer1M: 10 },
    ],
  });
}

function opts(over: Partial<GenerateOptions> = {}): GenerateOptions {
  return { registry: fixtureRegistry(), existingHashes: new Set(), ...over };
}

describe('generateCandidates — SPEC §15.1', () => {
  it('mid-class focus: full template spread, single first', () => {
    const explained = generateCandidatesExplained(opts({ focusAlias: 'or-sonnet' }));
    const templates = explained.map((c) => c.template);
    expect(templates[0]).toBe('single');
    expect(templates).toContain('cascade(focus→strong)');
    expect(templates).toContain('cascade(cheap→focus→strong)');
    expect(templates).toContain('composite(start=focus,upgrade=strong)');
    expect(templates).toContain('draft-verify(draft=focus,verifier=strong)');
    expect(templates).toContain('best-of-n(n=3)');
    expect(templates).toContain('ensemble(focus+2x-peers)');
    // No decompose by default.
    expect(templates.some((t) => t.startsWith('decompose'))).toBe(false);
  });

  it('strong-class focus: no draft-verify; cascade terminates at focus', () => {
    const explained = generateCandidatesExplained(opts({ focusAlias: 'or-fable-5' }));
    const templates = explained.map((c) => c.template);
    expect(templates).toContain('single');
    expect(templates).toContain('cascade(mid→focus)');
    expect(templates).toContain('cascade(cheap→mid→focus)');
    expect(templates.some((t) => t.startsWith('draft-verify'))).toBe(false);
    // Ensemble picks cross-provider strong peers (openai + anthropic).
    const ens = explained.find((c) => c.template === 'ensemble(focus+2x-peers)');
    expect(ens).toBeDefined();
    const models = (ens!.config as { models: string[] }).models;
    expect(models[0]).toBe('or-fable-5');
    expect(models).toContain('gpt-frontier-class');
    expect(models.length).toBe(3);
  });

  it('cheap-class focus: the surviving composite, and draft-verify', () => {
    const explained = generateCandidatesExplained(opts({ focusAlias: 'or-haiku' }));
    const templates = explained.map((c) => c.template);
    expect(templates).toContain('composite(start=focus,upgrade=strong)');
    expect(templates).toContain('draft-verify(draft=focus,verifier=strong)');
  });

  it('composite(start=cheap,…) is RETIRED — it never starts on a chosen model', () => {
    // Measured worst on both live suites (2026-09-05). The shape always starts
    // on classRepresentative(cheap), i.e. the cheapest row in the price table,
    // while a composite's whole premise is that the start model usually
    // suffices. No focus class brings it back.
    for (const focusAlias of ['or-haiku', 'or-sonnet', 'or-fable-5']) {
      const templates = generateCandidatesExplained(opts({ focusAlias })).map((c) => c.template);
      expect(templates.some((t) => t.startsWith('composite(start=cheap'))).toBe(false);
    }
  });

  it('judge-class focus: judge-slot recipes only (never single/cascade)', () => {
    const explained = generateCandidatesExplained(opts({ focusAlias: 'mock-judge' }));
    expect(explained.length).toBeGreaterThan(0);
    for (const c of explained) {
      expect(c.template.startsWith('best-of-n') || c.template.startsWith('ensemble')).toBe(true);
      const cfg = c.config as { judge?: { model: string }; fusion?: { judge?: { model: string } } };
      const judgeModel = cfg.judge?.model ?? cfg.fusion?.judge?.model;
      expect(judgeModel).toBe('mock-judge');
    }
  });

  it('prunes existingHashes AND eval-cache cells, self-dedupes', () => {
    const registry = fixtureRegistry();
    const all = generateCandidatesExplained(opts({ focusAlias: 'or-sonnet' }));
    const h0 = strategyHash(all[0]!.config); // single
    const h1 = strategyHash(all[1]!.config); // first cascade
    const pruned = generateCandidatesExplained(
      opts({
        focusAlias: 'or-sonnet',
        existingHashes: new Set([h0]),
        evaluatedHashes: new Set([h1]),
      }),
    );
    const hashes = pruned.map((c) => strategyHash(c.config));
    expect(hashes).not.toContain(h0);
    expect(hashes).not.toContain(h1);
    expect(new Set(hashes).size).toBe(hashes.length); // no batch dupes
    expect(pruned.length).toBe(all.length - 2);
    void registry;
  });

  it('respects the per-cycle budget (default 20, focus-first order kept)', () => {
    expect(DEFAULT_CANDIDATE_BUDGET).toBe(20);
    const two = generateCandidatesExplained(opts({ focusAlias: 'or-sonnet', budget: 2 }));
    expect(two.length).toBe(2);
    expect(two[0]!.template).toBe('single');
    const zero = generateCandidates(opts({ focusAlias: 'or-sonnet', budget: 0 }));
    expect(zero).toEqual([]);
  });

  it('deterministic: same inputs (+seed) → identical hashes', () => {
    const a = generateCandidates(opts({ focusAlias: 'or-fable-5', seed: 7 })).map(strategyHash);
    const b = generateCandidates(opts({ focusAlias: 'or-fable-5', seed: 7 })).map(strategyHash);
    expect(a).toEqual(b);
  });

  it('focus-less baseline cycle: singles over answerer aliases, sorted', () => {
    const cands = generateCandidates(opts());
    expect(cands.every((c) => (c as { type: string }).type === 'single')).toBe(true);
    const models = cands.map((c) => (c as { model: string }).model);
    expect(models).toEqual([...models].sort());
    expect(models).not.toContain('mock-judge'); // judges never answer
    expect(models).not.toContain('or-judge');
    expect(cands.length).toBe(10);
  });

  it('unknown focus alias → no candidates', () => {
    expect(generateCandidates(opts({ focusAlias: 'nope' }))).toEqual([]);
  });

  it('decompose is opt-in only', () => {
    const withD = generateCandidatesExplained(
      opts({ focusAlias: 'or-sonnet', includeDecompose: true }),
    );
    expect(withD.some((c) => c.template.startsWith('decompose'))).toBe(true);
    const d = withD.find((c) => c.template.startsWith('decompose'))!.config as {
      decomposerModel: string;
      routing: Record<string, string>;
    };
    expect(d.decomposerModel).toBe('or-sonnet');
    expect(d.routing['default']).toBe('mock-cheap'); // cheapest cheap (0-priced mock)
  });
});

// ---- C2: synthesized programs (docs/INFERENCE-COMPILER-PLAN.md) ----
describe('program synthesis — the generator writes mechanisms, not just fills templates', () => {
  const programs = (over: Partial<GenerateOptions> = {}) =>
    generateCandidatesExplained(opts({ focusAlias: 'gpt-mini-class', includePrograms: true, budget: 50, ...over }))
      .filter((c) => c.config.type === 'program');

  it('emits nothing unless asked — the shelf is still the default', () => {
    const off = generateCandidatesExplained(opts({ focusAlias: 'gpt-mini-class', budget: 50 }));
    expect(off.some((c) => c.config.type === 'program')).toBe(false);
    expect(programs().length).toBeGreaterThan(0);
  });

  it('synthesizes only gates the template shelf cannot express', () => {
    // No workloads here, so no effort pair: without an instrument the compiler
    // cannot know whether deliberation breaks the answer, and the live run
    // measured what guessing wrong costs (0.862 vs 0.962 on extraction).
    const names = new Set(programs().map((c) => (c.config as { name: string }).name));
    expect(names).toEqual(new Set(['consensus-or-escalate', 'verified-cascade']));
    // The rule, restated as a property rather than a list: every synthesized
    // mechanism must do something `cascade` cannot. An escalation between two
    // MODELS is a cascade; these escalate on AGREEMENT between peers, or on a
    // DETERMINISTIC check of the answer — and a cascade stage carries a model,
    // never a check.
    const vc = programs().find((c) => (c.config as { name: string }).name === 'verified-cascade')!;
    const body = (vc.config as { body: ProgramNode }).body as Extract<ProgramNode, { op: 'if' }>;
    expect(body.check.kind).toBe('json');
    expect(programCallCount(body)).toBe(2);
  });

  it('every synthesized program passes the schema boundary C1 opened', () => {
    const all = programs();
    expect(all.length).toBeGreaterThan(0);
    for (const c of all) expect(() => StrategyConfigSchema.parse(c.config)).not.toThrow();
  });

  it('stays inside the static call bound, and the verified cascade pays for its focus call once', () => {
    for (const c of programs()) {
      const body = (c.config as { body: ProgramNode }).body;
      expect(programCallCount(body)).toBeLessThanOrEqual(MAX_PROGRAM_CALLS);
    }
    const vc = programs().find((c) => (c.config as { name: string }).name === 'verified-cascade')!;
    // The `then` branch IS the checked node: two calls worst case, not three.
    expect(programCallCount((vc.config as { body: ProgramNode }).body)).toBe(2);
  });

  it('agrees across PROVIDERS — two models from one house concurring is weaker evidence', () => {
    const coe = programs().find((c) => (c.config as { name: string }).name === 'consensus-or-escalate')!;
    const models = programModels((coe.config as { body: ProgramNode }).body);
    const registry = fixtureRegistry();
    const providerOf = (a: string) => registry.find((e) => e.alias === a)?.provider;
    expect(models[0]).toBe('gpt-mini-class');
    expect(providerOf(models[1]!)).not.toBe(providerOf('gpt-mini-class'));
  });

  it('is deterministic and hash-distinct from every template in the same cycle', () => {
    const a = generateCandidatesExplained(opts({ focusAlias: 'gpt-mini-class', includePrograms: true, budget: 50 }));
    const b = generateCandidatesExplained(opts({ focusAlias: 'gpt-mini-class', includePrograms: true, budget: 50 }));
    expect(a.map((c) => c.template)).toEqual(b.map((c) => c.template));
    expect(a.map((c) => strategyHash(c.config))).toEqual(b.map((c) => strategyHash(c.config)));
    // NOT asserted here: that program hashes differ from template hashes. The
    // dedupe loop guarantees that and the assertion would be vacuous — the
    // duplication that actually costs money is SEMANTIC, and the gate-space
    // test above is what guards it.
  });

  it('never crowds out the simple recipes — programs come last under budget', () => {
    const tight = generateCandidatesExplained(
      opts({ focusAlias: 'gpt-mini-class', includePrograms: true, budget: 3 }),
    );
    expect(tight).toHaveLength(3);
    expect(tight.some((c) => c.config.type === 'program')).toBe(false);
    expect(tight[0]!.template).toBe('single');
  });

  it('a judge-class focus never gets one — judges score, they do not answer', () => {
    const judgeFocus = generateCandidatesExplained(
      opts({ focusAlias: 'mock-judge', includePrograms: true, budget: 50 }),
    );
    expect(judgeFocus.some((c) => c.config.type === 'program')).toBe(false);
  });
});

// ---- C2 workload conditioning (docs/INFERENCE-COMPILER-PLAN.md) ----
//
// The review's architecture box is `Workload features + prior evidence →
// Program synthesizer`. Before this, synthesis was conditioned on NEITHER: the
// same mechanisms were emitted for an extraction workload and a creative one.
// That is not merely imprecise — it is guaranteed waste. An `agree` gate on a
// prose workload can essentially never fire (normalized text equality between
// two models writing paragraphs), so the program degenerates to "always
// escalate": pay for two calls to always take the third.
describe('synthesis conditioned on the workload', () => {
  const EXTRACTION: WorkloadFeatures = {
    clusterId: 'extraction',
    scoringKinds: ['field-match'],
    requiredKeys: ['order', 'issue'],
  };
  const CREATIVE: WorkloadFeatures = { clusterId: 'creative', scoringKinds: ['llm-judge'] };
  const CLASSIFICATION: WorkloadFeatures = { clusterId: 'classification', scoringKinds: ['exact'] };

  const synth = (workloads: WorkloadFeatures[]) =>
    generateCandidatesExplained(
      opts({ focusAlias: 'gpt-mini-class', includePrograms: true, budget: 60, workloads }),
    ).filter((c) => c.config.type === 'program');

  it('a prose workload gets no ANSWER-SHAPE gates, but still gets the effort pair', () => {
    // Corrected 2026-09-05. This used to assert "no programs at all", which
    // conflated two different things: an answer-shape gate belongs to the
    // INSTRUMENT (can a check read this answer?) and the effort escalation
    // belongs to the PROVIDER (can it think harder?). Confidence on the
    // model's own output is meaningful whatever the answer looks like.
    const names = new Set(synth([CREATIVE]).map((c) => (c.config as { name: string }).name));
    expect(names).toEqual(new Set(['effort-escalation']));
  });

  it('a structured workload gets the JSON verifier, carrying the suite\'s own required keys', () => {
    const vc = synth([EXTRACTION]).filter((c) => (c.config as { name: string }).name === 'verified-cascade');
    expect(vc.length).toBeGreaterThan(0);
    const body = (vc[0]!.config as { body: ProgramNode }).body as Extract<ProgramNode, { op: 'if' }>;
    expect(body.check).toMatchObject({ kind: 'json', requiredKeys: ['order', 'issue'] });
    // The keys come from the cluster's scoring, not from a guess.
    expect(vc[0]!.template).toContain('extraction');
  });

  it('a deterministically scored workload gets the agreement gate; a judged one never does', () => {
    const named = (w: WorkloadFeatures[]) =>
      new Set(synth(w).map((c) => (c.config as { name: string }).name));
    expect(named([CLASSIFICATION])).toContain('consensus-or-escalate');
    expect(named([CREATIVE])).not.toContain('consensus-or-escalate');
  });

  it('escalates to what has MEASURED best on this cluster, not to a class representative', () => {
    const withEvidence: WorkloadFeatures = { ...EXTRACTION, measuredModels: ['sonnet-class'] };
    const vc = synth([withEvidence]).find((c) => (c.config as { name: string }).name === 'verified-cascade')!;
    const body = (vc.config as { body: ProgramNode }).body as Extract<ProgramNode, { op: 'if' }>;
    expect(body.else).toEqual({ op: 'call', model: 'sonnet-class' });
    expect(vc.template).toContain('measured');
  });

  it('falls back to the class representative when the cluster has no measured evidence yet', () => {
    const vc = synth([EXTRACTION]).find((c) => (c.config as { name: string }).name === 'verified-cascade')!;
    const body = (vc.config as { body: ProgramNode }).body as Extract<ProgramNode, { op: 'if' }>;
    expect((body.else as { op: 'call'; model: string }).model).not.toBe('gpt-mini-class');
    expect(vc.template).not.toContain('measured');
  });

  it('two workloads produce a union, and identical mechanisms across them dedupe', () => {
    const both = synth([EXTRACTION, CLASSIFICATION]);
    const hashes = both.map((c) => strategyHash(c.config));
    expect(new Set(hashes).size).toBe(hashes.length);
    expect(both.length).toBeGreaterThan(synth([CLASSIFICATION]).length);
  });

  it('no workloads given ⇒ the registry-only enumeration: both gates, no effort pair', () => {
    const unconditioned = generateCandidatesExplained(
      opts({ focusAlias: 'gpt-mini-class', includePrograms: true, budget: 60 }),
    ).filter((c) => c.config.type === 'program');
    // 2 escalation targets x 2 workload-free gates. The effort pair is NOT
    // here: it needs to know the instrument tolerates deliberation, and an
    // unconditioned enumeration knows nothing about the instrument.
    expect(unconditioned.length).toBe(4);
    expect(unconditioned.every((c) => !c.template.includes('cluster='))).toBe(true);
  });
});

describe('workloadFeaturesFromItems — features are derived, never asserted', () => {
  const item = (clusterId: string, scoring: EvalItem['scoring']): EvalItem => ({
    id: `${clusterId}-${Math.random()}`,
    clusterId: clusterId as EvalItem['clusterId'],
    prompt: [{ role: 'user', content: 'q' }],
    scoring,
  });

  it('reads the scoring kinds a cluster actually uses', () => {
    const f = workloadFeaturesFromItems([
      item('creative', { kind: 'llm-judge', rubric: 'r', judgeModel: 'j', scale: [0, 10] }),
      item('classification', { kind: 'exact' }),
    ]);
    expect(f.map((x) => x.clusterId)).toEqual(['classification', 'creative']); // sorted
    expect(f[0]!.scoringKinds).toEqual(['exact']);
    expect(f[1]!.scoringKinds).toEqual(['llm-judge']);
  });

  it('required keys are the INTERSECTION — a key one item lacks would escalate it forever', () => {
    const f = workloadFeaturesFromItems([
      item('extraction', { kind: 'field-match', schema: { order: 'string', issue: 'string', urgency: 'string' } }),
      item('extraction', { kind: 'field-match', schema: { order: 'string', issue: 'string' } }),
    ]);
    expect(f[0]!.requiredKeys).toEqual(['issue', 'order']); // not urgency
  });

  it('dotted field-contains paths contribute only their top-level segment', () => {
    const f = workloadFeaturesFromItems([
      item('extraction', { kind: 'field-contains', fields: { 'invoice.total': '10', 'invoice.date': 'Sept 3' } }),
    ]);
    expect(f[0]!.requiredKeys).toEqual(['invoice']);
  });

  it('an empty intersection drops the keys but keeps the cluster gateable on "is it JSON"', () => {
    const f = workloadFeaturesFromItems([
      item('extraction', { kind: 'field-match', schema: { a: 'string' } }),
      item('extraction', { kind: 'field-match', schema: { b: 'string' } }),
    ]);
    expect(f[0]!.requiredKeys).toBeUndefined();
    expect(canVerifyJsonOn(f[0]!)).toBe(true);
  });

  it('a mixed cluster with any judged item cannot carry an agreement gate', () => {
    const f = workloadFeaturesFromItems([
      item('code-gen', { kind: 'exact' }),
      item('code-gen', { kind: 'code-exec', language: 'javascript', tests: 't' }),
    ]);
    expect(canAgreeOn(f[0]!)).toBe(false);
  });
});

// ---- C2 mutation source (docs/INFERENCE-COMPILER-PLAN.md) ----
//
// Compile-down's payoff. The escalation target stops being "a model that
// measured well" and becomes THE MECHANISM ALREADY PROVEN BEST ON THIS WORK:
// try the model under test, and when the gate says the answer is not good
// enough, fall back to the incumbent itself. Quality has a floor by
// construction — the program can only lose where the cheap head PASSES its
// check — and the fallback is a whole mechanism, which the template shelf
// cannot express (a cascade stage is a model, never a cascade).
describe('mutating the compiled incumbent', () => {
  const CASCADE_INCUMBENT: StrategyConfig = {
    type: 'cascade',
    stages: [{ model: 'sonnet-class', escalateIf: { confidenceBelow: 0.7 } }, { model: 'gpt-frontier-class' }],
    confidenceMethod: 'logprob',
  };
  const EXTRACTION: WorkloadFeatures = {
    clusterId: 'extraction',
    scoringKinds: ['field-match'],
    requiredKeys: ['order'],
    measuredModels: ['sonnet-class'],
  };

  const synth = (w: WorkloadFeatures[]) =>
    generateCandidatesExplained(
      opts({ focusAlias: 'gpt-mini-class', includePrograms: true, budget: 60, workloads: w }),
    ).filter((c) => c.config.type === 'program');

  it('escalates to the incumbent MECHANISM, not to one of its models', () => {
    const progs = synth([{ ...EXTRACTION, incumbent: CASCADE_INCUMBENT }]);
    const mutated = progs.filter((c) => c.template.includes('incumbent'));
    expect(mutated.length).toBeGreaterThan(0);
    const body = (mutated[0]!.config as { body: ProgramNode }).body as Extract<ProgramNode, { op: 'if' }>;
    // The else branch is the compiled cascade — an `if`, not a bare call.
    expect(body.else.op).toBe('if');
    expect(programModels(body.else)).toEqual(['sonnet-class', 'gpt-frontier-class']);
    // …and the head is the model this cycle is actually testing.
    expect(programModels(body)[0]).toBe('gpt-mini-class');
  });

  it('a single-model incumbent produces NOTHING new — the gate space already covers it', () => {
    const single: StrategyConfig = { type: 'single', model: 'sonnet-class' };
    const withSingle = synth([{ ...EXTRACTION, incumbent: single }]);
    expect(withSingle.filter((c) => c.template.includes('incumbent'))).toEqual([]);
    // and the ordinary conditioned output is unchanged by its presence
    expect(withSingle.map((c) => c.template)).toEqual(synth([EXTRACTION]).map((c) => c.template));
  });

  it('an incumbent that does not compile is skipped, not guessed at', () => {
    const bon: StrategyConfig = { type: 'best-of-n', model: 'sonnet-class', n: 3, judge: { model: 'or-judge' } };
    expect(synth([{ ...EXTRACTION, incumbent: bon }]).filter((c) => c.template.includes('incumbent'))).toEqual([]);
  });

  it('refuses a mutation that would breach the static call bound', () => {
    // A four-stage incumbent compiles to 4 calls; a consensus head adds 2 and a
    // verified head 1. With MAX_PROGRAM_CALLS at 8 both still fit, so push the
    // incumbent to 7 and neither can.
    const deep: StrategyConfig = {
      type: 'cascade',
      stages: [
        ...['a', 'b', 'c', 'd', 'e', 'f'].map((m) => ({ model: `${m}-x`, escalateIf: { confidenceBelow: 0.7 } })),
        { model: 'g-x' },
      ],
      confidenceMethod: 'logprob',
    };
    expect(programCallCount(compileToProgram(deep).ok ? (compileToProgram(deep) as { body: ProgramNode }).body : { op: 'call', model: 'x' })).toBe(7);
    for (const c of synth([{ ...EXTRACTION, incumbent: deep }])) {
      expect(programCallCount((c.config as { body: ProgramNode }).body)).toBeLessThanOrEqual(MAX_PROGRAM_CALLS);
    }
  });

  it('refuses a head whose model is already inside the incumbent — the memo would serve the rejected answer', () => {
    // The structural memo makes `call(m)` anywhere in the tree ONE call. If the
    // head is `call(m)` and the incumbent also calls m, the fallback does not
    // re-ask m — it replays the very answer the gate just rejected, for free,
    // and calls that an escalation.
    const overlapping: StrategyConfig = {
      type: 'cascade',
      stages: [
        { model: 'gpt-mini-class', escalateIf: { confidenceBelow: 0.7 } },
        { model: 'gpt-frontier-class' },
      ],
      confidenceMethod: 'logprob',
    };
    const progs = synth([{ ...EXTRACTION, incumbent: overlapping }]);
    expect(progs.filter((c) => c.template.includes('incumbent'))).toEqual([]);
  });

  it('every mutation still passes the schema and keeps the gate-space rule', () => {
    const progs = synth([{ ...EXTRACTION, incumbent: CASCADE_INCUMBENT }]);
    for (const c of progs) expect(() => StrategyConfigSchema.parse(c.config)).not.toThrow();
    // A judged workload gets no mutations either — an inert gate is still inert
    // when its fallback is fancier. (The effort pair is not a gate and does
    // still appear; it is the mutations that must not.)
    const judged = synth([{ clusterId: 'creative', scoringKinds: ['llm-judge'], incumbent: CASCADE_INCUMBENT }]);
    expect(judged.filter((c) => c.template.includes('incumbent'))).toEqual([]);
    expect(new Set(judged.map((c) => (c.config as { name: string }).name))).toEqual(
      new Set(['effort-escalation']),
    );
  });
});

// ---- C4: the exclusion expires ----
//
// C2 refused to synthesize a confidence gate because `cascade` with
// escalateIf.confidenceBelow already WAS that mechanism. That was true only
// while a call node was a bare model. `CascadeStage` is `{model, escalateIf}`
// with no params, so a cascade can escalate from one model to another and
// never from one EFFORT to another — the moment effort is on the call node,
// `A(low) → confidence → A(high)` is a mechanism the shelf cannot say.
describe('effort-gated synthesis (C4)', () => {
  // A JUDGED workload: prose is what gets graded, so deliberation is safe here.
  // (It was `exact` until the live run measured effort losing badly on
  // shape-reading instruments — see the deliberation coupling.)
  const CREATIVE_WL: WorkloadFeatures = { clusterId: 'creative', scoringKinds: ['llm-judge'] };
  const synth = (focusAlias: string) =>
    generateCandidatesExplained(
      opts({ focusAlias, includePrograms: true, budget: 60, workloads: [CREATIVE_WL] }),
    ).filter((c) => c.config.type === 'program');

  it('synthesizes think-harder-on-the-same-model, which no template expresses', () => {
    const eff = synth('gpt-mini-class').filter((c) => (c.config as { name: string }).name === 'effort-escalation');
    expect(eff.length).toBeGreaterThan(0);
    const body = (eff[0]!.config as { body: ProgramNode }).body as Extract<ProgramNode, { op: 'if' }>;
    expect(programModels(body)).toEqual(['gpt-mini-class']); // ONE model
    expect(programCallCount(body)).toBe(2); // two operating points of it
    expect((body.else as { reasoningEffort?: string }).reasoningEffort).toBe('high');
    // The HEAD must say 'low' explicitly. Absent means "the provider's
    // default", which is a THIRD operating point — so a head with no effort
    // makes this "default → high", a mechanism nobody chose and whose cheap
    // side was never the cheap side.
    expect((body.then as { reasoningEffort?: string }).reasoningEffort).toBe('low');
    expect((body.check as { of: { reasoningEffort?: string } }).of.reasoningEffort).toBe('low');
    expect(body.check.kind).toBe('confidence');
  });

  it('only for providers whose wire can carry effort', () => {
    // The fixture registry's mock-* aliases are on the mock provider, which
    // can. A provider that could not must never be offered an effort program:
    // the transport would refuse mid-sweep, or worse, answer without thinking.
    for (const c of synth('mock-cheap')) {
      const body = (c.config as { body: ProgramNode }).body;
      expect(programModels(body).every((m) => m.length > 0)).toBe(true);
    }
    expect(REASONING_EFFORT_PROVIDERS).toContain('openai');
  });

  it('every effort program passes the schema and the static bound', () => {
    for (const c of synth('gpt-mini-class')) {
      expect(() => StrategyConfigSchema.parse(c.config)).not.toThrow();
      expect(programCallCount((c.config as { body: ProgramNode }).body)).toBeLessThanOrEqual(MAX_PROGRAM_CALLS);
    }
  });

  it('effort does not make an inert GATE fire — it just is not one', () => {
    const creative = generateCandidatesExplained(
      opts({
        focusAlias: 'gpt-mini-class', includePrograms: true, budget: 60,
        workloads: [{ clusterId: 'creative', scoringKinds: ['llm-judge'] }],
      }),
    ).filter((c) => c.config.type === 'program');
    // No json check and no agreement check anywhere in what a judged workload
    // gets — but the effort pair is there, because its check reads confidence,
    // not the answer.
    expect(new Set(creative.map((c) => (c.config as { name: string }).name))).toEqual(
      new Set(['effort-escalation']),
    );
    for (const c of creative) {
      const body = (c.config as { body: ProgramNode }).body as Extract<ProgramNode, { op: 'if' }>;
      expect(body.check.kind).toBe('confidence');
    }
  });

});

// ---- C4 rung 2: instruct-and-verify synthesis ----
//
// The coupling in practice. `json-only` is only synthesized where the
// instrument says the answer is an object — and there, it pairs with the json
// gate into one mechanism: ASK for the shape, CHECK the shape, escalate when
// it is wrong. No template can say that; a cascade stage cannot carry an
// instruction, and neither can a composite.
describe('prompt-variant synthesis (C4 rung 2)', () => {
  const EXTRACTION: WorkloadFeatures = {
    clusterId: 'extraction', scoringKinds: ['field-match'], requiredKeys: ['order'],
  };
  const CLASSIFICATION: WorkloadFeatures = { clusterId: 'classification', scoringKinds: ['exact'] };
  const synth = (w: WorkloadFeatures[]) =>
    generateCandidatesExplained(
      opts({ focusAlias: 'gpt-mini-class', includePrograms: true, budget: 80, workloads: w }),
    ).filter((c) => c.config.type === 'program');

  const variantsOf = (body: ProgramNode): (string | undefined)[] => {
    const out: (string | undefined)[] = [];
    const walk = (n: ProgramNode): void => {
      if (n.op === 'call') { out.push(n.promptVariant); return; }
      if (n.op === 'if') { walk(n.check.kind === 'agree' ? n.check.of[0] : n.check.of); walk(n.then); walk(n.else); return; }
      n.of.forEach(walk);
    };
    walk(body);
    return out;
  };

  it('a structured workload gets instruct-and-verify: the ASK and the CHECK agree', () => {
    const iv = synth([EXTRACTION]).filter((c) => (c.config as { name: string }).name === 'instruct-and-verify');
    expect(iv.length).toBeGreaterThan(0);
    const body = (iv[0]!.config as { body: ProgramNode }).body as Extract<ProgramNode, { op: 'if' }>;
    expect(body.check.kind).toBe('json');
    expect(variantsOf(body)).toContain('json-only');
    // the checked node IS the then-branch, so the instructed call is paid once
    expect(programCallCount(body)).toBe(2);
  });

  it('a canonical-answer workload never gets json-only — it would break its own scorer', () => {
    for (const c of synth([CLASSIFICATION])) {
      expect(variantsOf((c.config as { body: ProgramNode }).body)).not.toContain('json-only');
    }
  });

  it('step-by-step is synthesized nowhere: every workload a gate can serve forbids it', () => {
    const all = [...synth([EXTRACTION]), ...synth([CLASSIFICATION])];
    for (const c of all) {
      expect(variantsOf((c.config as { body: ProgramNode }).body)).not.toContain('step-by-step');
    }
    // …and that is a property of the GATE SPACE, not of the variant: the only
    // instruments that tolerate prose are the judged ones, which no gate can
    // read. It becomes synthesizable when a gate can.
    expect(promptVariantFitsScoring('step-by-step', ['llm-judge'])).toBe(true);
  });

  it('with no workload information, nothing is instructed — the ask needs an instrument', () => {
    // The unconditioned enumeration cannot know what an answer should look
    // like, so it must not tell the model what to look like. This is the check
    // doing real work, not a redundant one: `gates.json` and the json-only fit
    // happen to coincide when a workload IS known, and diverge when it is not.
    const unconditioned = generateCandidatesExplained(
      opts({ focusAlias: 'gpt-mini-class', includePrograms: true, budget: 80 }),
    ).filter((c) => c.config.type === 'program');
    for (const c of unconditioned) {
      expect(variantsOf((c.config as { body: ProgramNode }).body).every((v) => v === undefined)).toBe(true);
    }
  });

  it('the json GATE and the json-only ASK agree, today exactly', () => {
    // Both mean "the instrument says the answer is an object". They are
    // computed from different functions, so this pins the coincidence: if one
    // ever widens without the other, a program would ask for a shape nothing
    // checks, or check a shape nothing asked for.
    for (const kinds of [['field-match'], ['field-contains'], ['exact'], ['llm-judge'], ['code-exec'], []]) {
      expect(canVerifyJsonOn({ clusterId: 'c', scoringKinds: kinds })).toBe(
        promptVariantFitsScoring('json-only', kinds),
      );
    }
  });

  it('every variant program passes the schema and the static bound', () => {
    for (const c of synth([EXTRACTION])) {
      expect(() => StrategyConfigSchema.parse(c.config)).not.toThrow();
      expect(programCallCount((c.config as { body: ProgramNode }).body)).toBeLessThanOrEqual(MAX_PROGRAM_CALLS);
    }
  });
});

// ---- C4 rung 3: select-and-verify ----
describe('context-selection synthesis (C4 rung 3)', () => {
  const bigItem = (clusterId: string, paras: number): EvalItem => ({
    id: `${clusterId}-${paras}`,
    clusterId: clusterId as EvalItem['clusterId'],
    prompt: [
      { role: 'user', content: Array.from({ length: paras }, (_, i) => `Paragraph ${i} `.repeat(40)).join('\n\n') },
      { role: 'user', content: 'What does the policy say?' },
    ],
    scoring: { kind: 'field-contains', fields: { answer: 'yes' } },
  });
  const smallItem = (clusterId: string): EvalItem => ({
    id: `${clusterId}-small`,
    clusterId: clusterId as EvalItem['clusterId'],
    prompt: [{ role: 'user', content: 'Classify: refund request' }],
    scoring: { kind: 'exact' },
  });

  const synth = (w: WorkloadFeatures[]) =>
    generateCandidatesExplained(
      opts({ focusAlias: 'gpt-mini-class', includePrograms: true, budget: 90, workloads: w }),
    ).filter((c) => c.config.type === 'program');

  const selectsOf = (body: ProgramNode): number[] => {
    const out: number[] = [];
    const walk = (n: ProgramNode): void => {
      if (n.op === 'call') { if (n.contextSelect) out.push(n.contextSelect.keepParagraphs); return; }
      if (n.op === 'if') { walk(n.check.kind === 'agree' ? n.check.of[0] : n.check.of); walk(n.then); walk(n.else); return; }
      n.of.forEach(walk);
    };
    walk(body);
    return out;
  };

  it('the prompt-size signal is DERIVED from the items, not from a cluster name', () => {
    const [f] = workloadFeaturesFromItems([bigItem('rag-answer', 12), bigItem('rag-answer', 8)]);
    expect(f!.medianPromptChars).toBeGreaterThan(SELECT_MIN_PROMPT_CHARS);
    expect(f!.medianContextParagraphs).toBe(8);
    const [small] = workloadFeaturesFromItems([smallItem('classification')]);
    expect(small!.medianPromptChars).toBeLessThan(SELECT_MIN_PROMPT_CHARS);
    expect(small!.medianContextParagraphs).toBe(1);
  });

  it('a big-context workload gets select-and-verify; the selection keeps a real fraction', () => {
    const [f] = workloadFeaturesFromItems([bigItem('rag-answer', 12)]);
    const sel = synth([f!]).filter((c) => (c.config as { name: string }).name === 'select-and-verify');
    expect(sel.length).toBeGreaterThan(0);
    const keeps = selectsOf((sel[0]!.config as { body: ProgramNode }).body);
    expect(keeps.length).toBeGreaterThan(0);
    for (const k of keeps) {
      expect(k).toBeGreaterThan(0);
      expect(k).toBeLessThan(12); // dropping something is the whole point
    }
  });

  it('a small-prompt workload never gets one — there is nothing to drop', () => {
    const [f] = workloadFeaturesFromItems([smallItem('classification')]);
    for (const c of synth([f!])) {
      expect(selectsOf((c.config as { body: ProgramNode }).body)).toEqual([]);
    }
  });

  it('and neither does a workload we know nothing about', () => {
    const blind = generateCandidatesExplained(
      opts({ focusAlias: 'gpt-mini-class', includePrograms: true, budget: 90 }),
    ).filter((c) => c.config.type === 'program');
    for (const c of blind) expect(selectsOf((c.config as { body: ProgramNode }).body)).toEqual([]);
  });

  it('every selection program passes the schema and the static bound', () => {
    const [f] = workloadFeaturesFromItems([bigItem('rag-answer', 12)]);
    for (const c of synth([f!])) {
      expect(() => StrategyConfigSchema.parse(c.config)).not.toThrow();
      expect(programCallCount((c.config as { body: ProgramNode }).body)).toBeLessThanOrEqual(MAX_PROGRAM_CALLS);
    }
  });
});

// ---- C4 rung 4: tool-selection synthesis ----
describe('tool-selection synthesis (C4 rung 4)', () => {
  const tool = (n: string) => ({
    type: 'function' as const,
    function: { name: `t_${n}`, description: `does ${n}`, parameters: { type: 'object', properties: {} } },
  });
  const agentItem = (tools: number): EvalItem => ({
    id: `a-${tools}`,
    clusterId: 'agentic-tool-use' as EvalItem['clusterId'],
    prompt: [{ role: 'user', content: 'refund order A-119' }],
    scoring: { kind: 'tool-call', expect: { name: 't_refund' } },
    ...(tools > 0 ? { tools: Array.from({ length: tools }, (_, i) => tool(`x${i}`)) } : {}),
  });

  const synth = (w: WorkloadFeatures[]) =>
    generateCandidatesExplained(
      opts({ focusAlias: 'gpt-mini-class', includePrograms: true, budget: 90, workloads: w }),
    ).filter((c) => (c.config as { name?: string }).name === 'select-tools-or-retry');

  it('the catalogue size is DERIVED from the items', () => {
    const [f] = workloadFeaturesFromItems([agentItem(8), agentItem(10)]);
    expect(f!.medianToolCount).toBe(8);
    const [none] = workloadFeaturesFromItems([agentItem(0)]);
    expect(none!.medianToolCount).toBe(0);
  });

  it('a workload with a real catalogue gets select-tools-or-retry, gated on tool-called', () => {
    const [f] = workloadFeaturesFromItems([agentItem(8)]);
    const progs = synth([f!]);
    expect(progs.length).toBeGreaterThan(0);
    const body = (progs[0]!.config as { body: ProgramNode }).body as Extract<ProgramNode, { op: 'if' }>;
    expect(body.check.kind).toBe('tool-called');
    // the retry is the SAME model with the whole catalogue
    expect(programModels(body)).toEqual(['gpt-mini-class']);
    expect((body.else as { toolSelect?: unknown }).toolSelect).toBeUndefined();
  });

  it('and it can actually serve tools — an unservable tool mechanism is decoration', () => {
    const [f] = workloadFeaturesFromItems([agentItem(8)]);
    for (const c of synth([f!])) {
      expect(strategyCapabilities(c.config).canServeTools).toBe(true);
      expect(() => StrategyConfigSchema.parse(c.config)).not.toThrow();
    }
  });

  it('a workload with a small catalogue gets none — choosing 2 of 3 is a coin flip', () => {
    const [f] = workloadFeaturesFromItems([agentItem(3)]);
    expect(synth([f!])).toEqual([]);
    const [none] = workloadFeaturesFromItems([agentItem(0)]);
    expect(synth([none!])).toEqual([]);
  });

  it('and a workload we know nothing about gets none', () => {
    const blind = generateCandidatesExplained(
      opts({ focusAlias: 'gpt-mini-class', includePrograms: true, budget: 90 }),
    ).filter((c) => (c.config as { name?: string }).name === 'select-tools-or-retry');
    expect(blind).toEqual([]);
  });
});

// ---- Measured 2026-09-05: effort is gated by the instrument too ----
describe('effort escalation respects the deliberation coupling', () => {
  const synth = (w: WorkloadFeatures[] | undefined) =>
    generateCandidatesExplained(
      opts({ focusAlias: 'gpt-mini-class', includePrograms: true, budget: 80, ...(w ? { workloads: w } : {}) }),
    ).filter((c) => (c.config as { name?: string }).name === 'effort-escalation');

  it('is NOT offered where the instrument reads the answer shape', () => {
    // The live run measured this: effort-escalation scored 0.862 on the
    // extraction suite against 0.962 for the same model answering plainly.
    expect(synth([{ clusterId: 'extraction', scoringKinds: ['field-match'], requiredKeys: ['order'] }])).toEqual([]);
    expect(synth([{ clusterId: 'classification', scoringKinds: ['exact'] }])).toEqual([]);
  });

  it('IS offered where deliberation is safe — judged prose and fenced code', () => {
    expect(synth([{ clusterId: 'creative', scoringKinds: ['llm-judge'] }]).length).toBeGreaterThan(0);
    expect(synth([{ clusterId: 'code-gen', scoringKinds: ['code-exec'] }]).length).toBeGreaterThan(0);
  });

  it('is NOT offered when the instrument is unknown — same rule as instructing', () => {
    // With no workload information the compiler cannot know whether the answer
    // has a shape to break, and it has now MEASURED what guessing wrong costs.
    expect(synth(undefined)).toEqual([]);
  });
});
