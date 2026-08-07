// Trust-hierarchy serve leg (G2.1, migration 0025): a designated incumbent
// switches evaluateGuarantee to advisory-only mode — floors derive from the
// incumbent's OWN serve-path distribution (never absolute), crossings mint
// kind='advisory' incidents that can never become rollback sources, and
// `breach` is structurally false on the serve leg (only suite-verify
// evidence renders the contractual verdict).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { strategyHash, type Policy } from '@potion/core';
import {
  createDb,
  createOrg,
  deriveServeFloor,
  designateIncumbent,
  evaluateGuarantee,
  insertQualitySample,
  latestActiveRollback,
  listIncidents,
  migrate,
  openAdvisoryForTuple,
  upsertStrategyConfig,
  type DbHandle,
} from './index.js';
import { insertPolicy } from './repos/api-keys.js';

const ORG = 'org_hier';
const PID = 'pol-h';
const CID = 'code-gen';
const CFG_SERVING = { type: 'single', model: 'mock-cheap' } as const;
const CFG_INCUMBENT = { type: 'single', model: 'mock-mid' } as const;
const H_SERVING = strategyHash(CFG_SERVING);
const H_INCUMBENT = strategyHash(CFG_INCUMBENT);
const NOW = new Date();

const GUARANTEE = { minQuality: 0.6, windowMin: 60, sampleRate: 1, action: 'rollback' as const };
const POLICY: Policy = { type: 'min_cost', qualityFloor: 0, guarantee: GUARANTEE };

let handle: DbHandle;
const db = () => handle.db;

async function seed(hash: string, qualities: number[]): Promise<void> {
  for (const q of qualities) {
    await insertQualitySample(db(), {
      orgId: ORG,
      strategyHash: hash,
      quality: q,
      createdAt: NOW,
      policyId: PID,
      clusterId: CID,
    });
  }
}

async function designate(): Promise<void> {
  await designateIncumbent(db(), ORG, CID, H_INCUMBENT);
}

function evaluate() {
  return evaluateGuarantee(
    db(),
    { orgId: ORG, policyId: PID, clusterId: CID, strategyHash: H_SERVING, policy: POLICY },
    NOW,
  );
}

beforeEach(async () => {
  handle = await createDb();
  await migrate(handle.db);
  await createOrg(db(), { id: ORG, name: 'Hierarchy' });
  await insertPolicy(db(), { id: PID, orgId: ORG, name: 'h', config: POLICY });
  for (const cfg of [CFG_SERVING, CFG_INCUMBENT]) {
    await upsertStrategyConfig(db(), strategyHash(cfg), cfg);
  }
});

afterEach(async () => {
  await handle.close();
});

describe('deriveServeFloor', () => {
  it('is the seeded CI95 lower bound of the incumbent window mean, deterministic, with provenance', async () => {
    await seed(H_INCUMBENT, [0.8, 0.82, 0.78, 0.81, 0.79, 0.8]);
    const scope = {
      orgId: ORG,
      policyId: PID,
      clusterId: CID,
      incumbentHash: H_INCUMBENT,
      windowMin: 60,
      minSamples: 5,
    };
    const a = await deriveServeFloor(db(), scope, NOW);
    const b = await deriveServeFloor(db(), scope, NOW);
    expect(a.floor).not.toBeNull();
    expect(a.floor).toBe(b.floor);
    expect(a.provenance).toEqual(b.provenance);
    expect(a.provenance!.incumbentHash).toBe(H_INCUMBENT);
    expect(a.provenance!.windowMin).toBe(120); // 2× the candidate window
    expect(a.provenance!.n).toBe(6);
    expect(a.floor!).toBeLessThanOrEqual(a.provenance!.mean);
    expect(a.floor!).toBe(a.provenance!.ci95[0]);
  });

  it('insufficient incumbent evidence → null floor, samples still reported', async () => {
    await seed(H_INCUMBENT, [0.8, 0.8]);
    const r = await deriveServeFloor(
      db(),
      { orgId: ORG, policyId: PID, clusterId: CID, incumbentHash: H_INCUMBENT, windowMin: 60, minSamples: 5 },
      NOW,
    );
    expect(r).toEqual({ floor: null, provenance: null, samples: 2 });
  });
});

describe('hierarchy evaluator', () => {
  it('no incumbent → legacy mode, advisory null (pre-G2.1 path untouched)', async () => {
    await seed(H_SERVING, [0.9, 0.9, 0.9, 0.9, 0.9]);
    const r = await evaluate();
    expect(r.mode).toBe('legacy');
    expect(r.advisory).toBeNull();
    expect(r.suppressed).toBe('no-breach');
  });

  it('confident crossing mints an advisory ONLY — no breach, no rollback, full provenance', async () => {
    await designate();
    await seed(H_INCUMBENT, [0.8, 0.82, 0.78, 0.81, 0.79, 0.8, 0.8, 0.81]);
    await seed(H_SERVING, [0.3, 0.32, 0.28, 0.31, 0.29, 0.3]);
    const r = await evaluate();
    expect(r.mode).toBe('hierarchy');
    expect(r.breach).toBe(false); // contractual verdicts are suite-leg only
    expect(r.action).toBeNull();
    expect(r.rollback).toBeNull();
    expect(r.advisory).not.toBeNull();
    expect(r.advisory!.triggered).toBe(true);
    expect(r.advisory!.deduped).toBe(false);
    expect(r.advisory!.floor).toBeGreaterThan(0.5);
    expect(r.advisory!.provenance.incumbentHash).toBe(H_INCUMBENT);

    const incidents = await listIncidents(db(), ORG);
    expect(incidents).toHaveLength(1);
    expect(incidents[0]!.kind).toBe('advisory');
    const detail = incidents[0]!.detail as Record<string, unknown>;
    expect(detail.leg).toBe('serve');
    expect(detail.floorProvenance).toBeTruthy();
    expect((detail.incumbent as Record<string, unknown>).hash).toBe(H_INCUMBENT);

    // Advisory rows can never satisfy the serving path's rollback override.
    expect(await latestActiveRollback(db(), ORG, CID)).toBeNull();
  });

  it('open advisory dedupes: second crossing reports deduped, no second row', async () => {
    await designate();
    await seed(H_INCUMBENT, [0.8, 0.82, 0.78, 0.81, 0.79, 0.8, 0.8, 0.81]);
    await seed(H_SERVING, [0.3, 0.32, 0.28, 0.31, 0.29, 0.3]);
    const first = await evaluate();
    expect(first.advisory!.triggered).toBe(true);
    const second = await evaluate();
    expect(second.suppressed).toBe('cooldown');
    expect(second.advisory!.triggered).toBe(false);
    expect(second.advisory!.deduped).toBe(true);
    expect(second.advisory!.incidentId).toBe(first.advisory!.incidentId);
    expect(await listIncidents(db(), ORG)).toHaveLength(1);
    expect(
      (await openAdvisoryForTuple(db(), { orgId: ORG, policyId: PID, clusterId: CID, fromStrategy: H_SERVING }))?.id,
    ).toBe(first.advisory!.incidentId);
  });

  it('incumbent without serve evidence → insufficient-baseline, nothing fires', async () => {
    await designate();
    await seed(H_SERVING, [0.3, 0.32, 0.28, 0.31, 0.29]);
    const r = await evaluate();
    expect(r.mode).toBe('hierarchy');
    expect(r.suppressed).toBe('insufficient-baseline');
    expect(r.advisory).toBeNull();
    expect(await listIncidents(db(), ORG)).toHaveLength(0);
  });

  it('serving at or above the derived floor → no-breach, minQuality ignored', async () => {
    await designate();
    await seed(H_INCUMBENT, [0.4, 0.42, 0.38, 0.41, 0.39, 0.4]);
    // Serving mean 0.5 is BELOW the absolute minQuality 0.6 but ABOVE the
    // incumbent-derived floor (~0.39) — hierarchy mode must not fire.
    await seed(H_SERVING, [0.5, 0.52, 0.48, 0.51, 0.49]);
    const r = await evaluate();
    expect(r.mode).toBe('hierarchy');
    expect(r.suppressed).toBe('no-breach');
    expect(await listIncidents(db(), ORG)).toHaveLength(0);
  });
});
