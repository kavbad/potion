import { describe, expect, it } from 'vitest';
import type { FrontierPoint, PriceEntry } from '@potion/core';
import {
  AUDITIONS_PER_WEEK,
  CANARY_CAP_USD,
  canaryTarget,
  digestLine,
  driftVerdict,
  envelopeFor,
  isoWeek,
  planLanes,
  rankCandidates,
  type LedgerRow,
  type ObservatoryRun,
} from './observatory.js';

const pt = (q: number, c: number, hash = `h${q}${c}`): FrontierPoint =>
  ({ clusterId: 'code-gen', strategyHash: hash, strategyConfig: { type: 'single', model: `m-${hash}` }, quality: q, costPer1K: c, latencyP95: 100 }) as FrontierPoint;
const entry = (alias: string, inp: number, out: number, model = alias): PriceEntry =>
  ({ alias, provider: 'openrouter', model, inputPer1M: inp, outputPer1M: out, class: 'cheap' }) as unknown as PriceEntry;

describe('isoWeek', () => {
  it('is ISO-8601: Jan 1 2027 (a Friday) belongs to 2026-W53', () => {
    expect(isoWeek(new Date('2026-08-24T00:00:00Z'))).toBe('2026-W35');
    expect(isoWeek(new Date('2027-01-01T00:00:00Z'))).toBe('2026-W53');
  });
});

describe('envelope + lane plan — canaries first, then auditions, belt is a belt', () => {
  const rows: LedgerRow[] = [
    { at: '2026-08-03T06:00:00Z', week: '2026-W32', lane: 'canary', spendUsd: 1.2 },
    { at: '2026-08-10T06:00:00Z', week: '2026-W33', lane: 'audition', spendUsd: 6 },
    { at: '2026-07-27T06:00:00Z', week: '2026-W31', lane: 'audition', spendUsd: 40 }, // last month: ignored
  ];
  it('sums only the current month', () => {
    const e = envelopeFor(rows, new Date('2026-08-24T06:00:00Z'));
    expect(e.mtdUsd).toBeCloseTo(7.2);
    expect(e.remainingUsd).toBeCloseTo(42.8);
  });
  it('full envelope: all canaries + three auditions', () => {
    const plan = planLanes(envelopeFor([], new Date('2026-08-24T06:00:00Z')), ['a', 'b', 'c']);
    expect(plan.canaryClusters).toEqual(['a', 'b', 'c']);
    expect(plan.auditions).toBe(AUDITIONS_PER_WEEK);
    expect(plan.notes).toEqual([]);
  });
  it('near the belt: canaries survive, auditions are cut, and the cut is published', () => {
    const spent: LedgerRow[] = [{ at: '2026-08-20T06:00:00Z', week: '2026-W34', lane: 'audition', spendUsd: 47 }];
    const plan = planLanes(envelopeFor(spent, new Date('2026-08-24T06:00:00Z')), ['a', 'b', 'c', 'd']);
    expect(plan.canaryClusters).toEqual(['a', 'b', 'c', 'd']);
    expect(plan.auditions).toBe(1); // $3 left − $0.60 canaries = $2.40 → one $2 audition
    expect(plan.notes.join(' ')).toMatch(/affords 1\/3 auditions/);
  });
  it('belt exhausted: even canaries are rationed, never silently', () => {
    const spent: LedgerRow[] = [{ at: '2026-08-20T06:00:00Z', week: '2026-W34', lane: 'audition', spendUsd: 49.8 }];
    const plan = planLanes(envelopeFor(spent, new Date('2026-08-24T06:00:00Z')), ['a', 'b', 'c']);
    expect(plan.canaryClusters).toEqual(['a']); // $0.20 affords one $0.15 canary
    expect(plan.auditions).toBe(0);
    expect(plan.notes[0]).toMatch(/affords 1\/3 canaries/);
    expect(plan.canaryBudgetUsd).toBeCloseTo(CANARY_CAP_USD);
  });
});

describe('canaryTarget — the point a partner is riding', () => {
  it('cheapest point at or above the floor; cheapest overall if none clears it', () => {
    expect(canaryTarget([pt(0.99, 6), pt(0.9, 0.5), pt(0.7, 0.01)])!.costPer1K).toBe(0.5);
    expect(canaryTarget([pt(0.7, 0.01), pt(0.8, 0.3)])!.costPer1K).toBe(0.01);
    expect(canaryTarget([])).toBeNull();
  });
});

describe('driftVerdict — alarms only outside stored CI widened by canary noise', () => {
  const stored = { quality: 0.9, qualityCi95: 0.05 };
  it('a normal canary is ok; a collapse is drift; one item is inconclusive', () => {
    expect(driftVerdict(stored, { meanQuality: 0.75, n: 4 }).verdict).toBe('ok'); // lower bound ≈ 0.556
    expect(driftVerdict(stored, { meanQuality: 0.25, n: 4 }).verdict).toBe('drift');
    expect(driftVerdict(stored, { meanQuality: 0.0, n: 1 }).verdict).toBe('inconclusive');
  });
  it('getting BETTER is never drift', () => {
    expect(driftVerdict(stored, { meanQuality: 1.0, n: 4 }).verdict).toBe('ok');
  });
});

describe('rankCandidates — cheap-and-specialist first, one cluster each', () => {
  const routed = { 'code-gen': 0.02, extraction: 0.2, 'agentic-tool-use': 7.19 };
  it('routes by lane, prefers cheaper, caps at the weekly limit, and explains itself', () => {
    const added = [
      entry('or-acme-coder-7b', 0.1, 0.3),
      entry('or-bigco-general-ultra', 15, 60),
      entry('or-json-extractor-mini', 0.05, 0.2),
      entry('or-someone-omni', 2, 8),
      entry('or-other-generic', 1, 4),
    ];
    const ranked = rankCandidates(added, routed);
    expect(ranked).toHaveLength(AUDITIONS_PER_WEEK);
    const byAlias = Object.fromEntries(ranked.map((r) => [r.entry.alias, r]));
    expect(byAlias['or-acme-coder-7b']!.clusterId).toBe('code-gen');
    expect(byAlias['or-json-extractor-mini']!.clusterId).toBe('extraction');
    // the priciest routed pick is agentic — a generalist auditions there
    const generalist = ranked.find((r) => r.lane === 'generalist');
    expect(generalist?.clusterId).toBe('agentic-tool-use');
    expect(ranked.every((r) => r.why.length > 10)).toBe(true);
    expect(ranked.map((r) => r.entry.alias)).not.toContain('or-bigco-general-ultra');
  });
  it('free tiers never audition — a partner must never be routed onto one', () => {
    const added = [entry('or-gemma-4-31b-it-free', 0, 0, 'google/gemma-4-31b-it:free'), entry('or-paid-coder', 0.2, 0.6)];
    const ranked = rankCandidates(added, routed);
    expect(ranked.map((r) => r.entry.alias)).toEqual(['or-paid-coder']);
  });
});

describe('digestLine — a quiet week says so', () => {
  const base: ObservatoryRun = {
    week: '2026-W35',
    at: '2026-08-24T06:00:00Z',
    envelopeBefore: { monthKey: '2026-08', capUsd: 50, mtdUsd: 0, remainingUsd: 50 },
    plan: { canaryClusters: ['a'], canaryBudgetUsd: 0.15, auditions: 0, auditionBudgetUsd: 0, notes: [] },
    canaries: [{ clusterId: 'code-gen', model: 'm', strategyHash: 'h', storedQuality: 0.9, storedCi95: 0.05, observedMean: 0.9, n: 4, verdict: 'ok', spendUsd: 0.03 }],
    auditions: [],
    catalogue: { listings: 400, newSinceRegistry: 2, skippedNoPricing: 1, freeTierExcluded: 1, ranked: 0 },
    spendUsd: 0.03,
    envelopeAfter: { monthKey: '2026-08', capUsd: 50, mtdUsd: 0.03, remainingUsd: 49.97 },
  };
  it('renders nulls as findings and alarms as alarms', () => {
    expect(digestLine(base)).toBe('2026-W35: 1 canaries — no drift · no auditions (2 new listings, 1 free-tier excluded, 0 ranked) · spend $0.03; month $0.03 of $50');
    const loud = { ...base, canaries: [{ ...base.canaries[0]!, verdict: 'drift' as const }], auditions: [{ alias: 'or-x', clusterId: 'extraction', lane: 'extraction/json', why: 'w', spendUsd: 1.1, earnedSlot: true, frontierVersion: 4 }] };
    expect(digestLine(loud)).toMatch(/DRIFT on code-gen\/m/);
    expect(digestLine(loud)).toMatch(/EARNED: or-x on extraction/);
  });
});
