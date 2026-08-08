// G2.6 — compound policy (quality floor + HARD latency bound), serving-grade
// latency resolution, and the cost premium the bound is charging.
//
// The M1b shape drives most of these: a cascade reaches near-frontier quality
// at roughly a third of the cost, but escalating makes it a two-call latency
// profile. That is exactly the point a tight p95 bound prunes, and the whole
// premium feature exists so the customer sees the bill for it.
import { describe, expect, it } from 'vitest';
import {
  PolicySchema,
  SERVING_LATENCY_MIN_SAMPLES,
  fastestQualityQualifyingPoint,
  latencyPremium,
  resolveLatency,
  selectPoint,
  type Frontier,
  type FrontierPoint,
  type Policy,
} from './index.js';

function pt(
  hash: string,
  quality: number,
  costPer1K: number,
  latencyP95: number,
): FrontierPoint {
  return {
    clusterId: 'code-gen',
    strategyHash: hash,
    strategyConfig: { type: 'single', model: 'mock-mid' },
    quality,
    costPer1K,
    latencyP95,
  };
}

// The M1b frontier shape.
const CHEAP = pt('h-cheap', 0.72, 0.4, 300); // fast, below a 0.8 floor
const CASCADE = pt('h-cascade', 0.88, 0.9, 2100); // near-frontier quality, ⅓ cost, SLOW
const STRONG = pt('h-strong', 0.9, 2.5, 1200); // frontier quality, full price, fast enough
const POINTS = [CHEAP, CASCADE, STRONG];

const frontier = (points: FrontierPoint[]): Frontier => ({
  id: 'f1',
  clusterId: 'code-gen',
  version: 1,
  parentId: null,
  trigger: 'manual',
  points,
  pricesVersion: 'test',
  createdAt: '2026-08-08T00:00:00.000Z',
});

const compound = (qualityFloor: number, p95Ms: number): Policy => ({
  type: 'compound',
  qualityFloor,
  p95Ms,
});

// ---------------------------------------------------------------------------
// selectPoint: the hard intersect
// ---------------------------------------------------------------------------

describe('selectPoint — compound', () => {
  it('intersects BOTH constraints and minimizes cost among the survivors', () => {
    // floor 0.8 kills CHEAP; bound 1500 kills CASCADE; STRONG survives.
    expect(selectPoint(compound(0.8, 1500), frontier(POINTS))?.strategyHash).toBe('h-strong');
  });

  it('a RELAXED bound lets the cheaper composition win — the trade the premium reports', () => {
    // Same quality floor, bound relaxed past the cascade's 2100ms p95.
    expect(selectPoint(compound(0.8, 2500), frontier(POINTS))?.strategyHash).toBe('h-cascade');
  });

  it('the latency bound EXCLUDES; it is never traded off against cost', () => {
    // CASCADE is cheaper AND clears quality, but exceeds the bound. A soft
    // objective would pick it on cost; a hard constraint must not.
    const chosen = selectPoint(compound(0.8, 1500), frontier(POINTS));
    expect(chosen?.strategyHash).not.toBe('h-cascade');
    expect(chosen!.latencyP95).toBeLessThanOrEqual(1500);
  });

  it('both bounds are INCLUSIVE (>= floor, <= p95) at the exact boundary', () => {
    const exact = pt('h-exact', 0.8, 0.1, 1500);
    const chosen = selectPoint(compound(0.8, 1500), frontier([exact]));
    expect(chosen?.strategyHash).toBe('h-exact');
    // …and one unit outside on either axis is excluded.
    expect(selectPoint(compound(0.8, 1499), frontier([exact]))).toBeNull();
    expect(selectPoint(compound(0.81, 1500), frontier([exact]))).toBeNull();
  });

  it('cost ties break to HIGHER quality (min_cost’s comparator, verbatim)', () => {
    const lo = pt('h-lo', 0.85, 1.0, 500);
    const hi = pt('h-hi', 0.92, 1.0, 500);
    expect(selectPoint(compound(0.8, 1000), frontier([lo, hi]))?.strategyHash).toBe('h-hi');
  });

  it('infeasible on latency → null (the caller decides the fallback, not the selector)', () => {
    expect(selectPoint(compound(0.8, 100), frontier(POINTS))).toBeNull();
  });

  it('infeasible on quality → null', () => {
    expect(selectPoint(compound(0.99, 100_000), frontier(POINTS))).toBeNull();
  });

  it('empty frontier → null', () => {
    expect(selectPoint(compound(0.8, 1500), frontier([]))).toBeNull();
  });
});

describe('fastestQualityQualifyingPoint — the latency-infeasible fallback', () => {
  it('serves the FASTEST point that still meets the quality floor', () => {
    // Owner rule: violate the customer-observable dimension (latency), never
    // the customer-invisible one (quality).
    const chosen = fastestQualityQualifyingPoint(POINTS, 0.8);
    expect(chosen?.strategyHash).toBe('h-strong'); // 1200ms beats the cascade's 2100
    expect(chosen!.quality).toBeGreaterThanOrEqual(0.8);
  });

  it('never returns a point below the floor, even when it is far faster', () => {
    // CHEAP is 300ms — four times faster — and must still be refused.
    expect(fastestQualityQualifyingPoint(POINTS, 0.8)?.strategyHash).not.toBe('h-cheap');
  });

  it('null when nothing clears the floor', () => {
    expect(fastestQualityQualifyingPoint(POINTS, 0.99)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// resolveLatency: serving-grade evidence
// ---------------------------------------------------------------------------

describe('resolveLatency', () => {
  const serving = (hash: string, p95Ms: number, n: number) => ({ strategyHash: hash, p95Ms, n });

  it('substitutes the serving p95 at n >= the minimum and marks it non-provisional', () => {
    const r = resolveLatency(POINTS, [serving('h-cascade', 3400, SERVING_LATENCY_MIN_SAMPLES)], 60);
    expect(r.points.find((p) => p.strategyHash === 'h-cascade')!.latencyP95).toBe(3400);
    expect(r.evidence['h-cascade']).toMatchObject({
      source: 'serving',
      p95Ms: 3400,
      provisional: false,
      windowMin: 60,
      span: 'end-to-end',
    });
  });

  it('keeps the harness number one sample BELOW the minimum, flagged provisional', () => {
    const r = resolveLatency(
      POINTS,
      [serving('h-cascade', 3400, SERVING_LATENCY_MIN_SAMPLES - 1)],
      60,
    );
    expect(r.points.find((p) => p.strategyHash === 'h-cascade')!.latencyP95).toBe(2100);
    expect(r.evidence['h-cascade']).toMatchObject({
      source: 'harness',
      p95Ms: 2100,
      provisional: true,
      span: 'strategy-only',
    });
  });

  it('labels the two sources with DIFFERENT spans — they are different clocks', () => {
    const r = resolveLatency(POINTS, [serving('h-strong', 1500, 100)], 60);
    expect(r.evidence['h-strong']!.span).toBe('end-to-end'); // server handling time
    expect(r.evidence['h-cheap']!.span).toBe('strategy-only'); // harness, scorer excluded
  });

  it('allProvisional is true only when NO point resolved to serving evidence', () => {
    expect(resolveLatency(POINTS, [], 60).allProvisional).toBe(true);
    expect(resolveLatency(POINTS, [serving('h-cheap', 250, 99)], 60).allProvisional).toBe(false);
  });

  it('does NOT mutate the input points (the frontier is cached and shared)', () => {
    const before = POINTS.map((p) => p.latencyP95);
    resolveLatency(POINTS, [serving('h-cascade', 9999, 500)], 60);
    expect(POINTS.map((p) => p.latencyP95)).toEqual(before);
  });

  it('a substituted p95 can FLIP the selection — the point of binding serving-grade', () => {
    // Harness says the cascade is 2100ms and a 2500ms bound admits it. Real
    // traffic says 3400ms, so under a serving-grade bind it is excluded.
    expect(selectPoint(compound(0.8, 2500), frontier(POINTS))?.strategyHash).toBe('h-cascade');
    const r = resolveLatency(POINTS, [serving('h-cascade', 3400, 120)], 60);
    expect(selectPoint(compound(0.8, 2500), frontier(r.points))?.strategyHash).toBe('h-strong');
  });
});

// ---------------------------------------------------------------------------
// latencyPremium
// ---------------------------------------------------------------------------

describe('latencyPremium', () => {
  it('reports the M1b trade: bound at 1500ms prunes the cascade, ~64% dearer', () => {
    const p = latencyPremium(compound(0.8, 1500), POINTS);
    expect(p.binding).toBe('latency');
    expect(p.selected?.strategyHash).toBe('h-strong');
    expect(p.unbounded?.strategyHash).toBe('h-cascade');
    expect(p.deltaCostPer1K).toBeCloseTo(1.6, 10); // 2.5 − 0.9
    expect(p.savingsPct).toBeCloseTo(1.6 / 2.5, 10); // 0.64
    expect(p.relaxLatencyToMs).toBeGreaterThanOrEqual(2100);
  });

  it("the relax target ADMITS the point it came from (epsilon, not a bare copy)", () => {
    const p = latencyPremium(compound(0.8, 1500), POINTS);
    const relaxed = compound(0.8, p.relaxLatencyToMs!);
    expect(selectPoint(relaxed, frontier(POINTS))?.strategyHash).toBe('h-cascade');
  });

  it("selected EQUALS selectPoint's answer — one selector, asserted not assumed", () => {
    for (const [floor, bound] of [
      [0.8, 1500],
      [0.8, 2500],
      [0.7, 400],
      [0.5, 100_000],
      [0.9, 1300],
    ] as const) {
      const policy = compound(floor, bound);
      expect(latencyPremium(policy, POINTS).selected?.strategyHash).toBe(
        selectPoint(policy, frontier(POINTS))?.strategyHash,
      );
    }
  });

  it('binding is "none" when the bound is not costing anything', () => {
    const p = latencyPremium(compound(0.8, 5000), POINTS);
    expect(p.binding).toBe('none');
    expect(p.deltaCostPer1K).toBe(0);
    expect(p.savingsPct).toBe(0);
    expect(p.relaxLatencyToMs).toBeNull();
  });

  it('NEVER blames latency for a quality-floor problem', () => {
    const p = latencyPremium(compound(0.99, 100), POINTS);
    expect(p.binding).toBe('quality');
    expect(p.relaxLatencyToMs).toBeNull(); // relaxing latency would not help
    expect(p.savingsPct).toBe(0);
  });

  it('surfaces relaxations in BOTH directions when the bound admits nothing qualifying', () => {
    // Bound 400ms: only CHEAP (0.72) is fast enough, and it is below the floor.
    const p = latencyPremium(compound(0.8, 400), POINTS);
    expect(p.binding).toBe('latency');
    expect(p.selected).toBeNull();
    // Direction 1 — relax latency to admit the cheapest qualifying point.
    expect(p.relaxLatencyToMs).toBeGreaterThanOrEqual(2100);
    // Direction 2 — relax quality to what IS reachable inside the bound.
    expect(p.relaxQualityToFloor).toBeCloseTo(0.72, 10);
    // Both relaxations are real: each makes the policy feasible.
    expect(selectPoint(compound(0.8, p.relaxLatencyToMs!), frontier(POINTS))).not.toBeNull();
    expect(selectPoint(compound(p.relaxQualityToFloor!, 400), frontier(POINTS))).not.toBeNull();
  });

  it('relaxQualityToFloor is null when the bound admits NO point at all', () => {
    const p = latencyPremium(compound(0.8, 10), POINTS);
    expect(p.relaxQualityToFloor).toBeNull(); // relaxing quality cannot help
  });

  it('is inert for non-compound policies and empty frontiers', () => {
    expect(latencyPremium({ type: 'min_cost', qualityFloor: 0.8 }, POINTS).binding).toBe('none');
    expect(latencyPremium({ type: 'latency_bound', p95Ms: 500 }, POINTS).binding).toBe('none');
    expect(latencyPremium(compound(0.8, 1500), []).binding).toBe('none');
  });

  it('computes against RESOLVED latency, so serving evidence changes the premium', () => {
    const r = resolveLatency(POINTS, [{ strategyHash: 'h-cascade', p95Ms: 3400, n: 120 }], 60);
    // Under a 2500ms bound the harness numbers show no premium (the cascade
    // fits); the serving numbers show one (it does not).
    expect(latencyPremium(compound(0.8, 2500), POINTS).binding).toBe('none');
    expect(latencyPremium(compound(0.8, 2500), r.points).binding).toBe('latency');
  });
});

// ---------------------------------------------------------------------------
// schema
// ---------------------------------------------------------------------------

describe('PolicySchema — compound member', () => {
  it('accepts a well-formed compound policy and preserves both constraints', () => {
    const parsed = PolicySchema.parse({ type: 'compound', qualityFloor: 0.8, p95Ms: 1500 });
    expect(parsed).toMatchObject({ type: 'compound', qualityFloor: 0.8, p95Ms: 1500 });
  });

  it('rejects a compound policy missing EITHER constraint', () => {
    expect(() => PolicySchema.parse({ type: 'compound', qualityFloor: 0.8 })).toThrow();
    expect(() => PolicySchema.parse({ type: 'compound', p95Ms: 1500 })).toThrow();
  });

  it('rejects out-of-range constraints', () => {
    expect(() => PolicySchema.parse({ type: 'compound', qualityFloor: 1.5, p95Ms: 1500 })).toThrow();
    expect(() => PolicySchema.parse({ type: 'compound', qualityFloor: 0.8, p95Ms: 0 })).toThrow();
    expect(() => PolicySchema.parse({ type: 'compound', qualityFloor: 0.8, p95Ms: -1 })).toThrow();
  });

  it('is a DISTINCT type, so every audit surface can tell it apart from min_cost', () => {
    // The reason this is a union member and not an optional p95Ms field:
    // policy.type is what lands in request_logs.policy_type, the trace
    // `policy=` field and incidents.detail.
    const parsed = PolicySchema.parse({ type: 'compound', qualityFloor: 0.8, p95Ms: 1500 });
    expect(parsed.type).toBe('compound');
    expect(PolicySchema.parse({ type: 'min_cost', qualityFloor: 0.8 }).type).toBe('min_cost');
  });
});
