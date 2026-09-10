// The promotion refusals — the first tests these have ever had.
//
//   pnpm exec vitest run scripts
import { describe, expect, it } from 'vitest';
import {
  PRICES_OVERRIDE_ENV,
  PROFILE_OVERRIDE_ENV,
  tokenProfileCoverage,
  tokenProfileRefusal,
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
    // Built by OMITTING the key rather than setting it undefined: under
    // exactOptionalPropertyTypes those are different types, and only the
    // omission is the shape a real file with no providerMode field has.
    const noClaim: PromotablePoint = { strategyHash: 'nomode', quality: 0.9, evidence: { runIds: ['r'] } };
    expect(notLiveRefusal(doc({ points: [noClaim] }))).toContain('not provider_mode=live');
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

describe('tokenProfileRefusal — a promotion may not drop the token profiles', () => {
  // The real v5 → v6 promotion, with the profiles measured off production.
  const v5 = (): ServingFrontier => ({
    version: 5,
    pricesVersion: LIVE,
    points: [
      pt({ strategyHash: 'solar', evidence: { runIds: ['r'], tokens: { outputMean: 24.5, inputMean: 104.1 } } }),
      pt({ strategyHash: 'ling', evidence: { runIds: ['r'], tokens: { outputMean: 169.24, inputMean: 73.96 } } }),
      pt({ strategyHash: 'deepseek', evidence: { runIds: ['r'], tokens: { outputMean: 89.68, inputMean: 123.1 } } }),
      pt({ strategyHash: 'gemini37', evidence: { runIds: ['r'], tokens: { outputMean: 135.4, inputMean: 53.2 } } }),
    ],
  });
  const v6Points = ['ling', 'nemotron', 'inklingS', 'geminiF', 'inkling', 'gemini37'].map((hash) =>
    pt({ strategyHash: hash, evidence: { runIds: ['r2'] } }),
  );

  it('counts coverage, and a point without outputMean does not count', () => {
    expect(tokenProfileCoverage(v5().points)).toBe(4);
    expect(tokenProfileCoverage(v6Points)).toBe(0);
    expect(tokenProfileCoverage([pt({ evidence: { runIds: ['r'], tokens: {} } })])).toBe(0);
  });

  it('REFUSES the 2026-09-08 v6 promotion, and says what it turns off', () => {
    const r = tokenProfileRefusal(v5(), doc({ points: v6Points }), {});
    expect(r, 'a frontier with no token profiles must not replace one that has them').not.toBeNull();
    expect(r).toContain('all 4 points');
    expect(r).toContain('0/6');
    expect(r).toContain('output-budget');
  });

  it('refuses PARTIAL coverage too — one missing profile disables it for the cluster', () => {
    const partial = [...v5().points.slice(0, 3), pt({ strategyHash: 'new', evidence: { runIds: ['r'] } })];
    expect(tokenProfileRefusal(v5(), doc({ points: partial }), {})).toContain('3/4');
  });

  it('allows a promotion that keeps full coverage', () => {
    expect(tokenProfileRefusal(v5(), doc({ points: v5().points }), {})).toBeNull();
  });

  it('GAINING profiles is never refused — the guard is one-directional', () => {
    const bare: ServingFrontier = { version: 4, pricesVersion: LIVE, points: v6Points };
    expect(tokenProfileRefusal(bare, doc({ points: v5().points }), {})).toBeNull();
  });

  it('a target that never had full coverage cannot lose it', () => {
    const partialTarget: ServingFrontier = {
      version: 4,
      pricesVersion: LIVE,
      points: [v5().points[0]!, pt({ strategyHash: 'x', evidence: { runIds: ['r'] } })],
    };
    expect(tokenProfileRefusal(partialTarget, doc({ points: v6Points }), {})).toBeNull();
  });

  it('the override releases it, and only the exact value does', () => {
    const d = doc({ points: v6Points });
    expect(tokenProfileRefusal(v5(), d, { [PROFILE_OVERRIDE_ENV]: '1' })).toBeNull();
    expect(tokenProfileRefusal(v5(), d, { [PROFILE_OVERRIDE_ENV]: 'true' })).not.toBeNull();
  });

  it('a first frontier has nothing to lose', () => {
    expect(tokenProfileRefusal(null, doc({ points: v6Points }), {})).toBeNull();
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
