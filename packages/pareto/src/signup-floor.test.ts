// The signup floor (2026-09-18): the highest bar every measured kind of work
// can prove, never the 0.95 constant no frontier could honour.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FrontierPoint } from '@potion/core';
import { createDb, migrate, type DbHandle } from '@potion/db';
import { saveFrontier } from './persistence.js';
import { DEFAULT_ORG_POLICY, SIGNUP_FLOOR_MIN, isUnchosenSignupPolicy, signupPolicyFor, signupQualityFloor } from './serving.js';

function point(clusterId: string, model: string, quality: number, half: number, costPer1K = 1): FrontierPoint {
  return {
    clusterId, strategyHash: `h-${clusterId}-${model}`, strategyConfig: { type: 'single', model }, quality, costPer1K, latencyP95: 300, providerMode: 'mock',
    evidence: { cacheKeys: [], runIds: [], n: 20, qualityCi95: half },
  };
}

describe('signupQualityFloor', () => {
  let handle: DbHandle;
  beforeAll(async () => {
    handle = await createDb('pglite://');
    await migrate(handle.db);
  });
  afterAll(async () => {
    await handle.close();
  });

  it('with nothing measured the ceiling holds', async () => {
    const r = await signupQualityFloor(handle.db, 'org-fresh');
    expect(r.floor).toBe(0.95);
    expect(r.clusters).toBe(0);
    expect(r.limiting).toBeNull();
  });

  it('is the minimum over kinds of work of the highest PROVABLE quality, floored to 2dp', async () => {
    // classification proves 0.97 (0.99 − 0.02); agentic proves 0.8226 → 0.82.
    await saveFrontier(handle.db, 'classification', [point('classification', 'cheap', 0.9, 0.05, 0.2), point('classification', 'best', 0.99, 0.02, 2)], 'manual', 'p1');
    await saveFrontier(handle.db, 'agentic-tool-use', [point('agentic-tool-use', 'solar', 0.8526, 0.03)], 'manual', 'p1');
    const r = await signupQualityFloor(handle.db, 'org-fresh');
    expect(r.floor).toBe(0.82);
    expect(r.limiting).toEqual({ clusterId: 'agentic-tool-use', highestProvable: expect.closeTo(0.8226, 4) });
    expect(r.clusters).toBe(2);
    expect(await signupPolicyFor(handle.db, 'org-fresh')).toEqual({ type: 'min_cost', qualityFloor: 0.82 });
  });

  it('a kind of work proving less than SIGNUP_FLOOR_MIN is excluded, not imposed on everyone', async () => {
    await saveFrontier(handle.db, 'creative', [point('creative', 'weak', 0.6, 0.1)], 'manual', 'p1');
    const r = await signupQualityFloor(handle.db, 'org-fresh');
    expect(r.floor).toBe(0.82);
    expect(r.excluded).toEqual([{ clusterId: 'creative', highestProvable: expect.closeTo(0.5, 6) }]);
    expect(SIGNUP_FLOOR_MIN).toBe(0.75);
  });
});

describe('isUnchosenSignupPolicy', () => {
  it("recognises the mint's shape at today's floor and at the retired constant, nothing else", () => {
    expect(isUnchosenSignupPolicy('default', { type: 'min_cost', qualityFloor: 0.82 }, 0.82)).toBe(true);
    expect(isUnchosenSignupPolicy('default', DEFAULT_ORG_POLICY, 0.82)).toBe(true);
    expect(isUnchosenSignupPolicy('default', { type: 'min_cost', qualityFloor: 0.9 }, 0.82)).toBe(false);
    expect(isUnchosenSignupPolicy('default', { type: 'min_cost', qualityFloor: 0.82, clusterFloors: { creative: 0.8 } }, 0.82)).toBe(false);
    expect(isUnchosenSignupPolicy('your bar', { type: 'min_cost', qualityFloor: 0.82 }, 0.82)).toBe(false);
    expect(isUnchosenSignupPolicy('default', { type: 'max_quality', costCeilingPer1K: 1 } as never, 0.82)).toBe(false);
  });
});
