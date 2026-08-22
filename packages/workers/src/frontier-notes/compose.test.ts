import { describe, expect, it } from 'vitest';
import type { ObservatoryRun } from '../observatory.js';
import type { ClusterReplay } from '../replay.js';
import { composeFactSheet, costBand, isLargeFinding, publicName } from './compose.js';
import { assembleIssue, issueSlug, publishableText, renderMarkdown } from './publish.js';
import { deterministicDraft, parseDraft } from './write.js';

const run: ObservatoryRun = {
  week: '2026-W34',
  at: '2026-08-24T06:00:00.000Z',
  envelopeBefore: { monthKey: '2026-08', capUsd: 50, mtdUsd: 2.13, remainingUsd: 47.87 },
  plan: { canaryClusters: ['classification', 'creative'], canaryBudgetUsd: 3, auditions: 1, auditionBudgetUsd: 6, notes: [] },
  canaries: [
    { clusterId: 'classification', model: 'or-solar-pro4', strategyHash: 'h1', storedQuality: 0.976, storedCi95: 0.03, observedMean: 1, n: 4, verdict: 'ok', spendUsd: 0.01 },
    { clusterId: 'creative', model: 'or-sonnet', strategyHash: 'h2', storedQuality: 0.907, storedCi95: 0.05, observedMean: 0.875, n: 4, verdict: 'ok', spendUsd: 0.2 },
  ],
  auditions: [{ alias: 'or-nex-n2-mini', clusterId: 'classification', lane: 'small/cheap', why: 'x', spendUsd: 1.2, earnedSlot: false, frontierVersion: null }],
  catalogue: { listings: 355, newSinceRegistry: 325, skippedNoPricing: 0, freeTierExcluded: 21, ranked: 3 },
  spendUsd: 1.41,
  envelopeAfter: { monthKey: '2026-08', capUsd: 50, mtdUsd: 3.54, remainingUsd: 46.46 },
};

const replays: ClusterReplay[] = [
  {
    clusterId: 'extraction',
    singles: [],
    headroomPairs: [],
    recipes: [
      { kind: 'oracle', models: ['a', 'b'], n: 20, meanQuality: 1, meanCostUsd: 0.01, qualityDeltaVsBestSingle: 0.05, costSavingVsBestSingle: 0.5, frontierCandidate: true, cheaperAndAsGood: true },
      { kind: 'confidence-gated-cascade', models: ['or-gpt-mini', 'or-sonnet'], params: { tau: 0.7 }, n: 20, meanQuality: 0.96, meanCostUsd: 0.004, qualityDeltaVsBestSingle: 0, costSavingVsBestSingle: 0.62, frontierCandidate: true, cheaperAndAsGood: true },
    ],
  },
  {
    clusterId: 'summarization',
    singles: [],
    headroomPairs: [],
    recipes: [
      { kind: 'vote3', models: ['x', 'x', 'x'], n: 14, meanQuality: 0.9, meanCostUsd: 0.02, qualityDeltaVsBestSingle: 0.005, costSavingVsBestSingle: 0.2, frontierCandidate: true, cheaperAndAsGood: true },
    ],
  },
];

describe('frontier-notes compose', () => {
  it('withholds names and keeps numbers', () => {
    const f = composeFactSheet(run, replays);
    expect(f.frontier.find((c) => c.clusterId === 'classification')?.pick).toBe('name withheld');
    expect(f.frontier.find((c) => c.clusterId === 'creative')?.pick).toBe('or-sonnet');
    expect(f.frontier[0]?.storedQuality).toBe(0.976);
    expect(publicName('or-gpt-mini')).toBe('or-gpt-mini');
    expect(publicName('upstage/solar-pro-4')).toBe('name withheld');
  });

  it('applies the breakthrough rule: large findings go vague, small ones stay specific', () => {
    const f = composeFactSheet(run, replays);
    const ex = f.mixing.find((m) => m.family === 'structured output')!;
    const su = f.mixing.find((m) => m.clusterId === 'summarization')!;
    expect(ex.vague).toBe(true);
    expect(ex.clusterId).toBeUndefined();
    expect(ex.costBand).toBe('between 2× and 4× cheaper');
    expect(su.vague).toBe(false);
    expect(isLargeFinding({ cheaperAndAsGood: true, costSavingVsBestSingle: 0.1, qualityDeltaVsBestSingle: 0.01 })).toBe(false);
    expect(costBand(0.9)).toBe('more than 8× cheaper');
  });

  it('never carries component models, params or hashes into the fact sheet', () => {
    const f = composeFactSheet(run, replays);
    const s = JSON.stringify(f);
    expect(s).not.toMatch(/or-gpt-mini|tau|cascade|vote3|h1|h2/);
  });

  it('assembles a publishable issue from the deterministic draft', () => {
    const f = composeFactSheet(run, replays);
    const d = deterministicDraft(f);
    const issue = assembleIssue(f, d, { publishedAt: '2026-08-24T07:00:00.000Z', writer: null, gate: false });
    expect(issue.status).toBe('published');
    expect(issue.slug).toMatch(/^2026-w34-/);
    expect(issue.title).toMatch(/held/);
    expect(issue.faq).toHaveLength(3);
    const md = renderMarkdown(issue);
    expect(md).toContain('| classification | held | name withheld |');
    expect(md).not.toMatch(/solar/i);
  });

  it('holds an issue when the gate is set, and when a draft leaks', () => {
    const f = composeFactSheet(run, replays);
    const d = deterministicDraft(f);
    expect(assembleIssue(f, d, { publishedAt: 'x', writer: null, gate: true }).status).toBe('held');
    const leaky = { ...d, mixingNote: 'We ran or-gpt-mini then escalated to or-sonnet when confidence is below 0.7.' };
    const held = assembleIssue(f, leaky, { publishedAt: 'x', writer: null, gate: false });
    expect(held.status).toBe('held');
    expect(held.heldReason).toMatch(/leak/);
  });

  it('parses a model draft strictly', () => {
    expect(parseDraft('nope')).toBeNull();
    const ref = deterministicDraft(composeFactSheet(run, replays));
    const drift = parseDraft(JSON.stringify({ title: 'A finding.', plain: 'Plain words.', lede: 'l', faq: [{ q: 'x', a: 'y' }, { q: 'z', a: 'w' }] }), ref);
    expect(drift?.title).toBe('A finding.');
    expect(drift?.frontierNote).toBe(ref.frontierNote);
    expect(drift?.faq).toHaveLength(3);
    expect(parseDraft(JSON.stringify({ lede: 'no title' }), ref)).toBeNull();
    const ok = parseDraft(JSON.stringify({ title: 't.', summary: 's', plain: 'p', lede: 'l', frontierNote: 'f', auditionNote: 'a', mixingNote: 'm', takeaway: 't', faq: [{ q: '1', a: 'a' }, { q: '2', a: 'b' }, { q: '3', a: 'c' }] }));
    expect(ok?.title).toBe('t.');
    expect(issueSlug('2026-W34', 'All 10 routing frontiers held this week; a combination matched.')).toBe('2026-w34-all-10-routing-frontiers-held-combination-matched');
    expect(publishableText({ ...assembleIssue(composeFactSheet(run, replays), deterministicDraft(composeFactSheet(run, replays)), { publishedAt: 'x', writer: null, gate: false }) })).toContain('name withheld');
  });
});

describe('frontier-notes potion writer', () => {
  it('parses the trace header into a receipt', async () => {
    const { parseTrace, potionDraft } = await import('./write.js');
    expect(parseTrace('cluster=creative;strategy=07b4dc72;frontier=v3;policy=min_cost;fallback=0;provenance=live')).toEqual({
      cluster: 'creative', strategy8: '07b4dc72', policy: 'min_cost', provenance: 'live',
    });
    const f = composeFactSheet(run, replays);
    const good = JSON.stringify(deterministicDraft(f));
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: good } }], usage: { prompt_tokens: 10, completion_tokens: 20 } }), {
        status: 200, headers: { 'x-frontier-trace': 'cluster=creative;strategy=07b4dc72;frontier=v3;policy=min_cost;fallback=0;provenance=live' },
      })) as unknown as typeof fetch;
    const r = await potionDraft(f, { url: 'http://x', apiKey: 'pk_test', fetchImpl });
    expect(r.fallback).toBeNull();
    expect(r.receipt?.cluster).toBe('creative');
    expect(r.receipt?.completionTokens).toBe(20);
    const bad = (async () => new Response('nope', { status: 503 })) as unknown as typeof fetch;
    const r2 = await potionDraft(f, { url: 'http://x', apiKey: 'pk_test', fetchImpl: bad });
    expect(r2.fallback).toMatch(/HTTP 503/);
    expect(r2.draft.title).toBe(deterministicDraft(f).title);
  });
});
