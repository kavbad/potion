import { describe, expect, it } from 'vitest';
import { replayCluster, replayConfidenceGatedCascade, replayConsensusOrEscalate, replayDigestLine, replayOracle, replayVote3, summarizeModels, type ClusterMatrix } from './replay.js';

// A synthetic cluster: 10 items. CHEAP is right on items 0–5 and KNOWS it
// (confidence high) and wrong on 6–9 with low confidence — a calibrated cheap
// model. STRONG is right on 0–8, wrong on 9. MID is right on 0–3 and 6–7.
function matrix(): ClusterMatrix {
  const m: ClusterMatrix = new Map();
  for (let i = 0; i < 10; i++) {
    const row = new Map();
    const cheapRight = i <= 5;
    row.set('cheap', { quality: cheapRight ? 1 : 0, costUsd: 0.001, confidence: cheapRight ? 0.92 : 0.55 });
    row.set('mid', { quality: i <= 3 || i === 6 || i === 7 ? 1 : 0, costUsd: 0.004, confidence: 0.8 });
    row.set('strong', { quality: i <= 8 ? 1 : 0, costUsd: 0.05, confidence: 0.9 });
    m.set(`it-${i}`, row);
  }
  return m;
}

describe('replay engine', () => {
  const m = matrix();
  const singles = summarizeModels(m);

  it('summarizes singles by quality then cost', () => {
    expect(singles.map((s) => s.model)).toEqual(['strong', 'cheap', 'mid']);
    expect(singles[0]!.meanQuality).toBeCloseTo(0.9);
    expect(singles[1]!.confidenceCoverage).toBe(1);
  });

  it('oracle is the ceiling: right whenever either is right, pays for both', () => {
    const o = replayOracle(m, 'cheap', 'strong', singles)!;
    expect(o.meanQuality).toBeCloseTo(0.9); // strong covers everything cheap does here
    expect(o.meanCostUsd).toBeCloseTo(0.051);
    const o2 = replayOracle(m, 'mid', 'strong', singles)!;
    expect(o2.meanQuality).toBeCloseTo(0.9);
  });

  it('a calibrated cheap model makes a confidence-gated cascade DOMINATE the strong single', () => {
    const g = replayConfidenceGatedCascade(m, 'cheap', 'strong', singles, 0.9)!;
    // τ between 0.55 and 0.92 escalates exactly the 4 wrong items → quality 0.9 at a fraction of strong's cost
    expect(g.meanQuality).toBeCloseTo(0.9);
    expect(g.meanCostUsd).toBeLessThan(0.03);
    expect(g.cheaperAndAsGood).toBe(true);
    expect(g.frontierCandidate).toBe(true);
    expect(g.params!.escalationRate).toBeCloseTo(0.4);
    expect(g.realizedOfOracle).toBe(0); // oracle gap is zero here (strong already 0.9) — captured fraction is defined as 0
  });

  it('consensus-or-escalate is replayed conservatively and reports its escalation rate', () => {
    const r = replayConsensusOrEscalate(m, 'cheap', 'mid', 'strong', singles)!;
    expect(r.params!.escalationRate).toBeGreaterThan(0);
    expect(r.note).toMatch(/conservative/);
    expect(r.meanQuality).toBeGreaterThanOrEqual(0.5);
  });

  it('vote of three pays for all three', () => {
    const v = replayVote3(m, ['cheap', 'mid', 'strong'], singles)!;
    expect(v.meanCostUsd).toBeCloseTo(0.055);
    expect(v.n).toBe(10);
  });

  it('replayCluster ranks dominating recipes first and the digest names the headroom', () => {
    const r = replayCluster('synthetic', m, { minItems: 2 });
    expect(r.recipes[0]!.cheaperAndAsGood).toBe(true);
    expect(r.recipes[0]!.kind).not.toBe('oracle');
    const line = replayDigestLine(r);
    expect(line).toMatch(/^synthetic: /);
    expect(line).toMatch(/realizable: confidence-gated-cascade cheap→strong/);
  });

  it('skips the gated cascade when the cheap model carried no confidence on most items', () => {
    const blind: ClusterMatrix = new Map([...m].map(([k, row]) => [k, new Map([...row].map(([mm, c]) => [mm, mm === 'cheap' ? { quality: c.quality, costUsd: c.costUsd } : c]))]));
    expect(replayConfidenceGatedCascade(blind, 'cheap', 'strong', summarizeModels(blind))).toBeNull();
  });
});
