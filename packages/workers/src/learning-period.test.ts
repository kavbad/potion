// The learning period, end to end in mock mode: an org that named its
// incumbent and consented, with sampled requests for one kind of work, gets
// a PROPOSAL — and nothing is applied.
import { copyFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { strategyHash, type FrontierPoint } from '@potion/core';
import { createDb, migrate, orgs, insertTraceSpans, upsertOrgIncumbents, listLearningProposals, type DbHandle } from '@potion/db';
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
    expect(again.skipped.some((s) => s.why === 'fresh proposal')).toBe(true);
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
