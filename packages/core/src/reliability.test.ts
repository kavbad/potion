// C5: reliability as an axis Potion can honestly carry.
import { describe, expect, it } from 'vitest';
import { costPerSuccess, evaluateReliabilityFloor } from './reliability.js';
import { GuaranteeConfigSchema } from './schemas.js';

describe('cost per successful task', () => {
  it('reorders the ranking: a cheap unreliable run can cost more per SUCCESS', () => {
    expect(costPerSuccess(0.02, 0.4)!).toBeGreaterThan(costPerSuccess(0.04, 0.98)!);
  });

  it("the review's own example does NOT cross over, and the crossover is where arithmetic puts it", () => {
    // The review illustrates the idea with "$0.02 at 70% is often worse than
    // $0.04 at 98%". Per success that is $0.0286 against $0.0408 — the cheap
    // flaky option still wins. The PRINCIPLE is right and the numbers do not
    // show it, which matters because this is the sentence a customer would be
    // shown. The crossover for these prices is a success rate of 0.49.
    expect(costPerSuccess(0.02, 0.7)!).toBeLessThan(costPerSuccess(0.04, 0.98)!);
    const dearSolid = costPerSuccess(0.04, 0.98)!;
    expect(costPerSuccess(0.02, 0.49)!).toBeCloseTo(dearSolid, 2);
    expect(costPerSuccess(0.02, 0.48)!).toBeGreaterThan(dearSolid);
  });

  it('bills against the LOWER bound — the rate we can prove, not the one we hope for', () => {
    // Same observed rate, different evidence: fewer samples, wider interval,
    // lower bound further down, so the honest per-success cost is higher.
    const thin = costPerSuccess(0.03, 0.6)!;
    const thick = costPerSuccess(0.03, 0.9)!;
    expect(thin).toBeGreaterThan(thick);
  });

  it('returns null rather than a number that looks like knowledge', () => {
    expect(costPerSuccess(0.03, null)).toBeNull();
    expect(costPerSuccess(0.03, 0)).toBeNull();
  });
});

describe('the success floor uses the breach rigor the quality guarantee already uses', () => {
  const at = (ci: [number, number], n = 50, floor = 0.98) =>
    evaluateReliabilityFloor({ successCi: ci, rate: (ci[0] + ci[1]) / 2, n, floor, minSamples: 5 });

  it('breaches only when the WHOLE interval is below the floor', () => {
    expect(at([0.80, 0.91]).verdict).toBe('breached');
  });

  it('an interval that straddles the floor is reported, never an incident', () => {
    const r = at([0.95, 0.995]);
    expect(r.verdict).toBe('not-significant');
    expect(r.reason).toContain('straddles');
    // This is the line that keeps a safety mechanism from becoming the outage:
    // acting on the point estimate here would roll back on sampling noise.
    expect(r.rate!).toBeLessThan(0.98);
  });

  it('clears only when the lower bound is at or above the floor', () => {
    expect(at([0.985, 0.999]).verdict).toBe('ok');
  });

  it('too little evidence is its own verdict, not a pass and not a breach', () => {
    expect(at([0.1, 0.2], 3).verdict).toBe('insufficient');
    expect(evaluateReliabilityFloor({ successCi: null, rate: null, n: 0, floor: 0.98, minSamples: 5 }).verdict).toBe('insufficient');
  });

  it('is optional on the guarantee — a policy without it parses and behaves as before', () => {
    const base = { minQuality: 0.8, windowMin: 60, sampleRate: 0.1, action: 'alert' as const };
    expect(GuaranteeConfigSchema.parse(base).minSuccessRate).toBeUndefined();
    expect(GuaranteeConfigSchema.parse({ ...base, minSuccessRate: 0.98 }).minSuccessRate).toBe(0.98);
    expect(() => GuaranteeConfigSchema.parse({ ...base, minSuccessRate: 1.5 })).toThrow();
  });
});
