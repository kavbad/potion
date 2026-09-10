// The promotion refusals — the first tests these have ever had.
//
//   pnpm exec vitest run scripts
import { describe, expect, it } from 'vitest';
import {
  PRICES_OVERRIDE_ENV,
  evidenceSignature,
  identicalEvidenceRefusal,
  notLiveRefusal,
  pricesBasisRefusal,
  promotionRefusal,
  type PromotablePoint,
  type PromotionDoc,
  type ServingFrontier,
} from './promote-frontier-guards.js';

const AUGUST = '2026-08-04-or2+tranche-2026-08-19';
const LIVE = '2026-09-02-or3+tranche-2026-09-01+r8f21c0ad3e';

const pt = (over: Partial<PromotablePoint> = {}): PromotablePoint => ({
  strategyHash: 'a'.repeat(16),
  providerMode: 'live',
  quality: 0.9,
  evidence: { runIds: ['run-1'] },
  ...over,
});

const doc = (over: Partial<PromotionDoc> = {}): PromotionDoc => ({
  clusterId: 'multi-step-reasoning',
  instrument: 'default',
  pricesVersion: LIVE,
  points: [pt()],
  ...over,
});

const serving = (over: Partial<ServingFrontier> = {}): ServingFrontier => ({
  version: 5,
  pricesVersion: LIVE,
  points: [pt()],
  ...over,
});

describe('notLiveRefusal — simulated evidence never promotes', () => {
  it('allows an all-live point set', () => {
    expect(notLiveRefusal(doc())).toBeNull();
  });

  it('refuses, and NAMES the offending hashes and the count', () => {
    const r = notLiveRefusal(
      doc({ points: [pt(), pt({ strategyHash: 'bbbbbbbbcccc', providerMode: 'mock' })] }),
    );
    expect(r).toContain('1/2 points are not provider_mode=live');
    expect(r).toContain('bbbbbbbb');
  });

  it('a MISSING providerMode is not live — the field is a claim, and its absence is not one', () => {
    expect(notLiveRefusal(doc({ points: [pt({ providerMode: undefined })] }))).toContain('not provider_mode=live');
  });
});

describe('identicalEvidenceRefusal — a re-run must not mint a no-op version', () => {
  it('refuses a byte-identical re-import', () => {
    expect(identicalEvidenceRefusal(serving(), doc())).toContain('identical points AND evidence');
  });

  it('ALLOWS a genuine re-measurement of the same strategies — the case a hash-set check would refuse', () => {
    const remeasured = doc({ points: [pt({ quality: 0.94, evidence: { runIds: ['run-2'] } })] });
    expect(identicalEvidenceRefusal(serving(), remeasured)).toBeNull();
  });

  it('is order-independent — the same evidence in a different order is still the same evidence', () => {
    const a = [pt({ strategyHash: 'h1', evidence: { runIds: ['r2', 'r1'] } }), pt({ strategyHash: 'h2' })];
    const b = [pt({ strategyHash: 'h2' }), pt({ strategyHash: 'h1', evidence: { runIds: ['r1', 'r2'] } })];
    expect(evidenceSignature(a)).toBe(evidenceSignature(b));
  });

  it('allows anything when the target serves nothing yet', () => {
    expect(identicalEvidenceRefusal(null, doc())).toBeNull();
  });
});

describe('pricesBasisRefusal — the cost axis may not change silently', () => {
  it('allows a promotion measured at the serving basis', () => {
    expect(pricesBasisRefusal(serving(), doc(), {})).toBeNull();
  });

  // The incident, reproduced: a frontier measured in August promoted over a
  // chain serving at the current basis. Nothing refused it; the promoted point
  // served 3/10 and the chain fell back to a model 25x dearer.
  it('REFUSES the 2026-09-08 multi-step-reasoning promotion', () => {
    const r = pricesBasisRefusal(serving({ version: 5 }), doc({ pricesVersion: AUGUST }), {});
    expect(r, 'an August-priced frontier over a live chain must not promote').not.toBeNull();
    expect(r).toContain('multi-step-reasoning/default serves v5');
    expect(r).toContain(AUGUST);
    expect(r).toContain(LIVE);
  });

  it('refuses in BOTH directions — a newer basis is still a changed axis', () => {
    expect(pricesBasisRefusal(serving({ pricesVersion: AUGUST }), doc({ pricesVersion: LIVE }), {})).not.toBeNull();
  });

  it('the override releases it, and only the exact value does', () => {
    const older = doc({ pricesVersion: AUGUST });
    expect(pricesBasisRefusal(serving(), older, { [PRICES_OVERRIDE_ENV]: '1' })).toBeNull();
    for (const v of ['0', 'true', 'yes', '', undefined]) {
      expect(
        pricesBasisRefusal(serving(), older, { [PRICES_OVERRIDE_ENV]: v }),
        `"${String(v)}" must not release the refusal`,
      ).not.toBeNull();
    }
  });

  it('a FIRST frontier has no basis to contradict', () => {
    expect(pricesBasisRefusal(null, doc({ pricesVersion: AUGUST }), {})).toBeNull();
  });
});

describe('promotionRefusal — order of report', () => {
  it('reports a mock point before a prices mismatch: the worse fact first', () => {
    const bad = doc({ pricesVersion: AUGUST, points: [pt({ providerMode: 'mock' })] });
    expect(promotionRefusal(serving(), bad, {})).toContain('not provider_mode=live');
  });

  it('lets a clean promotion through', () => {
    expect(promotionRefusal(serving(), doc({ points: [pt({ quality: 0.97 })] }), {})).toBeNull();
  });
});
