// SHADOW → ORG EVIDENCE (2026-09-01): the pure aggregation. The gate is the
// first decision surface to consume the Jeffreys intervals the evidence
// layer always carried — every branch of the qualification ladder is pinned
// here, and every rejection carries honest words.
import { describe, expect, it } from 'vitest';
import {
  SHADOW_QUALIFY_MIN_N,
  clusterShadowEvidence,
  type ShadowEvidenceInputs,
  type ShadowRowLike,
} from './shadow-evidence.js';

const SERVING = 'hash-serving';
const CHALLENGER = 'hash-challenger';

function row(over: Partial<ShadowRowLike> = {}): ShadowRowLike {
  return {
    clusterId: 'code-gen',
    candidateHash: CHALLENGER,
    candidateModel: 'mock-mid',
    quality: 0.95,
    costUsd: 0.0001, // → $0.1 / 1K
    latencyMs: 400,
    ...over,
  };
}

function inputs(over: Partial<ShadowEvidenceInputs> = {}): ShadowEvidenceInputs {
  return {
    shadowRows: Array.from({ length: SHADOW_QUALIFY_MIN_N + 5 }, () => row()),
    primaryQualities: Array.from({ length: 5 }, () => ({
      clusterId: 'code-gen',
      strategyHash: SERVING,
      quality: 0.8,
    })),
    servedCosts: [{ clusterId: 'code-gen', meanCostUsd: 0.001, requests: 40 }], // → $1 / 1K
    ...over,
  };
}

const args = { clusterId: 'code-gen', servingHash: SERVING, clusterFloor: 0.7 };

describe('clusterShadowEvidence', () => {
  it('an empty window is an absent block, never zeros', () => {
    expect(clusterShadowEvidence({ shadowRows: [], primaryQualities: [], servedCosts: [] }, args)).toBeNull();
  });

  it('a well-evidenced cheaper challenger QUALIFIES — Jeffreys lower bound vs the floor, measured cost vs measured cost', () => {
    const ev = clusterShadowEvidence(inputs(), args)!;
    expect(ev.instrument).toBe('serve-judge');
    expect(ev.servingMeasuredCostPer1K).toBeCloseTo(1.0, 6);
    expect(ev.servingObserved).toMatchObject({ n: 5 });
    expect(ev.challengers).toHaveLength(1);
    const c = ev.challengers[0]!;
    expect(c.strategyHash).toBe(CHALLENGER);
    expect(c.n).toBe(SHADOW_QUALIFY_MIN_N + 5);
    expect(c.costPer1K).toBeCloseTo(0.1, 6);
    // interval sanity: lo ≤ mean ≤ hi, and the gate read the LOWER bound
    expect(c.qualityCi[0]).toBeLessThanOrEqual(c.quality);
    expect(c.qualityCi[1]).toBeGreaterThanOrEqual(c.quality);
    expect(c.qualityCi[0]).toBeGreaterThanOrEqual(0.7);
    expect(c.qualifies).toBe(true);
    expect(c.reason).toContain('floor');
    expect(c.reason).toContain('of your requests');
  });

  it('too few scored samples: rejected by count, and unscored rows never count as scored', () => {
    const scored = Array.from({ length: 10 }, () => row());
    const unscored = Array.from({ length: 40 }, () => row({ quality: null }));
    const ev = clusterShadowEvidence(inputs({ shadowRows: [...scored, ...unscored] }), args)!;
    const c = ev.challengers[0]!;
    expect(c.n).toBe(10); // scored only
    expect(c.samples).toBe(50); // cost/latency evidence counts everything
    expect(c.qualifies).toBe(false);
    expect(c.reason).toBe(`10 of ${SHADOW_QUALIFY_MIN_N} scored samples`);
  });

  it('a high floor rejects on the LOWER bound even when the mean clears it', () => {
    // mean 0.95; the Jeffreys lower bound sits below it — a floor between
    // the two must reject (point-estimate gating would have passed it).
    const ev = clusterShadowEvidence(inputs(), { ...args, clusterFloor: 0.94 })!;
    const c = ev.challengers[0]!;
    expect(c.quality).toBeCloseTo(0.95, 6);
    expect(c.qualityCi[0]).toBeLessThan(0.94);
    expect(c.qualifies).toBe(false);
    expect(c.reason).toContain('lower bound');
    expect(c.reason).toContain('below the 0.94 floor');
  });

  it('no floor dimension (max_quality): qualification is undefined and says so', () => {
    const ev = clusterShadowEvidence(inputs(), { ...args, clusterFloor: null })!;
    expect(ev.challengers[0]!.qualifies).toBe(false);
    expect(ev.challengers[0]!.reason).toContain('no quality floor');
  });

  it('no measured serving cost: never qualifies against an absent comparator', () => {
    const ev = clusterShadowEvidence(inputs({ servedCosts: [] }), args)!;
    expect(ev.servingMeasuredCostPer1K).toBeNull();
    expect(ev.challengers[0]!.qualifies).toBe(false);
    expect(ev.challengers[0]!.reason).toContain('no measured serving cost');
  });

  it('not cheaper than the measured serving cost: rejected with both numbers named', () => {
    const ev = clusterShadowEvidence(
      inputs({ servedCosts: [{ clusterId: 'code-gen', meanCostUsd: 0.00005, requests: 40 }] }),
      args,
    )!;
    const c = ev.challengers[0]!;
    expect(c.qualifies).toBe(false);
    expect(c.reason).toContain('not cheaper');
  });

  it('the serving strategy is never its own challenger, and other clusters never leak in', () => {
    const ev = clusterShadowEvidence(
      inputs({
        shadowRows: [
          ...inputs().shadowRows,
          row({ candidateHash: SERVING, candidateModel: 'mock-cheap' }),
          row({ clusterId: 'classification', candidateHash: 'hash-elsewhere' }),
        ],
      }),
      args,
    )!;
    expect(ev.challengers.map((c) => c.strategyHash)).toEqual([CHALLENGER]);
  });

  it('qualified challengers sort first, then cheapest', () => {
    const expensive = Array.from({ length: SHADOW_QUALIFY_MIN_N }, () =>
      row({ candidateHash: 'hash-pricey', candidateModel: 'mock-frontier', costUsd: 0.01 }),
    );
    const ev = clusterShadowEvidence(inputs({ shadowRows: [...inputs().shadowRows, ...expensive] }), args)!;
    expect(ev.challengers.map((c) => [c.strategyHash, c.qualifies])).toEqual([
      [CHALLENGER, true],
      ['hash-pricey', false], // $10/1K vs serving's measured $1/1K — not cheaper
    ]);
  });
});
