// Candidate generator tests (M4b #37, SPEC §15.1): template grammar ×
// class-pruned registry, ≤20/cycle budget, dedupe vs existing hashes AND
// eval-cache cells, determinism, judge-focus carve-out, decompose opt-in.
import { describe, expect, it } from 'vitest';
import { strategyHash } from '@potion/core';
import {
  DEFAULT_CANDIDATE_BUDGET,
  generateCandidates,
  generateCandidatesExplained,
  type GenerateOptions,
} from './generate.js';
import { buildRegistry, type ModelRegistryEntry } from './registry.js';

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
    expect(templates).toContain('composite(start=cheap,upgrade=focus)');
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
    expect(templates).toContain('composite(start=cheap,upgrade=focus)');
    expect(templates.some((t) => t.startsWith('draft-verify'))).toBe(false);
    // Ensemble picks cross-provider strong peers (openai + anthropic).
    const ens = explained.find((c) => c.template === 'ensemble(focus+2x-peers)');
    expect(ens).toBeDefined();
    const models = (ens!.config as { models: string[] }).models;
    expect(models[0]).toBe('or-fable-5');
    expect(models).toContain('gpt-frontier-class');
    expect(models.length).toBe(3);
  });

  it('cheap-class focus: both composites; draft-verify present', () => {
    const explained = generateCandidatesExplained(opts({ focusAlias: 'or-haiku' }));
    const templates = explained.map((c) => c.template);
    expect(templates).toContain('composite(start=focus,upgrade=strong)');
    expect(templates).toContain('composite(start=cheap,upgrade=focus)');
    expect(templates).toContain('draft-verify(draft=focus,verifier=strong)');
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
