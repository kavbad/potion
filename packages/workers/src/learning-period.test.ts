// The learning period, end to end in mock mode: an org that named its
// incumbent and consented, with sampled requests for one kind of work, gets
// a PROPOSAL — and nothing is applied.
import { copyFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sha256, strategyHash, type FrontierPoint, type Policy } from '@potion/core';
import { createDb, migrate, orgs, insertApiKey, insertPolicy, insertTraceSpans, upsertOrgIncumbents, listLearningProposals, type DbHandle } from '@potion/db';
import { saveFrontier } from '@potion/pareto';
import { LEARNING_SPAN_NAME, runLearningPeriodForOrg } from './learning-period.js';
import type { JobContext } from './handlers.js';

const REPO_PRICES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../prices.json');

let db: DbHandle;
let pricesPath: string;

beforeEach(async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'potion-lp-'));
  pricesPath = path.join(root, 'prices.json');
  copyFileSync(REPO_PRICES, pricesPath);
  db = await createDb();
  await migrate(db.db);
  await db.db.insert(orgs).values([{ id: 'org_lp', name: 'LP' }]).onConflictDoNothing();
});
afterEach(async () => {
  await db.close();
});

function point(model: string, quality: number, costPer1K: number, latencyP95: number): FrontierPoint {
  const strategyConfig = { type: 'single', model } as FrontierPoint['strategyConfig'];
  return { clusterId: 'classification', strategyHash: strategyHash(strategyConfig), strategyConfig, quality, costPer1K, latencyP95, evidence: { n: 10 } } as FrontierPoint;
}

describe('learning:period', () => {
  it('proposes a bar from the org’s own sampled requests; applies nothing', async () => {
    const ctx: JobContext = { db: db.db, dbHandle: db, pricesPath };
    await saveFrontier(db.db, 'classification', [point('mock-cheap', 0.96, 0.4, 120), point('mock-mid', 0.98, 2.1, 340)], 'manual', 'test-prices');
    await upsertOrgIncumbents(db.db, { orgId: 'org_lp', models: ['mock-mid'], other: null, samplingConsent: true });
    await insertTraceSpans(
      db.db,
      Array.from({ length: 10 }, (_, i) => ({
        orgId: 'org_lp', traceId: `learn-r${i}`, spanId: 'chat', parentId: null, name: LEARNING_SPAN_NAME, model: 'mock-cheap', usage: {}, costUsd: 0,
        attrs: { 'gen_ai.operation.name': 'chat', 'gen_ai.prompt': `Is review ${i} positive, negative, or neutral?`, 'gen_ai.completion': 'negative', 'potion.cluster_id': 'classification' },
        ts: new Date(),
      })),
    );
    const report = await runLearningPeriodForOrg(ctx, 'org_lp');
    expect(report.outcome).toBe('ran');
    expect(report.proposals.map((p) => p.clusterId), JSON.stringify(report.skipped)).toEqual(['classification']);
    const rows = await listLearningProposals(db.db, 'org_lp');
    expect(rows).toHaveLength(1);
    const p = rows[0]!;
    expect(p.status).toBe('proposed');
    expect(p.incumbentModel).toBe('mock-mid');
    expect(p.items).toBeGreaterThanOrEqual(8);
    expect(p.suggestedFloor).toBeGreaterThan(0);
    expect(p.suggestedFloor).toBeLessThanOrEqual(1);
    // a second run within the week does not propose again
    const again = await runLearningPeriodForOrg(ctx, 'org_lp');
    expect(again.proposals).toHaveLength(0);
    // 2026-09-11: nothing changed (same frontier version, no new samples,
    // no challenger) → not re-measured. A clock no longer re-spends.
    expect(again.skipped.some((s) => s.why.startsWith('unchanged since the last proposal')), JSON.stringify(again.skipped)).toBe(true);
  });

  it('GREENFIELD: "building from scratch" measures against the frontier\'s premium single', async () => {
    const ctx: JobContext = { db: db.db, dbHandle: db, pricesPath };
    await saveFrontier(db.db, 'classification', [point('mock-cheap', 0.96, 0.4, 120), point('mock-mid', 0.98, 2.1, 340)], 'manual', 'test-prices');
    // no models named, consent given — the exact first-run smart-default state
    await upsertOrgIncumbents(db.db, { orgId: 'org_lp', models: [], other: 'building from scratch', samplingConsent: true });
    await insertTraceSpans(
      db.db,
      Array.from({ length: 10 }, (_, i) => ({
        orgId: 'org_lp', traceId: `learn-g${i}`, spanId: 'chat', parentId: null, name: LEARNING_SPAN_NAME, model: 'mock-cheap', usage: {}, costUsd: 0,
        attrs: { 'gen_ai.operation.name': 'chat', 'gen_ai.prompt': `Is comment ${i} spam or not spam?`, 'gen_ai.completion': 'not spam', 'potion.cluster_id': 'classification' },
        ts: new Date(),
      })),
    );
    const report = await runLearningPeriodForOrg(ctx, 'org_lp');
    expect(report.outcome, JSON.stringify(report.skipped)).toBe('ran');
    expect(report.proposals.map((p) => p.clusterId)).toEqual(['classification']);
    const rows = await listLearningProposals(db.db, 'org_lp');
    // the reference is the top-quality single on the frontier — the premium
    // counterfactual the receipts already price, measured on THEIR prompts
    expect(rows[0]!.incumbentModel).toBe('mock-mid');
    expect(rows[0]!.suggestedFloor).toBeGreaterThan(0);
  });

  it('refuses without consent or without an incumbent, spending nothing', async () => {
    const ctx: JobContext = { db: db.db, dbHandle: db, pricesPath };
    expect((await runLearningPeriodForOrg(ctx, 'org_lp')).outcome).toBe('no-incumbent');
    await upsertOrgIncumbents(db.db, { orgId: 'org_lp', models: ['mock-mid'], other: null, samplingConsent: false });
    expect((await runLearningPeriodForOrg(ctx, 'org_lp')).outcome).toBe('no-consent');
  });
});

describe("the serving pick is the serve path's own resolution (2026-08-31, one-resolver P0)", () => {
  // Frontier: mock-cheap (q 0.96, $0.4) and mock-mid (q 0.98, $2.1). The
  // old reimplementation ("top-level floor-or-0.95 → cheapest above,
  // cheapest-overall on infeasible") picks mock-cheap under EVERY policy
  // below; the serve chain picks mock-mid. Incumbent is mock-cheap so the
  // measured pair is always two distinct models.
  async function servingModelUnder(policy: Policy): Promise<string | undefined> {
    await saveFrontier(db.db, 'classification', [point('mock-cheap', 0.96, 0.4, 120), point('mock-mid', 0.98, 2.1, 340)], 'manual', 'test-prices');
    await upsertOrgIncumbents(db.db, { orgId: 'org_lp', models: ['mock-cheap'], other: null, samplingConsent: true });
    await insertPolicy(db.db, { id: 'pol-lp', orgId: 'org_lp', name: 'lp', config: policy });
    await insertApiKey(db.db, { id: 'key-lp', keyHash: sha256('pk_lp'), name: 'serve', orgId: 'org_lp', policyId: 'pol-lp' });
    await insertTraceSpans(
      db.db,
      Array.from({ length: 10 }, (_, i) => ({
        orgId: 'org_lp', traceId: `learn-s${i}`, spanId: 'chat', parentId: null, name: LEARNING_SPAN_NAME, model: 'mock-cheap', usage: {}, costUsd: 0,
        attrs: { 'gen_ai.operation.name': 'chat', 'gen_ai.prompt': `Is ticket ${i} urgent or routine?`, 'gen_ai.completion': 'routine', 'potion.cluster_id': 'classification' },
        ts: new Date(),
      })),
    );
    const ctx: JobContext = { db: db.db, dbHandle: db, pricesPath };
    const report = await runLearningPeriodForOrg(ctx, 'org_lp');
    expect(report.outcome, JSON.stringify(report.skipped)).toBe('ran');
    const rows = await listLearningProposals(db.db, 'org_lp');
    return rows[0]?.servingModel;
  }

  it('honors the CLUSTER floor, not just the top-level floor', async () => {
    // 0.97 for classification (top-level 0.7 is permissive): only mock-mid
    // clears. The bypass read only the top-level floor → mock-cheap.
    expect(await servingModelUnder({ type: 'min_cost', qualityFloor: 0.7, clusterFloors: { classification: 0.97 } })).toBe('mock-mid');
  });

  it('an infeasible floor measures the HIGHEST-QUALITY point production actually serves', async () => {
    // 0.995: nothing clears. Production serves highest-quality
    // (policy_infeasible); the bypass INVERTED this to cheapest-overall.
    expect(await servingModelUnder({ type: 'min_cost', qualityFloor: 0.995 })).toBe('mock-mid');
  });

  it('a max_quality policy measures the max-quality pick, never a 0.95-floor default', async () => {
    // Ceiling $3: both points eligible → max quality wins. The bypass had
    // no qualityFloor to read, defaulted 0.95, and picked cheapest-above.
    expect(await servingModelUnder({ type: 'max_quality', costCeilingPer1K: 3 })).toBe('mock-mid');
  });
});

describe('FULL-REQUEST derivation (2026-09-01, G1 — the measured task is the served task)', () => {
  const span = (traceId: string, attrs: Record<string, unknown>) => ({
    orgId: 'org_lp', traceId, spanId: 'chat', parentId: null, name: LEARNING_SPAN_NAME,
    model: 'mock-cheap', usage: {}, costUsd: 0, ts: new Date(),
    attrs: { 'gen_ai.operation.name': 'chat', 'potion.cluster_id': 'classification', 'gen_ai.completion': 'routine', ...attrs },
  });

  it('a full-capture span derives the WHOLE conversation; a legacy span still derives its last turn', async () => {
    const { deriveLearningSuites, learningSuiteId } = await import('./learning-period.js');
    const { loadDerivedSuite } = await import('@potion/db');
    const ctx: JobContext = { db: db.db, dbHandle: db, pricesPath };
    await insertTraceSpans(db.db, [
      span('learn-full', {
        'potion.messages': [
          { role: 'system', content: 'You label tickets.' },
          { role: 'user', content: 'Prior turn.' },
          { role: 'assistant', content: 'Noted.' },
          { role: 'user', content: 'Urgent or routine?' },
        ],
        'potion.tool_count': 0,
      }),
      span('learn-legacy', { 'gen_ai.prompt': 'Is this spam?' }),
    ]);
    const { sizes, excluded } = await deriveLearningSuites(ctx, 'org_lp', 'mock-judge');
    expect(sizes.classification).toBe(2);
    expect(excluded).toEqual({});
    const suite = await loadDerivedSuite(db.db, learningSuiteId('org_lp', 'classification'));
    const full = suite!.items.find((i) => i.id === 'learn-full')!;
    expect(full.prompt.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(full.prompt[0]!.content).toBe('You label tickets.');
    const legacy = suite!.items.find((i) => i.id === 'learn-legacy')!;
    expect(legacy.prompt).toEqual([{ role: 'user', content: 'Is this spam?' }]);
  });

  it('tool- and attachment-carrying spans are EXCLUDED and the report names them', async () => {
    const { deriveLearningSuites } = await import('./learning-period.js');
    const ctx: JobContext = { db: db.db, dbHandle: db, pricesPath };
    await insertTraceSpans(db.db, [
      span('learn-t1', { 'potion.messages': [{ role: 'user', content: 'call the tool' }], 'potion.tool_count': 3 }),
      span('learn-p1', { 'potion.messages': [{ role: 'user', content: 'see attachment' }], 'potion.multimodal_parts': 1 }),
      span('learn-ok', { 'potion.messages': [{ role: 'user', content: 'plain text task' }], 'potion.tool_count': 0 }),
    ]);
    const { sizes, excluded } = await deriveLearningSuites(ctx, 'org_lp', 'mock-judge');
    expect(sizes.classification).toBe(1);
    expect(excluded).toEqual({ classification: 2 });
    // …and through the full period, the exclusion is named, never hidden
    await upsertOrgIncumbents(db.db, { orgId: 'org_lp', models: ['mock-mid'], other: null, samplingConsent: true });
    await saveFrontier(db.db, 'classification', [point('mock-cheap', 0.96, 0.4, 120), point('mock-mid', 0.98, 2.1, 340)], 'manual', 'test-prices');
    const report = await runLearningPeriodForOrg(ctx, 'org_lp');
    expect(report.skipped.some((s) => s.why.includes('carry tools or attachments'))).toBe(true);
  });
});

describe('the bar derivation (2026-08-31 — the number IS the measurement)', () => {
  it('proposes exactly what the incumbent measured — no hidden minimum', async () => {
    const { suggestedFloorFor } = await import('./learning-period.js');
    // The screenshot case: kimi measured 0.38 → the bar is 0.38, not 0.50.
    expect(suggestedFloorFor(0.38)).toBe(0.38);
    expect(suggestedFloorFor(0.955)).toBe(0.95); // floored, never rounded up
    expect(suggestedFloorFor(1.0)).toBe(1.0);
    expect(suggestedFloorFor(0.5)).toBe(0.5);
    // Near-zero is a problem to surface, not a bar to invent.
    expect(suggestedFloorFor(0.02)).toBeNull();
    expect(suggestedFloorFor(0)).toBeNull();
  });
});
