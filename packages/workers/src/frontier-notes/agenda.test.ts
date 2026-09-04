// ATLAS — the agenda (F8). The editorial judgment must be inspectable and
// must not produce content-farm output: no echoes, no thin duplicates, and
// nothing it cannot prove.
import { describe, expect, it } from 'vitest';
import { claimKey, generateAgenda, generateCatalogueAgenda, renderAgenda, type ClusterSignal } from './agenda.js';

const NOW = new Date('2026-09-04T12:00:00Z');

/** The real prod code-gen frontier (2026-09-04) — the 296× story. */
const CODE_GEN: ClusterSignal = {
  clusterId: 'code-gen',
  points: [
    { model: 'or-grok-4.6', quality: 1, costPer1K: 6.846255319148936, n: 94 },
    { model: 'or-gemini-flash', quality: 0.9938998649105032, costPer1K: 0.5537085106382978, n: 94 },
    { model: 'or-gpt-mini', quality: 0.9880568603972858, costPer1K: 0.2520468085106382, n: 94 },
    { model: 'or-solar-pro4', quality: 0.979456802063185, costPer1K: 0.023159680851063822, n: 94 },
  ],
};

const CREATIVE: ClusterSignal = {
  clusterId: 'creative',
  points: [
    { model: 'or-sonnet', quality: 0.9, costPer1K: 7.658666666666667, n: 18 },
    { model: 'or-deepseek', quality: 0.85, costPer1K: 0.8281166666666667, n: 18 },
  ],
};

describe('the agenda', () => {
  it('finds the category’s defining story in the corpus and ranks it first', () => {
    const a = generateAgenda({ signals: [CODE_GEN, CREATIVE], now: NOW });
    expect(a[0]!.kind).toBe('quality-premium');
    expect(a[0]!.clusterId).toBe('code-gen');
    expect(a[0]!.headline).toMatch(/last 2\.1 points of code gen quality cost 296×/);
    // Every number in the headline is in the evidence the writer will get.
    expect(a[0]!.evidence.factor).toBe(295.6);
    expect(a[0]!.evidence.topModel).toBe('or-grok-4.6');
    expect(a[0]!.evidence.cheapModel).toBe('or-solar-pro4');
    expect(a[0]!.demandQuery).toMatch(/how much does the best code gen model cost/);
  });

  it('every candidate carries a demand query and provable evidence — no opinions', () => {
    for (const c of generateAgenda({ signals: [CODE_GEN, CREATIVE], now: NOW })) {
      expect(c.demandQuery.length).toBeGreaterThan(10);
      expect(Object.keys(c.evidence).length).toBeGreaterThan(2);
      expect(c.evidence.n).toBeDefined();
      expect(c.why).toMatch(/demand .* magnitude .* evidence .* novelty/);
      expect(c.score).toBeGreaterThan(0);
    }
  });

  it('NO ECHOES: one story is never queued twice under different kinds', () => {
    const a = generateAgenda({ signals: [CODE_GEN], now: NOW });
    const claims = a.map((c) =>
      Object.entries(c.evidence)
        .filter(([k, v]) => typeof v === 'string' && /model/i.test(k))
        .map(([, v]) => v)
        .sort()
        .join('|'),
    );
    expect(new Set(claims).size).toBe(claims.length);
  });

  it('floors with the SAME clearing set collapse to the strongest claim', () => {
    // Every code-gen point clears 0.9 and 0.95 — identical sets, one piece.
    const a = generateAgenda({ signals: [CODE_GEN], now: NOW, floors: [0.9, 0.95, 0.99] });
    const floorPieces = a.filter((c) => c.kind === 'cheapest-at-floor');
    const floorsUsed = floorPieces.map((c) => c.evidence.floor);
    expect(new Set(floorsUsed).size).toBe(floorsUsed.length);
    expect(floorPieces.length).toBeLessThanOrEqual(2);
  });

  it('a told story cools its whole CLAIM, so the queue rotates to a new subject', () => {
    const fresh = generateAgenda({ signals: [CODE_GEN, CREATIVE], now: NOW })[0]!;
    expect(fresh.clusterId).toBe('code-gen');
    const after = generateAgenda({
      signals: [CODE_GEN, CREATIVE],
      now: NOW,
      published: new Map([[claimKey(fresh.clusterId, fresh.evidence), '2026-09-03T12:00:00Z']]),
    });
    // EVERY angle on those two models is gone from the queue — not merely
    // down-ranked. A weight alone reruns the best number forever.
    for (const c of after) {
      expect(claimKey(c.clusterId, c.evidence)).not.toBe(claimKey(fresh.clusterId, fresh.evidence));
    }
    expect(after.length).toBeGreaterThan(0); // the agenda still has work
    // …and after the cooldown expires it returns.
    const later = generateAgenda({
      signals: [CODE_GEN, CREATIVE],
      now: new Date('2026-11-04T12:00:00Z'),
      published: new Map([[claimKey(fresh.clusterId, fresh.evidence), '2026-09-03T12:00:00Z']]),
    });
    expect(later.some((c) => claimKey(c.clusterId, c.evidence) === claimKey(fresh.clusterId, fresh.evidence))).toBe(true);
  });

  it('refuses to propose a piece it cannot prove (a lone point is not a comparison)', () => {
    expect(generateAgenda({ signals: [{ clusterId: 'code-gen', points: [CODE_GEN.points[0]!] }], now: NOW })).toEqual([]);
    // …and a 1.1× spread is a footnote, not a headline.
    const flat: ClusterSignal = {
      clusterId: 'code-gen',
      points: [
        { model: 'a', quality: 0.98, costPer1K: 1.0, n: 90 },
        { model: 'b', quality: 0.97, costPer1K: 0.95, n: 90 },
      ],
    };
    expect(generateAgenda({ signals: [flat], now: NOW })).toEqual([]);
  });

  it('renders an agenda an operator can argue with', () => {
    const text = renderAgenda(generateAgenda({ signals: [CODE_GEN], now: NOW }), 3);
    expect(text).toMatch(/THE AGENDA/);
    expect(text).toMatch(/asks: "/);
    expect(text).toMatch(/demand .*magnitude/);
  });
});

describe('the catalogue generators (price economics)', () => {
  const entries = [
    ...Array.from({ length: 12 }, (_, i) => ({
      alias: `cheap-tool-${i}`,
      provider: 'or',
      inputPer1M: 0.1 + i * 0.05,
      outputPer1M: 0.3 + i * 0.05,
      contextLength: 128_000,
      supportsTools: true,
      source: 'seed',
      firstSeen: '2026-01-01T00:00:00Z',
    })),
    {
      alias: 'premium-tool',
      provider: 'or',
      inputPer1M: 30,
      outputPer1M: 120,
      contextLength: 400_000,
      supportsTools: true,
      source: 'seed',
      firstSeen: '2026-01-01T00:00:00Z',
    },
    ...Array.from({ length: 6 }, (_, i) => ({
      alias: `long-ctx-${i}`,
      provider: 'or',
      inputPer1M: 4 + i,
      outputPer1M: 12 + i,
      contextLength: 1_000_000,
      supportsTools: false,
      source: 'seed',
      firstSeen: '2026-01-01T00:00:00Z',
    })),
    ...Array.from({ length: 7 }, (_, i) => ({
      alias: `arrival-${i}`,
      provider: 'or',
      inputPer1M: 0.2,
      outputPer1M: 0.6,
      contextLength: 128_000,
      supportsTools: true,
      source: 'scan',
      firstSeen: '2026-08-20T00:00:00Z',
    })),
  ];

  it('prices the same declared capability across the market', () => {
    const a = generateCatalogueAgenda({ entries, now: NOW });
    const disp = a.find((c) => c.id === 'catalogue:tool-price-dispersion')!;
    expect(disp.headline).toMatch(/Tool-calling models are priced .*apart/);
    expect(disp.evidence.dearestModel).toBe('premium-tool');
    expect(Number(disp.evidence.factor)).toBeGreaterThan(5);
    expect(disp.demandQuery).toMatch(/how much do tool calling models cost/);
  });

  it('reports the arrivals and the long-context premium', () => {
    const a = generateCatalogueAgenda({ entries, now: NOW });
    expect(a.find((c) => c.id.startsWith('catalogue:arrivals'))!.headline).toMatch(/models entered the catalogue in 30 days/);
    const ctx = a.find((c) => c.id === 'catalogue:long-context-premium');
    expect(ctx?.headline).toMatch(/long-context model costs/);
  });

  it('respects the cooldown like every other candidate', () => {
    const told = new Map([['catalogue:tool-price-dispersion', '2026-09-03T00:00:00Z']]);
    const a = generateCatalogueAgenda({ entries, now: NOW, published: told });
    expect(a.some((c) => c.id === 'catalogue:tool-price-dispersion')).toBe(false);
  });

  it('stays silent on a catalogue too small to say anything', () => {
    expect(generateCatalogueAgenda({ entries: entries.slice(0, 4), now: NOW })).toEqual([]);
  });
});
