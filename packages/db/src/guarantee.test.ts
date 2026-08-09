// Guarantee repository + breach evaluator tests (M3, ROADMAP #22, SPEC
// §12.5, migration 0008): rolling windows, min-evidence gate, cooldown,
// rollback target precedence (previous version first, current-version
// fallback), alert mode, incident resolve, org isolation.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { strategyHash, type FrontierPoint, type Policy, type StrategyConfig } from '@potion/core';
import {
  createDb,
  evaluateGuarantee,
  equivalentPointOnPrevious,
  GUARANTEE_MIN_SAMPLES,
  recentContractualIncident,
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
  rollingQualityForPolicy,
  windowEvidence,
  assertReproducible,
  deriveServeFloor,
  type DbHandle,
} from './index.js';
import { insertFrontier } from './repos/frontiers.js';
// G2.4 carryover: the subject tenant is a real, distinct org — never the demo
// org, whose seeded/dev-bypass specialness lets a tenancy failure pass for
// reasons that have nothing to do with tenancy (see the fixture header).
import { ORG_A, ORG_B, seedIsolationOrgs } from './test-fixtures/orgs.js';
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

/** The keyed-evidence defaults every evaluator test uses (G0.3). */
const PID = 'pol-g';
const CID = 'code-gen';

async function seedSamples(
  orgId: string,
  hash: string,
  qualities: number[],
  createdAt: Date = NOW,
  keys: { policyId?: string | null; clusterId?: string | null } = {},
): Promise<void> {
  for (const q of qualities) {
    await insertQualitySample(db(), {
      orgId,
      strategyHash: hash,
      quality: q,
      createdAt,
      policyId: keys.policyId === undefined ? PID : keys.policyId,
      clusterId: keys.clusterId === undefined ? CID : keys.clusterId,
    });
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
  await seedIsolationOrgs(handle.db);
});

afterEach(async () => {
  await handle.close();
});

describe('quality_samples judge evidence (G0.1, migration 0016)', () => {
  it('round-trips scorer / judgeModel / judgeCostUsd; stub-era rows carry NULLs', async () => {
    const id = await insertQualitySample(db(), {
      orgId: ORG_A,
      requestId: 'chatcmpl-evidence-1',
      strategyHash: H_CHEAP,
      quality: 0.8,
      scorer: 'llm-judge:judge-class',
      judgeModel: 'judge-class',
      judgeCostUsd: 0.000615,
    });
    expect(id).toBeTruthy();
    const rows = await listQualitySamples(db(), ORG_A);
    const row = rows.find((r) => r.requestId === 'chatcmpl-evidence-1')!;
    expect(row.scorer).toBe('llm-judge:judge-class');
    expect(row.judgeModel).toBe('judge-class');
    expect(row.judgeCostUsd).toBeCloseTo(0.000615, 12);
    // additive: rows inserted without evidence fields (stub era) are NULL
    await insertQualitySample(db(), { orgId: ORG_A, strategyHash: H_CHEAP, quality: 0.5 });
    const legacy = (await listQualitySamples(db(), ORG_A)).find((r) => r.requestId === null)!;
    expect(legacy.scorer).toBeNull();
    expect(legacy.judgeModel).toBeNull();
    expect(legacy.judgeCostUsd).toBeNull();
  });
});

describe('windowEvidence (strictly keyed, G0.3)', () => {
  const SCOPE = { orgId: ORG_A, policyId: PID, clusterId: CID, strategyHash: H_CHEAP, windowMin: 60 };

  it('returns keyed in-window qualities; other orgs/strategies/old samples excluded', async () => {
    await seedSamples(ORG_A, H_CHEAP, [0.2, 0.4, 0.6]);
    // outside the 60-min window
    await seedSamples(ORG_A, H_CHEAP, [0.99], new Date(NOW.getTime() - 61 * 60_000));
    await seedSamples(ORG_B, H_CHEAP, [0.99]);
    await seedSamples(ORG_A, H_MID, [0.99]);
    const r = await windowEvidence(db(), SCOPE, NOW);
    expect(r.samples).toBe(3);
    expect(r.mean).toBeCloseTo(0.4, 10);
    expect([...r.qualities].sort()).toEqual([0.2, 0.4, 0.6]);
  });

  it('STRICT keys: other-policy, other-cluster, and NULL-key (pre-G0.3) rows are not evidence', async () => {
    await seedSamples(ORG_A, H_CHEAP, [0.1], NOW, { policyId: 'pol-other' });
    await seedSamples(ORG_A, H_CHEAP, [0.1], NOW, { clusterId: 'extraction' });
    await seedSamples(ORG_A, H_CHEAP, [0.1], NOW, { policyId: null, clusterId: null });
    await seedSamples(ORG_A, H_CHEAP, [0.8]);
    const r = await windowEvidence(db(), SCOPE, NOW);
    expect(r.samples).toBe(1);
    expect(r.qualities).toEqual([0.8]);
  });

  it('returns null mean with no samples', async () => {
    const r = await windowEvidence(db(), SCOPE, NOW);
    expect(r).toEqual({ qualities: [], mean: null, samples: 0 });
  });
});

describe('rollingQualityForPolicy (status rollup)', () => {
  it('pools the policy across strategies/clusters; other policies excluded', async () => {
    await seedSamples(ORG_A, H_CHEAP, [0.2, 0.4]);
    await seedSamples(ORG_A, H_MID, [0.9], NOW, { clusterId: 'extraction' });
    await seedSamples(ORG_A, H_CHEAP, [0.0], NOW, { policyId: 'pol-other' });
    const r = await rollingQualityForPolicy(db(), { orgId: ORG_A, policyId: PID, windowMin: 60 }, NOW);
    expect(r.samples).toBe(3);
    expect(r.mean).toBeCloseTo(0.5, 10);
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
    await seedSamples(ORG_A, H_MID, [0.1, 0.2, 0.3, 0.2, 0.2]);
    const result = await evaluateGuarantee(
      db(),
      { orgId: ORG_A, policyId: PID, clusterId: 'code-gen', strategyHash: H_MID, policy: policyWith(ROLLBACK_G) },
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
    const incidents = await listIncidents(db(), ORG_A);
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
    await seedSamples(ORG_A, H_CHEAP, [0.1, 0.1, 0.1, 0.1, 0.1]);
    const result = await evaluateGuarantee(
      db(),
      { orgId: ORG_A, policyId: PID, clusterId: 'code-gen', strategyHash: H_CHEAP, policy: policyWith(ROLLBACK_G) },
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
    await seedSamples(ORG_A, H_MID, [0.0, 0.0, 0.0, 0.0]);
    const result = await evaluateGuarantee(
      db(),
      { orgId: ORG_A, policyId: PID, clusterId: 'code-gen', strategyHash: H_MID, policy: policyWith(ROLLBACK_G) },
      NOW,
    );
    expect(result).toMatchObject({ breach: false, suppressed: 'insufficient-evidence', samples: 4 });
    expect(GUARANTEE_MIN_SAMPLES).toBe(5);
    expect(await listIncidents(db(), ORG_A)).toHaveLength(0);
  });

  it('recovery (rolling mean back above the floor) → no new incident', async () => {
    await seedFrontiers();
    await seedSamples(ORG_A, H_MID, [0.9, 0.8, 0.95, 0.85, 0.9]);
    const result = await evaluateGuarantee(
      db(),
      { orgId: ORG_A, policyId: PID, clusterId: 'code-gen', strategyHash: H_MID, policy: policyWith(ROLLBACK_G) },
      NOW,
    );
    expect(result).toMatchObject({ breach: false, suppressed: 'no-breach' });
    expect(await listIncidents(db(), ORG_A)).toHaveLength(0);
  });

  it('cooldown suppresses a duplicate incident within the window', async () => {
    await seedFrontiers();
    await seedSamples(ORG_A, H_MID, [0.1, 0.2, 0.2, 0.2, 0.2]);
    const first = await evaluateGuarantee(
      db(),
      { orgId: ORG_A, policyId: PID, clusterId: 'code-gen', strategyHash: H_MID, policy: policyWith(ROLLBACK_G) },
      NOW,
    );
    expect(first.incidentId).not.toBeNull();
    // same window, still breaching → suppressed by cooldown
    const second = await evaluateGuarantee(
      db(),
      { orgId: ORG_A, policyId: PID, clusterId: 'code-gen', strategyHash: H_MID, policy: policyWith(ROLLBACK_G) },
      new Date(NOW.getTime() + 5 * 60_000),
    );
    expect(second).toMatchObject({ breach: true, action: null, suppressed: 'cooldown' });
    expect(await listIncidents(db(), ORG_A)).toHaveLength(1);
    // …but AFTER the window the cooldown has expired (samples aged out too,
    // so re-seed a fresh breaching window).
    await seedSamples(
      ORG_A,
      H_MID,
      [0.1, 0.1, 0.1, 0.1, 0.1],
      new Date(NOW.getTime() + 61 * 60_000),
    );
    const later = await evaluateGuarantee(
      db(),
      { orgId: ORG_A, policyId: PID, clusterId: 'code-gen', strategyHash: H_MID, policy: policyWith(ROLLBACK_G) },
      new Date(NOW.getTime() + 62 * 60_000),
    );
    expect(later.suppressed).toBeNull();
    expect(await listIncidents(db(), ORG_A)).toHaveLength(2);
  });

  it('alert mode: incident only, no rollback target', async () => {
    await seedFrontiers();
    await seedSamples(ORG_A, H_MID, [0.1, 0.1, 0.2, 0.2, 0.2]);
    const result = await evaluateGuarantee(
      db(),
      { orgId: ORG_A, policyId: PID, clusterId: 'code-gen', strategyHash: H_MID, policy: policyWith(ALERT_G) },
      NOW,
    );
    expect(result).toMatchObject({ breach: true, action: 'alert', rollback: null });
    const incidents = await listIncidents(db(), ORG_A);
    expect(incidents[0]!.kind).toBe('quality_breach');
    expect(incidents[0]!.detail.toStrategy).toBeUndefined();
    expect(await latestActiveRollback(db(), ORG_A, 'code-gen')).toBeNull();
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
    await seedSamples(ORG_A, H_MID, [0.1, 0.1, 0.1, 0.1, 0.1]); // mid tops v1
    const result = await evaluateGuarantee(
      db(),
      { orgId: ORG_A, policyId: PID, clusterId: 'code-gen', strategyHash: H_MID, policy: policyWith(ROLLBACK_G) },
      NOW,
    );
    expect(result).toMatchObject({ breach: true, action: 'rollback', rollback: null });
    const incidents = await listIncidents(db(), ORG_A);
    expect(incidents[0]!.kind).toBe('quality_breach');
    expect(incidents[0]!.detail).toMatchObject({ intendedAction: 'rollback', reason: 'no-rollback-target' });
  });

  it('throws without a guarantee config (caller gates on it)', async () => {
    await expect(
      evaluateGuarantee(
        db(),
        { orgId: ORG_A, policyId: PID, clusterId: 'code-gen', strategyHash: H_MID, policy: policyWith(undefined) },
        NOW,
      ),
    ).rejects.toThrow('guarantee');
  });
});

describe('evaluateGuarantee CI decision (G0.3)', () => {
  const INPUT = { orgId: ORG_A, policyId: PID, clusterId: 'code-gen', strategyHash: H_MID };

  it('confident breach: decisively-low evidence → ciUpper < floor, incident carries ci95 + seed', async () => {
    await seedFrontiers();
    await seedSamples(ORG_A, H_MID, [0.1, 0.2, 0.3, 0.2, 0.2]);
    const result = await evaluateGuarantee(db(), { ...INPUT, policy: policyWith(ROLLBACK_G) }, NOW);
    expect(result.breach).toBe(true);
    expect(result.ci95).not.toBeNull();
    expect(result.ci95![1]).toBeLessThan(ROLLBACK_G.minQuality); // the decision bound
    expect(result.seed).not.toBeNull();
    expect(result.minSamplesRequired).toBe(5);
    const incident = (await listIncidents(db(), ORG_A))[0]!;
    expect(incident.detail).toMatchObject({
      policyId: PID,
      ci95: result.ci95,
      seed: result.seed,
      resamples: 1000,
      minSamples: 5,
    });
  });

  it("observed below floor but CI straddles → 'not-significant', NO incident", async () => {
    await seedFrontiers();
    // mean 0.58 < 0.6 floor, but high variance across 5 samples: resamples
    // heavy in 0.95s push the CI upper bound above the floor.
    await seedSamples(ORG_A, H_MID, [0.1, 0.4, 0.95, 0.95, 0.5]);
    const result = await evaluateGuarantee(db(), { ...INPUT, policy: policyWith(ROLLBACK_G) }, NOW);
    expect(result.rollingQuality).toBeCloseTo(0.58, 10);
    expect(result.breach).toBe(false);
    expect(result.suppressed).toBe('not-significant');
    expect(result.ci95).not.toBeNull();
    expect(result.ci95![1]).toBeGreaterThanOrEqual(ROLLBACK_G.minQuality);
    expect(await listIncidents(db(), ORG_A)).toHaveLength(0);
  });

  it('is exactly reproducible: same evidence → same ci95 and seed', async () => {
    await seedFrontiers();
    await seedSamples(ORG_A, H_MID, [0.1, 0.4, 0.95, 0.95, 0.5]);
    const a = await evaluateGuarantee(db(), { ...INPUT, policy: policyWith(ALERT_G) }, NOW);
    const b = await evaluateGuarantee(db(), { ...INPUT, policy: policyWith(ALERT_G) }, NOW);
    expect(a.ci95).toEqual(b.ci95);
    expect(a.seed).toBe(b.seed);
  });

  it('configured minSamples raises the evidence floor', async () => {
    await seedFrontiers();
    await seedSamples(ORG_A, H_MID, [0.1, 0.1, 0.1, 0.1, 0.1, 0.1]); // 6 samples
    const result = await evaluateGuarantee(
      db(),
      { ...INPUT, policy: policyWith({ ...ROLLBACK_G, minSamples: 8 }) },
      NOW,
    );
    expect(result.breach).toBe(false);
    expect(result.suppressed).toBe('insufficient-evidence');
    expect(result.minSamplesRequired).toBe(8);
    expect(result.samples).toBe(6);
    expect(await listIncidents(db(), ORG_A)).toHaveLength(0);
  });

  it('evidence from another policy or cluster never feeds this window', async () => {
    await seedFrontiers();
    await seedSamples(ORG_A, H_MID, [0.1, 0.1, 0.1], NOW, { policyId: 'pol-other' });
    await seedSamples(ORG_A, H_MID, [0.1, 0.1], NOW, { clusterId: 'extraction' });
    const result = await evaluateGuarantee(db(), { ...INPUT, policy: policyWith(ROLLBACK_G) }, NOW);
    expect(result.samples).toBe(0); // 5 rows exist, none are THIS window's evidence
    expect(result.suppressed).toBe('insufficient-evidence');
  });
});

describe('incidents: resolve + active rollback + org isolation', () => {
  it('resolveIncident sets resolved_at, lifts the override, and is org-scoped', async () => {
    const id = await insertIncident(db(), {
      orgId: ORG_A,
      kind: 'rollback',
      detail: { clusterId: 'code-gen', fromStrategy: H_MID, toStrategy: H_CHEAP },
    });
    expect((await latestActiveRollback(db(), ORG_A, 'code-gen'))?.id).toBe(id);
    // cross-org resolve is impossible by construction
    expect(await resolveIncident(db(), ORG_B, id)).toBeNull();
    expect((await latestActiveRollback(db(), ORG_A, 'code-gen'))?.id).toBe(id);
    const resolved = await resolveIncident(db(), ORG_A, id);
    expect(resolved?.resolvedAt).not.toBeNull();
    expect(await latestActiveRollback(db(), ORG_A, 'code-gen')).toBeNull();
    // resolving twice → null (idempotent 404 at the API layer)
    expect(await resolveIncident(db(), ORG_A, id)).toBeNull();
  });

  it('listIncidents returns all unresolved + last 20 resolved, unresolved first', async () => {
    for (let i = 0; i < 25; i++) {
      const id = await insertIncident(db(), {
        orgId: ORG_A,
        kind: 'quality_breach',
        detail: { clusterId: 'code-gen', fromStrategy: H_MID, n: i },
      });
      await resolveIncident(db(), ORG_A, id);
    }
    await insertIncident(db(), {
      orgId: ORG_A,
      kind: 'rollback',
      detail: { clusterId: 'code-gen', fromStrategy: H_MID, toStrategy: H_CHEAP },
    });
    const list = await listIncidents(db(), ORG_A);
    expect(list).toHaveLength(21); // 1 unresolved + 20 resolved
    expect(list[0]!.kind).toBe('rollback');
    expect(list[0]!.resolvedAt).toBeNull();
    expect(list.slice(1).every((r) => r.resolvedAt !== null)).toBe(true);
  });

  it('G2.2 re-fire: cooldown yields when the new evidence is confidently WORSE (CI separation)', async () => {
    await insertPolicy(db(), { id: 'pol-rf', orgId: ORG_A, name: 'rf', config: policyWith(ALERT_G) });
    const input = {
      orgId: ORG_A,
      policyId: 'pol-rf',
      clusterId: CID,
      strategyHash: H_MID,
      policy: policyWith(ALERT_G),
    };
    // Confidently-low evidence (mean ~0.1, tight CI).
    await seedSamples(ORG_A, H_MID, [0.1, 0.11, 0.09, 0.1, 0.1, 0.11], NOW, { policyId: 'pol-rf' });
    // Prior incident inside the window, SEPARATED above (its lower 0.5 >
    // the new upper ~0.11) → re-fire despite cooldown, lineage recorded.
    const prior = await insertIncident(db(), {
      orgId: ORG_A,
      kind: 'quality_breach',
      detail: { policyId: 'pol-rf', clusterId: CID, fromStrategy: H_MID, ci95: [0.5, 0.6] },
    });
    const refired = await evaluateGuarantee(db(), input, NOW);
    expect(refired.breach).toBe(true);
    expect(refired.suppressed).toBeNull();
    expect(refired.incidentId).not.toBeNull();
    expect(refired.incidentAt).toBeInstanceOf(Date);
    const list = await listIncidents(db(), ORG_A);
    const minted = list.find((i) => i.id === refired.incidentId)!;
    expect((minted.detail as Record<string, unknown>).refire).toMatchObject({
      priorIncidentId: prior,
      priorCi95: [0.5, 0.6],
    });
    // OVERLAPPING prior (lower 0.05 < new upper) → still cooldown. The
    // just-minted re-fire incident itself overlaps (same evidence), so the
    // next evaluation suppresses — no incident storm.
    const cooled = await evaluateGuarantee(db(), input, NOW);
    expect(cooled.suppressed).toBe('cooldown');
    expect(cooled.incidentId).toBeNull();
  });

  it('recentContractualIncident keys on (org, policy, cluster, fromStrategy) + window; contractual kinds ONLY', async () => {
    await insertIncident(db(), {
      orgId: ORG_A,
      kind: 'rollback',
      detail: { policyId: PID, clusterId: 'code-gen', fromStrategy: H_MID, toStrategy: H_CHEAP, ci95: [0.2, 0.4] },
    });
    const scope = { orgId: ORG_A, policyId: PID, clusterId: 'code-gen', fromStrategy: H_MID, windowMin: 60 };
    const hit = await recentContractualIncident(db(), scope, NOW);
    expect(hit).not.toBeNull();
    // G2.2: the FULL row comes back — prior severity (detail.ci95) readable.
    expect((hit!.detail as Record<string, unknown>).ci95).toEqual([0.2, 0.4]);
    expect(await recentContractualIncident(db(), { ...scope, clusterId: 'other' }, NOW)).toBeNull();
    expect(await recentContractualIncident(db(), { ...scope, fromStrategy: H_CHEAP }, NOW)).toBeNull();
    // G0.3: another policy on the same (cluster, strategy) is NOT cooled down
    expect(await recentContractualIncident(db(), { ...scope, policyId: 'pol-other' }, NOW)).toBeNull();
    // G2.2 regression: an ADVISORY row on the tuple must NOT suppress a
    // later contractual incident (pre-G2.2 the check had no kind filter).
    const scope2 = { ...scope, policyId: 'pol-advisory-only' };
    await insertIncident(db(), {
      orgId: ORG_A,
      kind: 'advisory',
      detail: { policyId: 'pol-advisory-only', clusterId: 'code-gen', fromStrategy: H_MID },
    });
    expect(await recentContractualIncident(db(), scope2, NOW)).toBeNull();
  });
});

describe('sweep support', () => {
  it('listPoliciesWithGuarantee finds only guarantee-carrying policies (org filter)', async () => {
    await insertPolicy(db(), {
      id: 'pol-g',
      orgId: ORG_A,
      name: 'g',
      config: policyWith(ROLLBACK_G),
    });
    await insertPolicy(db(), {
      id: 'pol-plain',
      orgId: ORG_A,
      name: 'p',
      config: policyWith(undefined),
    });
    const all = await listPoliciesWithGuarantee(db());
    expect(all.map((p) => p.id)).toEqual(['pol-g']);
    expect(all[0]!.config.guarantee).toEqual(ROLLBACK_G);
    expect(await listPoliciesWithGuarantee(db(), 'org_nonexistent')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Post-G2.8 — determinism of the serve-leg evidence readers.
// ---------------------------------------------------------------------------

describe('windowEvidence determinism (the tie-break, post-G2.8)', () => {
  const SCOPE_W = { orgId: ORG_A, policyId: PID, clusterId: CID, strategyHash: H_CHEAP, windowMin: 60 };
  const ID_LO = '00000000-0000-4000-8000-000000000001';
  const ID_HI = '00000000-0000-4000-8000-000000000002';
  const tied = async (firstId: string, firstQ: number, secondId: string, secondQ: number) => {
    // SAME created_at — the tie the pre-fix ORDER BY left unspecified. Three
    // seed sites (deriveServeFloor, evaluateGuarantee, the advisory leg) hash
    // this array into their bootstrap seed, so tie order reached a
    // contractual CI.
    for (const [id, quality] of [[firstId, firstQ], [secondId, secondQ]] as const) {
      await insertQualitySample(db(), {
        id, orgId: ORG_A, strategyHash: H_CHEAP, quality,
        createdAt: NOW, policyId: PID, clusterId: CID,
      });
    }
  };

  it('created_at ties order by id DESC — a contract, not scan luck', async () => {
    // Ascending-id insert first: a pre-fix seq scan returns insert order
    // (id ASC), so this test FAILS without the tie-break.
    await tied(ID_LO, 0.2, ID_HI, 0.8);
    const r = await windowEvidence(db(), SCOPE_W, NOW);
    expect(r.qualities).toEqual([0.8, 0.2]);
  });

  it('insert order does not move the evidence array when row identity is fixed', async () => {
    await tied(ID_HI, 0.8, ID_LO, 0.2); // opposite physical order
    const r = await windowEvidence(db(), SCOPE_W, NOW);
    expect(r.qualities).toEqual([0.8, 0.2]); // same canonical (created_at, id) order
  });

  it('re-reads are byte-identical (assertReproducible)', async () => {
    await tied(ID_LO, 0.31, ID_HI, 0.62);
    await seedSamples(ORG_A, H_CHEAP, [0.5, 0.7, 0.9]);
    await assertReproducible(() => windowEvidence(db(), SCOPE_W, NOW), 'windowEvidence');
  });
});

describe('deriveServeFloor determinism (run-twice-diff, post-G2.8)', () => {
  it('identical stored evidence → byte-identical floor, CI and seed', async () => {
    await seedSamples(ORG_A, H_CHEAP, [0.55, 0.72, 0.63, 0.81, 0.59, 0.7]);
    const floor = await assertReproducible(
      () =>
        deriveServeFloor(
          db(),
          { orgId: ORG_A, policyId: PID, clusterId: CID, incumbentHash: H_CHEAP, windowMin: 60, minSamples: 5 },
          NOW,
        ),
      'deriveServeFloor',
    );
    // And the result is a real floor with full provenance, not a null path.
    expect(floor.floor).not.toBeNull();
    expect(floor.provenance?.seed).toBeGreaterThan(0);
  });
});
