// Guarantee repository + breach evaluator tests (M3, ROADMAP #22, SPEC
// §12.5, migration 0008): rolling windows, min-evidence gate, cooldown,
// rollback target precedence (previous version first, current-version
// fallback), alert mode, incident resolve, org isolation.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { strategyHash, type FrontierPoint, type Policy, type StrategyConfig } from '@potion/core';
import {
  createDb,
  DEFAULT_ORG_ID,
  evaluateGuarantee,
  equivalentPointOnPrevious,
  GUARANTEE_MIN_SAMPLES,
  hasRecentIncident,
  highestQualityPoint,
  insertIncident,
  insertQualitySample,
  latestActiveRollback,
  listIncidents,
  listQualitySamples,
  listPoliciesWithGuarantee,
  migrate,
  nextHigherQualityPoint,
  resolveIncident,
  rollingQuality,
  type DbHandle,
} from './index.js';
import { insertFrontier } from './repos/frontiers.js';
import { createOrg } from './repos/orgs.js';
import { insertPolicy } from './repos/api-keys.js';

const CFG_CHEAP = { type: 'single', model: 'mock-cheap' } as const;
const CFG_MID = { type: 'single', model: 'mock-mid' } as const;
const CFG_STRONG = { type: 'single', model: 'mock-frontier' } as const;
const H_CHEAP = strategyHash(CFG_CHEAP);
const H_MID = strategyHash(CFG_MID);
const H_STRONG = strategyHash(CFG_STRONG);

function point(config: StrategyConfig, quality: number, costPer1K: number): FrontierPoint {
  return {
    clusterId: 'code-gen',
    strategyHash: strategyHash(config),
    strategyConfig: config,
    quality,
    costPer1K,
    latencyP95: 500,
  };
}

// v1: cheap+mid; v2 (current): cheap+mid+strong (parent chain → v1).
const V1_POINTS = [point(CFG_CHEAP, 0.5, 0.1), point(CFG_MID, 0.7, 1.0)];
const V2_POINTS = [...V1_POINTS, point(CFG_STRONG, 0.9, 10.0)];

// Real-clock "now": incidents/quality_samples written without an explicit
// createdAt land on the db's real now(), so fictional dates would break the
// window/cooldown comparisons that mix defaulted + explicit timestamps.
const NOW = new Date();

let handle: DbHandle;
const db = () => handle.db;

async function seedFrontiers(): Promise<void> {
  await insertFrontier(db(), {
    id: 'fr-g-1',
    clusterId: 'code-gen',
    version: 1,
    parentId: null,
    trigger: 'manual',
    points: V1_POINTS,
    pricesVersion: '2026-08-04',
    createdAt: '2026-08-04T00:00:00.000Z',
  });
  await insertFrontier(db(), {
    id: 'fr-g-2',
    clusterId: 'code-gen',
    version: 2,
    parentId: 'fr-g-1',
    trigger: 'recompute',
    points: V2_POINTS,
    pricesVersion: '2026-08-04',
    createdAt: '2026-08-04T01:00:00.000Z',
  });
}

async function seedSamples(
  orgId: string,
  hash: string,
  qualities: number[],
  createdAt: Date = NOW,
): Promise<void> {
  for (const q of qualities) {
    await insertQualitySample(db(), { orgId, strategyHash: hash, quality: q, createdAt });
  }
}

function policyWith(guarantee: Policy['guarantee']): Policy {
  return { type: 'min_cost', qualityFloor: 0, ...(guarantee ? { guarantee } : {}) };
}

const ROLLBACK_G = { minQuality: 0.6, windowMin: 60, sampleRate: 1, action: 'rollback' as const };
const ALERT_G = { ...ROLLBACK_G, action: 'alert' as const };

beforeEach(async () => {
  handle = await createDb();
  await migrate(handle.db);
});

afterEach(async () => {
  await handle.close();
});

describe('quality_samples judge evidence (G0.1, migration 0016)', () => {
  it('round-trips scorer / judgeModel / judgeCostUsd; stub-era rows carry NULLs', async () => {
    const id = await insertQualitySample(db(), {
      orgId: DEFAULT_ORG_ID,
      requestId: 'chatcmpl-evidence-1',
      strategyHash: H_CHEAP,
      quality: 0.8,
      scorer: 'llm-judge:judge-class',
      judgeModel: 'judge-class',
      judgeCostUsd: 0.000615,
    });
    expect(id).toBeTruthy();
    const rows = await listQualitySamples(db(), DEFAULT_ORG_ID);
    const row = rows.find((r) => r.requestId === 'chatcmpl-evidence-1')!;
    expect(row.scorer).toBe('llm-judge:judge-class');
    expect(row.judgeModel).toBe('judge-class');
    expect(row.judgeCostUsd).toBeCloseTo(0.000615, 12);
    // additive: rows inserted without evidence fields (stub era) are NULL
    await insertQualitySample(db(), { orgId: DEFAULT_ORG_ID, strategyHash: H_CHEAP, quality: 0.5 });
    const legacy = (await listQualitySamples(db(), DEFAULT_ORG_ID)).find((r) => r.requestId === null)!;
    expect(legacy.scorer).toBeNull();
    expect(legacy.judgeModel).toBeNull();
    expect(legacy.judgeCostUsd).toBeNull();
  });
});

describe('rollingQuality', () => {
  it('computes the mean over the window and ignores older samples + other orgs', async () => {
    await createOrg(db(), { id: 'org_other', name: 'Other' });
    await seedSamples(DEFAULT_ORG_ID, H_CHEAP, [0.2, 0.4, 0.6]);
    // outside the 60-min window
    await seedSamples(DEFAULT_ORG_ID, H_CHEAP, [0.99], new Date(NOW.getTime() - 61 * 60_000));
    await seedSamples('org_other', H_CHEAP, [0.99]);
    await seedSamples(DEFAULT_ORG_ID, H_MID, [0.99]);
    const r = await rollingQuality(
      db(),
      { orgId: DEFAULT_ORG_ID, strategyHash: H_CHEAP, windowMin: 60 },
      NOW,
    );
    expect(r.samples).toBe(3);
    expect(r.mean).toBeCloseTo(0.4, 10);
  });

  it('returns null mean with no samples', async () => {
    const r = await rollingQuality(db(), { orgId: DEFAULT_ORG_ID, strategyHash: H_CHEAP, windowMin: 60 }, NOW);
    expect(r).toEqual({ mean: null, samples: 0 });
  });
});

describe('pure target helpers', () => {
  it('highestQualityPoint picks top quality, tie → lower cost', () => {
    expect(highestQualityPoint(V2_POINTS)?.strategyHash).toBe(H_STRONG);
    expect(highestQualityPoint([])).toBeNull();
  });

  it('equivalentPointOnPrevious re-selects the policy on the previous version', () => {
    const prev = {
      id: 'fr-g-1',
      clusterId: 'code-gen',
      version: 1,
      parentId: null,
      trigger: 'manual' as const,
      points: V1_POINTS,
      pricesVersion: 'p',
      createdAt: 'x',
    };
    // min_cost floor 0 → cheapest on v1 = cheap
    expect(equivalentPointOnPrevious(policyWith(undefined), prev)?.strategyHash).toBe(H_CHEAP);
    // infeasible policy → v1's highest-quality fallback
    const strict: Policy = { type: 'min_cost', qualityFloor: 0.95 };
    expect(equivalentPointOnPrevious(strict, prev)?.strategyHash).toBe(H_MID);
  });

  it('nextHigherQualityPoint walks up the current version; null at the top; top when unknown', () => {
    expect(nextHigherQualityPoint(V2_POINTS, H_CHEAP)?.strategyHash).toBe(H_MID);
    expect(nextHigherQualityPoint(V2_POINTS, H_MID)?.strategyHash).toBe(H_STRONG);
    expect(nextHigherQualityPoint(V2_POINTS, H_STRONG)).toBeNull();
    expect(nextHigherQualityPoint(V2_POINTS, 'not-on-frontier')?.strategyHash).toBe(H_STRONG);
    expect(nextHigherQualityPoint([], 'x')).toBeNull();
  });
});

describe('evaluateGuarantee', () => {
  it('below-threshold with ≥5 samples → rollback to the PREVIOUS version (precedence)', async () => {
    await seedFrontiers();
    // breaching strategy = mid (0.7 on both versions); previous version's
    // equivalent point for min_cost floor 0 = cheap.
    await seedSamples(DEFAULT_ORG_ID, H_MID, [0.1, 0.2, 0.3, 0.2, 0.2]);
    const result = await evaluateGuarantee(
      db(),
      { orgId: DEFAULT_ORG_ID, clusterId: 'code-gen', strategyHash: H_MID, policy: policyWith(ROLLBACK_G) },
      NOW,
    );
    expect(result.breach).toBe(true);
    expect(result.action).toBe('rollback');
    expect(result.suppressed).toBeNull();
    expect(result.rollback).toEqual({
      fromStrategy: H_MID,
      toStrategy: H_CHEAP,
      toFrontierVersion: 1,
      source: 'previous-version',
    });
    const incidents = await listIncidents(db(), DEFAULT_ORG_ID);
    expect(incidents).toHaveLength(1);
    expect(incidents[0]!.kind).toBe('rollback');
    expect(incidents[0]!.detail).toMatchObject({
      clusterId: 'code-gen',
      fromStrategy: H_MID,
      toStrategy: H_CHEAP,
      toFrontierVersion: 1,
      targetSource: 'previous-version',
      windowMin: 60,
      samples: 5,
    });
    expect(incidents[0]!.detail.rollingQuality).toBeCloseTo(0.2, 10);
  });

  it('falls back to the next-higher-quality point on the current version when no previous exists', async () => {
    // v1 only → breaching mid moves UP to strong on the same version.
    await insertFrontier(db(), {
      id: 'fr-g-1',
      clusterId: 'code-gen',
      version: 1,
      parentId: null,
      trigger: 'manual',
      points: V1_POINTS,
      pricesVersion: '2026-08-04',
      createdAt: '2026-08-04T00:00:00.000Z',
    });
    await seedSamples(DEFAULT_ORG_ID, H_CHEAP, [0.1, 0.1, 0.1, 0.1, 0.1]);
    const result = await evaluateGuarantee(
      db(),
      { orgId: DEFAULT_ORG_ID, clusterId: 'code-gen', strategyHash: H_CHEAP, policy: policyWith(ROLLBACK_G) },
      NOW,
    );
    expect(result.rollback).toEqual({
      fromStrategy: H_CHEAP,
      toStrategy: H_MID,
      toFrontierVersion: 1,
      source: 'current-version',
    });
  });

  it('<5 samples → insufficient evidence, no incident', async () => {
    await seedFrontiers();
    await seedSamples(DEFAULT_ORG_ID, H_MID, [0.0, 0.0, 0.0, 0.0]);
    const result = await evaluateGuarantee(
      db(),
      { orgId: DEFAULT_ORG_ID, clusterId: 'code-gen', strategyHash: H_MID, policy: policyWith(ROLLBACK_G) },
      NOW,
    );
    expect(result).toMatchObject({ breach: false, suppressed: 'insufficient-evidence', samples: 4 });
    expect(GUARANTEE_MIN_SAMPLES).toBe(5);
    expect(await listIncidents(db(), DEFAULT_ORG_ID)).toHaveLength(0);
  });

  it('recovery (rolling mean back above the floor) → no new incident', async () => {
    await seedFrontiers();
    await seedSamples(DEFAULT_ORG_ID, H_MID, [0.9, 0.8, 0.95, 0.85, 0.9]);
    const result = await evaluateGuarantee(
      db(),
      { orgId: DEFAULT_ORG_ID, clusterId: 'code-gen', strategyHash: H_MID, policy: policyWith(ROLLBACK_G) },
      NOW,
    );
    expect(result).toMatchObject({ breach: false, suppressed: 'no-breach' });
    expect(await listIncidents(db(), DEFAULT_ORG_ID)).toHaveLength(0);
  });

  it('cooldown suppresses a duplicate incident within the window', async () => {
    await seedFrontiers();
    await seedSamples(DEFAULT_ORG_ID, H_MID, [0.1, 0.2, 0.2, 0.2, 0.2]);
    const first = await evaluateGuarantee(
      db(),
      { orgId: DEFAULT_ORG_ID, clusterId: 'code-gen', strategyHash: H_MID, policy: policyWith(ROLLBACK_G) },
      NOW,
    );
    expect(first.incidentId).not.toBeNull();
    // same window, still breaching → suppressed by cooldown
    const second = await evaluateGuarantee(
      db(),
      { orgId: DEFAULT_ORG_ID, clusterId: 'code-gen', strategyHash: H_MID, policy: policyWith(ROLLBACK_G) },
      new Date(NOW.getTime() + 5 * 60_000),
    );
    expect(second).toMatchObject({ breach: true, action: null, suppressed: 'cooldown' });
    expect(await listIncidents(db(), DEFAULT_ORG_ID)).toHaveLength(1);
    // …but AFTER the window the cooldown has expired (samples aged out too,
    // so re-seed a fresh breaching window).
    await seedSamples(
      DEFAULT_ORG_ID,
      H_MID,
      [0.1, 0.1, 0.1, 0.1, 0.1],
      new Date(NOW.getTime() + 61 * 60_000),
    );
    const later = await evaluateGuarantee(
      db(),
      { orgId: DEFAULT_ORG_ID, clusterId: 'code-gen', strategyHash: H_MID, policy: policyWith(ROLLBACK_G) },
      new Date(NOW.getTime() + 62 * 60_000),
    );
    expect(later.suppressed).toBeNull();
    expect(await listIncidents(db(), DEFAULT_ORG_ID)).toHaveLength(2);
  });

  it('alert mode: incident only, no rollback target', async () => {
    await seedFrontiers();
    await seedSamples(DEFAULT_ORG_ID, H_MID, [0.1, 0.1, 0.2, 0.2, 0.2]);
    const result = await evaluateGuarantee(
      db(),
      { orgId: DEFAULT_ORG_ID, clusterId: 'code-gen', strategyHash: H_MID, policy: policyWith(ALERT_G) },
      NOW,
    );
    expect(result).toMatchObject({ breach: true, action: 'alert', rollback: null });
    const incidents = await listIncidents(db(), DEFAULT_ORG_ID);
    expect(incidents[0]!.kind).toBe('quality_breach');
    expect(incidents[0]!.detail.toStrategy).toBeUndefined();
    expect(await latestActiveRollback(db(), DEFAULT_ORG_ID, 'code-gen')).toBeNull();
  });

  it('no rollback target (v1, already top) → quality_breach with reason, no move', async () => {
    await insertFrontier(db(), {
      id: 'fr-g-1',
      clusterId: 'code-gen',
      version: 1,
      parentId: null,
      trigger: 'manual',
      points: V1_POINTS,
      pricesVersion: 'p',
      createdAt: 'x',
    });
    await seedSamples(DEFAULT_ORG_ID, H_MID, [0.1, 0.1, 0.1, 0.1, 0.1]); // mid tops v1
    const result = await evaluateGuarantee(
      db(),
      { orgId: DEFAULT_ORG_ID, clusterId: 'code-gen', strategyHash: H_MID, policy: policyWith(ROLLBACK_G) },
      NOW,
    );
    expect(result).toMatchObject({ breach: true, action: 'rollback', rollback: null });
    const incidents = await listIncidents(db(), DEFAULT_ORG_ID);
    expect(incidents[0]!.kind).toBe('quality_breach');
    expect(incidents[0]!.detail).toMatchObject({ intendedAction: 'rollback', reason: 'no-rollback-target' });
  });

  it('throws without a guarantee config (caller gates on it)', async () => {
    await expect(
      evaluateGuarantee(
        db(),
        { orgId: DEFAULT_ORG_ID, clusterId: 'code-gen', strategyHash: H_MID, policy: policyWith(undefined) },
        NOW,
      ),
    ).rejects.toThrow('guarantee');
  });
});

describe('incidents: resolve + active rollback + org isolation', () => {
  it('resolveIncident sets resolved_at, lifts the override, and is org-scoped', async () => {
    await createOrg(db(), { id: 'org_b', name: 'B' });
    const id = await insertIncident(db(), {
      orgId: DEFAULT_ORG_ID,
      kind: 'rollback',
      detail: { clusterId: 'code-gen', fromStrategy: H_MID, toStrategy: H_CHEAP },
    });
    expect((await latestActiveRollback(db(), DEFAULT_ORG_ID, 'code-gen'))?.id).toBe(id);
    // cross-org resolve is impossible by construction
    expect(await resolveIncident(db(), 'org_b', id)).toBeNull();
    expect((await latestActiveRollback(db(), DEFAULT_ORG_ID, 'code-gen'))?.id).toBe(id);
    const resolved = await resolveIncident(db(), DEFAULT_ORG_ID, id);
    expect(resolved?.resolvedAt).not.toBeNull();
    expect(await latestActiveRollback(db(), DEFAULT_ORG_ID, 'code-gen')).toBeNull();
    // resolving twice → null (idempotent 404 at the API layer)
    expect(await resolveIncident(db(), DEFAULT_ORG_ID, id)).toBeNull();
  });

  it('listIncidents returns all unresolved + last 20 resolved, unresolved first', async () => {
    for (let i = 0; i < 25; i++) {
      const id = await insertIncident(db(), {
        orgId: DEFAULT_ORG_ID,
        kind: 'quality_breach',
        detail: { clusterId: 'code-gen', fromStrategy: H_MID, n: i },
      });
      await resolveIncident(db(), DEFAULT_ORG_ID, id);
    }
    await insertIncident(db(), {
      orgId: DEFAULT_ORG_ID,
      kind: 'rollback',
      detail: { clusterId: 'code-gen', fromStrategy: H_MID, toStrategy: H_CHEAP },
    });
    const list = await listIncidents(db(), DEFAULT_ORG_ID);
    expect(list).toHaveLength(21); // 1 unresolved + 20 resolved
    expect(list[0]!.kind).toBe('rollback');
    expect(list[0]!.resolvedAt).toBeNull();
    expect(list.slice(1).every((r) => r.resolvedAt !== null)).toBe(true);
  });

  it('hasRecentIncident keys on (org, cluster, fromStrategy) + window', async () => {
    await insertIncident(db(), {
      orgId: DEFAULT_ORG_ID,
      kind: 'rollback',
      detail: { clusterId: 'code-gen', fromStrategy: H_MID, toStrategy: H_CHEAP },
    });
    const scope = { orgId: DEFAULT_ORG_ID, clusterId: 'code-gen', fromStrategy: H_MID, windowMin: 60 };
    expect(await hasRecentIncident(db(), scope, NOW)).toBe(true);
    expect(await hasRecentIncident(db(), { ...scope, clusterId: 'other' }, NOW)).toBe(false);
    expect(await hasRecentIncident(db(), { ...scope, fromStrategy: H_CHEAP }, NOW)).toBe(false);
  });
});

describe('sweep support', () => {
  it('listPoliciesWithGuarantee finds only guarantee-carrying policies (org filter)', async () => {
    await insertPolicy(db(), {
      id: 'pol-g',
      orgId: DEFAULT_ORG_ID,
      name: 'g',
      config: policyWith(ROLLBACK_G),
    });
    await insertPolicy(db(), {
      id: 'pol-plain',
      orgId: DEFAULT_ORG_ID,
      name: 'p',
      config: policyWith(undefined),
    });
    const all = await listPoliciesWithGuarantee(db());
    expect(all.map((p) => p.id)).toEqual(['pol-g']);
    expect(all[0]!.config.guarantee).toEqual(ROLLBACK_G);
    expect(await listPoliciesWithGuarantee(db(), 'org_nonexistent')).toEqual([]);
  });
});
