// Golden interview corpus (Step 2 style): every fixture replays to a
// byte-identical result, the corpus is complete both directions, the
// review-outcome-3 minimums are present by name, and the committed
// generator regenerates the corpus byte-identically.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { canonicalJson, type Frontier } from '@potion/core';
import { ServingClient, type ServingResult } from '@potion/lab-runtime';
import { generateSpec, type GenerationResult } from './generate.js';
import type { InterviewAnswers } from './interview.js';

const GOLDEN_DIR = fileURLToPath(new URL('../fixtures/golden', import.meta.url));
const GENERATOR = fileURLToPath(new URL('../fixtures/generate-golden.mjs', import.meta.url));

const GOLDEN_NAMES = [
  'adversarial-prose',
  'cluster-uncertain',
  'extraction-unparseable',
  'frontier-missing',
  'frontier-not-live',
  'invalid-worth',
  'secret-refusal',
  'standing-memory',
  'task-simple',
  'tools-composite-only',
  'tools-external',
];

interface GoldenFixture {
  name: string;
  answers: InterviewAnswers;
  responses: string[];
  frontier: Frontier | null;
  expected: GenerationResult;
}

function load(name: string): GoldenFixture {
  return JSON.parse(readFileSync(path.join(GOLDEN_DIR, `${name}.json`), 'utf8')) as GoldenFixture;
}

function ok(text: string): ServingResult {
  return {
    kind: 'ok', completionId: 'chatcmpl-golden-1', text, toolCalls: [], finishReason: 'stop',
    usage: { promptTokens: 40, completionTokens: 30, totalTokens: 70 },
    frontierTrace: 'cluster=x;strategy=g;frontier=v1;policy=compound;fallback=0;provenance=mock',
  } as ServingResult;
}

describe('corpus completeness (both directions) + review-outcome-3 minimums', () => {
  it('every golden file is listed and vice versa', () => {
    const disk = readdirSync(GOLDEN_DIR).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, '')).sort();
    expect(disk).toEqual([...GOLDEN_NAMES].sort());
  });
  it('the operator-required minimums are present by name and outcome', () => {
    expect(load('standing-memory').expected.kind).toBe('complete');
    const partition = load('tools-external').expected;
    if (partition.kind !== 'complete') throw new Error('tools-external must complete');
    expect(partition.sidecar.choices[0]!.partition).toBe('single-only');
    const unrepresentable = load('tools-composite-only').expected;
    if (unrepresentable.kind !== 'draft') throw new Error('tools-composite-only must draft');
    expect(unrepresentable.gaps[0]!.code).toBe('no-single-points');
    const gapDraft = load('frontier-not-live').expected;
    if (gapDraft.kind !== 'draft') throw new Error('frontier-not-live must draft');
    expect(gapDraft.gaps[0]!.question.length).toBeGreaterThan(0);
    expect(load('secret-refusal').expected.kind).toBe('refused');
  });
  it('every gap code and refusal reason is produced by ≥1 fixture (no dead codes)', () => {
    const gaps = new Set<string>();
    const refusals = new Set<string>();
    for (const name of GOLDEN_NAMES) {
      const e = load(name).expected;
      if (e.kind === 'draft') for (const g of e.gaps) gaps.add(g.code);
      if (e.kind === 'refused') refusals.add(e.reason);
    }
    expect([...gaps].sort()).toEqual(['cluster-uncertain', 'frontier-missing', 'frontier-not-live', 'no-single-points']);
    expect([...refusals].sort()).toEqual(['extraction-unparseable', 'invalid-worth', 'secret-in-answers']);
  });
});

describe('golden replay — byte-identical', () => {
  for (const name of GOLDEN_NAMES) {
    it(`${name} replays to the committed result`, async () => {
      const g = load(name);
      const q = [...g.responses];
      // A REAL ServingClient with complete() scripted (the class holds private
      // state) — the replay's replies stay type-checked against ServingResult.
      const client = new ServingClient({ baseUrl: 'http://serving.invalid', apiKey: 'test-key' });
      client.complete = async () => ok(q.shift() ?? '');
      const result = await generateSpec(g.answers, { client, loadFrontier: async () => g.frontier });
      expect(canonicalJson(result)).toBe(canonicalJson(g.expected));
    });
  }
});

describe('generator reproducibility', () => {
  it('regenerating the corpus is byte-identical to the committed fixtures', () => {
    const out = mkdtempSync(path.join(tmpdir(), 'lab-gen-golden-'));
    try {
      execFileSync('node', [GENERATOR, out], { stdio: 'pipe' });
      for (const name of GOLDEN_NAMES) {
        const committed = readFileSync(path.join(GOLDEN_DIR, `${name}.json`), 'utf8');
        const regenerated = readFileSync(path.join(out, `${name}.json`), 'utf8');
        expect(regenerated, `${name} drifted — regenerate in the same commit that changed the generator`).toBe(committed);
      }
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }, 120_000);
});

describe('scope guard (structural)', () => {
  it('lab-gen imports no provider/MCP/UI surface; superpowers carry no token-shaped fields', () => {
    const srcDir = fileURLToPath(new URL('.', import.meta.url));
    for (const f of readdirSync(srcDir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))) {
      const src = readFileSync(path.join(srcDir, f), 'utf8');
      expect(src, `${f} must not import provider/harness/MCP surfaces`).not.toMatch(
        /from '@potion\/(providers|harness|workers|server)/,
      );
      expect(src, `${f} must not reference MCP`).not.toMatch(/\bmcp\b/i);
    }
    const g = load('tools-external').expected;
    if (g.kind !== 'complete') throw new Error('unexpected');
    for (const sp of g.spec.superpowers) {
      expect(Object.keys(sp).sort()).toEqual(['id', 'scopes']);
    }
  });
});
