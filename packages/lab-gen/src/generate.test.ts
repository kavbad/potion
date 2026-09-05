// Orchestration paths: complete (with hash-bound sidecar and the
// orphan-on-edit proof — review outcome 2), secret refusal BEFORE any model
// call, extraction repair then refusal at the call bound, and the
// cluster-uncertain draft carrying its open question.
import { describe, expect, it } from 'vitest';
import { parseHarnessSpecText } from '@potion/lab-spec';
import type { Frontier, FrontierPoint } from '@potion/core';
import type { ServingClientLike, ServingResult } from '@potion/lab-runtime';
import { generateSpec, verifyChoicesBinding } from './generate.js';
import type { InterviewAnswers } from './interview.js';

function okResult(text: string): ServingResult {
  return {
    kind: 'ok',
    completionId: 'chatcmpl-gen-1',
    text,
    toolCalls: [],
    finishReason: 'stop',
    usage: { promptTokens: 50, completionTokens: 40, totalTokens: 90 },
    frontierTrace: 'cluster=summarization;strategy=x;frontier=v1;policy=compound;fallback=0;provenance=mock',
  } as ServingResult;
}

function scripted(responses: string[]): { client: ServingClientLike; calls: () => number } {
  const q = [...responses];
  let n = 0;
  // A plain object, checked against the real signatures: generateSpec takes
  // ServingClientLike, so a double no longer has to be a real client pointed
  // at an unroutable host.
  const client: ServingClientLike = {
    complete: async () => {
      n += 1;
      return okResult(q.shift() ?? '');
    },
    emitSpans: async () => true,
  };
  return { client, calls: () => n };
}

const EXTRACTION_JSON = JSON.stringify({
  normalizedGoal: 'Summarize the weekly meeting notes into a concise digest.',
  doneDefinition: 'A digest exists.',
  nameSlug: 'weekly-digest',
  clusterHint: 'summarization',
});

const ANSWERS: InterviewAnswers = {
  goal: 'summarize my weekly meeting notes into a digest',
  kind: 'task',
  doneDefinition: 'a digest exists',
  accounts: [],
  worthUsd: 2,
};

function livePoint(hash: string): FrontierPoint {
  return {
    clusterId: 'summarization',
    strategyHash: hash,
    strategyConfig: { type: 'single', model: 'or-x' },
    quality: 0.88,
    costPer1K: 0.012,
    latencyP95: 700,
    providerMode: 'live',
    evidence: { cacheKeys: ['ck'], runIds: ['r'], n: 14, qualityCi95: 0.02, suiteContentHash: 'b'.repeat(64) },
  };
}

const FRONTIER: Frontier = {
  id: 'fr-gen-1',
  clusterId: 'summarization',
  version: 1,
  parentId: null,
  trigger: 'recompute',
  points: [livePoint('hh-live-1')],
  pricesVersion: 'pv',
  createdAt: new Date(0).toISOString(),
};

const loadFrontier = async () => FRONTIER;

describe('generateSpec — complete path', () => {
  it('emits a parsing spec, a hash-bound sidecar, and full provenance', async () => {
    const { client, calls } = scripted([EXTRACTION_JSON]);
    const r = await generateSpec(ANSWERS, { client, loadFrontier });
    expect(r.kind).toBe('complete');
    if (r.kind !== 'complete') return;
    expect(calls()).toBe(1);
    expect(parseHarnessSpecText(r.specText).ok).toBe(true);
    expect(r.sidecar.choices).toHaveLength(1);
    expect(r.sidecar.choices[0]!.basis).toMatchObject({
      clusterId: 'summarization',
      frontierId: 'fr-gen-1',
      frontierVersion: 1,
      strategyHash: 'hh-live-1',
      providerMode: 'live',
      suiteContentHash: 'b'.repeat(64),
    });
    expect(verifyChoicesBinding(r.specText, r.sidecar)).toEqual({ bound: true });
  });

  it('review outcome 2: an edited spec visibly orphans its provenance', async () => {
    const { client } = scripted([EXTRACTION_JSON]);
    const r = await generateSpec(ANSWERS, { client, loadFrontier });
    if (r.kind !== 'complete') throw new Error('expected complete');
    const edited = JSON.parse(r.specText) as { name: string; hash?: string };
    edited.name = 'edited-by-hand';
    delete edited.hash; // an editor recomputing nothing simply drops it
    const check = verifyChoicesBinding(JSON.stringify(edited), r.sidecar);
    expect(check.bound).toBe(false);
    if (!check.bound) expect(check.reason).toContain('orphaned');
  });
});

describe('generateSpec — refusals and drafts', () => {
  it('review finding: degenerate worth (0 / negative / NaN) is a typed refusal, never a crash', async () => {
    for (const worth of [0, -5, Number.NaN]) {
      const { client, calls } = scripted([EXTRACTION_JSON]);
      const r = await generateSpec({ ...ANSWERS, worthUsd: worth }, { client, loadFrontier });
      expect(r.kind).toBe('refused');
      if (r.kind === 'refused') expect(r.reason).toBe('invalid-worth');
      expect(calls()).toBe(0);
    }
  });

  it('review finding: governance overflow is a typed refusal, never silent truncation', async () => {
    const { client } = scripted([EXTRACTION_JSON]);
    const tooMany = await generateSpec(
      { ...ANSWERS, constraints: Array.from({ length: 101 }, (_, i) => `rule ${i}`) },
      { client, loadFrontier },
    );
    expect(tooMany.kind).toBe('refused');
    if (tooMany.kind === 'refused') expect(tooMany.reason).toBe('answers-too-large');
    const tooLong = await generateSpec(
      { ...ANSWERS, constraints: ['x'.repeat(2001)] },
      { client, loadFrontier },
    );
    expect(tooLong.kind).toBe('refused');
    if (tooLong.kind === 'refused') expect(tooLong.reason).toBe('answers-too-large');
  });

  it('review finding: aggregate spec text over MAX_TOTAL_BYTES is a typed refusal', async () => {
    // 40 max-length rules pass every per-field cap but push the serialized
    // whole past 64KB.
    const { client } = scripted([EXTRACTION_JSON]);
    const r = await generateSpec(
      { ...ANSWERS, constraints: Array.from({ length: 40 }, (_, i) => `${i} ` + 'r'.repeat(1990)) },
      { client, loadFrontier },
    );
    expect(r.kind).toBe('refused');
    if (r.kind === 'refused') expect(r.reason).toBe('answers-too-large');
  });

  it('review finding: a tampered sidecar (rewritten choices) is detected — binding is two-way', async () => {
    const { client } = scripted([EXTRACTION_JSON]);
    const r = await generateSpec(ANSWERS, { client, loadFrontier });
    if (r.kind !== 'complete') throw new Error('expected complete');
    const tampered = {
      ...r.sidecar,
      choices: r.sidecar.choices.map((c) => ({ ...c, basis: { ...c.basis, strategyHash: 'forged-hash' } })),
    };
    const check = verifyChoicesBinding(r.specText, tampered);
    expect(check.bound).toBe(false);
    if (!check.bound) expect(check.reason).toContain('tampered');
  });

  it('review finding: a model echoing control characters is a repairable parse failure', async () => {
    const withCtrl = JSON.stringify({
      normalizedGoal: 'Summarize the notes\u0007 now.',
      doneDefinition: 'A digest exists.',
      nameSlug: 'weekly-digest',
      clusterHint: 'summarization',
    });
    const { client, calls } = scripted([withCtrl, EXTRACTION_JSON]);
    const r = await generateSpec(ANSWERS, { client, loadFrontier });
    expect(r.kind).toBe('complete');
    expect(calls()).toBe(2);
  });

  it('secret in answers refuses BEFORE any model call', async () => {
    const { client, calls } = scripted([EXTRACTION_JSON]);
    const r = await generateSpec(
      { ...ANSWERS, goal: 'use key sk-ant-api03-abcdefghijklmnopqrstuvwx to fetch data' },
      { client, loadFrontier },
    );
    expect(r.kind).toBe('refused');
    if (r.kind === 'refused') expect(r.reason).toBe('secret-in-answers');
    expect(calls()).toBe(0);
  });

  it('unparseable extraction: one repair pass, then a typed refusal at the call bound', async () => {
    const { client, calls } = scripted(['not json at all', 'still not json']);
    const r = await generateSpec(ANSWERS, { client, loadFrontier });
    expect(r.kind).toBe('refused');
    if (r.kind === 'refused') expect(r.reason).toBe('extraction-unparseable');
    expect(calls()).toBe(2);
  });

  it('fence-wrapped JSON is tolerated (models do this)', async () => {
    const { client } = scripted(['```json\n' + EXTRACTION_JSON + '\n```']);
    const r = await generateSpec(ANSWERS, { client, loadFrontier });
    expect(r.kind).toBe('complete');
  });

  it('cluster-uncertain: hint disagrees with a flat lexical field → draft with the open question', async () => {
    const disagreeing = JSON.stringify({
      ...JSON.parse(EXTRACTION_JSON),
      clusterHint: 'code-gen',
    });
    const { client } = scripted([disagreeing]);
    const r = await generateSpec(
      { ...ANSWERS, goal: 'handle the thing for the stuff' }, // no cluster keywords
      { client, loadFrontier },
    );
    expect(r.kind).toBe('draft');
    if (r.kind === 'draft') {
      expect(r.gaps[0]!.code).toBe('cluster-uncertain');
      expect(r.gaps[0]!.question.length).toBeGreaterThan(0);
    }
  });

  it('clusterChoice: the operator answer resolves the same interview to complete, on the chosen cluster', async () => {
    // Same disagreeing extraction as above — without the answer it drafts;
    // with it, the answer is authoritative and generation completes.
    const disagreeing = JSON.stringify({
      ...JSON.parse(EXTRACTION_JSON),
      clusterHint: 'code-gen',
    });
    const { client } = scripted([disagreeing]);
    const r = await generateSpec(
      { ...ANSWERS, goal: 'handle the thing for the stuff', clusterChoice: 'summarization' },
      { client, loadFrontier },
    );
    expect(r.kind).toBe('complete');
    if (r.kind === 'complete') {
      expect(r.sidecar.choices[0]!.basis.clusterId).toBe('summarization');
    }
  });

  it('clusterChoice never bypasses the refusal gates that run first', async () => {
    const { client, calls } = scripted([]);
    const r = await generateSpec(
      { ...ANSWERS, worthUsd: 0, clusterChoice: 'summarization' },
      { client, loadFrontier },
    );
    expect(r.kind).toBe('refused');
    if (r.kind === 'refused') expect(r.reason).toBe('invalid-worth');
    expect(calls()).toBe(0);
  });
});

describe('recipe card at the generate gate (2026-08-27)', () => {
  it('oversize qualityBar is a typed refusal, never truncated governance', async () => {
    const r = await generateSpec(
      { goal: 'summarize notes weekly into a digest', kind: 'task', doneDefinition: 'digest exists', accounts: [], worthUsd: 2, qualityBar: 'x'.repeat(2000) },
      { client: scripted([]).client, loadFrontier: async () => null },
    );
    expect(r.kind).toBe('refused');
    if (r.kind === 'refused') expect(r.reason).toBe('answers-too-large');
  });

  it('the work profile is primary-first and deduped against alsoClusters', async () => {
    const { client } = scripted([
      JSON.stringify({
        normalizedGoal: 'Summarize the weekly notes into a digest.',
        doneDefinition: 'A digest exists.',
        nameSlug: 'weekly-digest',
        clusterHint: 'summarization',
        alsoClusters: ['summarization', 'extraction', 'rag-answer'],
      }),
    ]);
    const r = await generateSpec(
      { goal: 'summarize notes weekly into a digest', kind: 'task', doneDefinition: 'digest exists', accounts: [], worthUsd: 2 },
      { client, loadFrontier: async () => FRONTIER },
    );
    expect(r.kind).toBe('complete');
    if (r.kind === 'complete') {
      expect(r.sidecar.workProfile).toEqual(['summarization', 'extraction', 'rag-answer']);
    }
  });
});
