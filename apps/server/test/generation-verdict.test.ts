// G2 rung 4c — the promotion gate's rule, asserted rather than discovered.
//
// The gate refuses ONLY what the evidence condemns. These cases exist to pin
// both halves of that sentence: it must fire when the org's own traffic says
// the candidate is confidently worse, and it must stay silent when the
// evidence is thin, overlapping, or merely unflattering. A gate that fired
// on noise would train an operator to pass acceptDegradation reflexively,
// which is worse than having no gate at all.
import { describe, expect, it } from 'vitest';
import type { GenerationEvidence } from '@potion/db';
import { generationVerdict, MIN_CANARY_REQUESTS } from '../src/routing/generation-verdict.js';

const N = MIN_CANARY_REQUESTS;

/** costs/qualities repeated to a given length, with `requests` matching. */
function side(n: number, cost: number, quality?: number) {
  return {
    requests: n,
    costs: Array.from({ length: n }, () => cost),
    qualities: quality === undefined ? [] : Array.from({ length: n }, () => quality),
  };
}

const ev = (canary: ReturnType<typeof side>, control: ReturnType<typeof side>): GenerationEvidence => ({
  canary,
  control,
  since: '2026-09-04T00:00:00Z',
});

describe('the generation promotion gate', () => {
  it('thin evidence is reported, never a refusal', () => {
    const v = generationVerdict(ev(side(3, 0.01), side(3, 0.001)), 'g1');
    expect(v.sufficient).toBe(false);
    expect(v.adverse, 'a lightly-canaried generation must still be promotable').toBe(false);
    expect(v.reasons.join(' ')).toContain('not enough traffic');
    // Says so plainly, because an operator reading this is deciding.
    expect(v.reasons.join(' ')).toContain('still allowed');
  });

  it('refuses a candidate that is CONFIDENTLY more expensive', () => {
    const v = generationVerdict(ev(side(N, 0.02), side(N, 0.002)), 'g1');
    expect(v.sufficient).toBe(true);
    expect(v.adverse).toBe(true);
    expect(v.reasons.join(' ')).toContain('costs more on your own traffic');
    expect(v.cost?.canary.n).toBe(N);
  });

  it('does NOT refuse when the cost intervals overlap', () => {
    // Same distribution both sides: no finding, however the means land.
    const v = generationVerdict(ev(side(N, 0.01), side(N, 0.01)), 'g1');
    expect(v.adverse).toBe(false);
    expect(v.reasons.join(' ')).toContain('nothing in your traffic says this routing is worse');
  });

  it('a HIGHER MEAN with overlapping intervals is not a finding', () => {
    // The case that separates "confidently worse" from "worse on average",
    // and the one the identical-costs test above cannot see: spread costs
    // where the canary's mean is genuinely higher but the intervals still
    // overlap. Comparing means here would refuse a promotion on noise —
    // which is how an operator learns to pass acceptDegradation reflexively.
    const spread = (n: number, lo: number, hi: number) => ({
      requests: n,
      costs: Array.from({ length: n }, (_, i) => (i % 2 === 0 ? lo : hi)),
      qualities: [] as number[],
    });
    const canary = spread(N, 0.001, 0.021); // mean 0.011
    const control = spread(N, 0.001, 0.019); // mean 0.010
    const v = generationVerdict(ev(canary, control), 'g1');
    expect(v.cost!.canary.mean).toBeGreaterThan(v.cost!.control.mean);
    expect(v.cost!.canary.ci[0]).toBeLessThan(v.cost!.control.ci[1]); // they overlap
    expect(v.adverse, 'overlapping intervals are not evidence of harm').toBe(false);
  });

  it('CHEAPER is never adverse — that is the point of the change', () => {
    const v = generationVerdict(ev(side(N, 0.001), side(N, 0.05)), 'g1');
    expect(v.adverse).toBe(false);
  });

  it('refuses a candidate that CONFIDENTLY scores worse', () => {
    const v = generationVerdict(ev(side(N, 0.01, 0.4), side(N, 0.01, 0.95)), 'g1');
    expect(v.adverse).toBe(true);
    expect(v.reasons.join(' ')).toContain('scores worse on your own traffic');
  });

  it('quality is only judged when BOTH sides have enough scored requests', () => {
    // The sampler scores a fraction of traffic, so a canary can be well past
    // the request floor with only a handful of scores. Judging on those
    // would refuse promotions on three judge calls.
    const thinlyScored = { requests: N, costs: Array.from({ length: N }, () => 0.01), qualities: [0.1, 0.1] };
    const v = generationVerdict(ev(thinlyScored, side(N, 0.01, 0.95)), 'g1');
    expect(v.adverse, 'two scores must not condemn a generation').toBe(false);
  });

  it('a worse candidate that is also cheaper is still refused', () => {
    // Cost and quality are separate findings; being cheap does not buy the
    // right to be worse.
    const v = generationVerdict(ev(side(N, 0.001, 0.3), side(N, 0.05, 0.95)), 'g1');
    expect(v.adverse).toBe(true);
    expect(v.reasons.join(' ')).toContain('scores worse');
  });

  it('carries the numbers it judged on, so the refusal can be checked', () => {
    const v = generationVerdict(ev(side(N, 0.02), side(N, 0.002)), 'g1');
    expect(v.canaryRequests).toBe(N);
    expect(v.controlRequests).toBe(N);
    expect(v.cost!.canary.mean).toBeCloseTo(0.02, 6);
    expect(v.cost!.control.mean).toBeCloseTo(0.002, 6);
    expect(v.since).toBe('2026-09-04T00:00:00Z');
  });

  it('no traffic at all is insufficient, not adverse', () => {
    const v = generationVerdict(ev(side(0, 0), side(0, 0)), 'g1');
    expect(v.sufficient).toBe(false);
    expect(v.adverse).toBe(false);
    expect(v.cost).toBeNull();
  });
});
