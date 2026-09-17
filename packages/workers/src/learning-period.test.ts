// The learning period, end to end in mock mode: an org that named its
// incumbent and consented, with sampled requests for one kind of work, gets
// a PROPOSAL — and nothing is applied.
import { copyFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sha256, strategyHash, type FrontierPoint, type Policy } from '@potion/core';
import { createDb, migrate, orgs, getApiKeyById, getPolicyById, insertApiKey, insertPolicy, insertRequestLog, insertTraceSpans, upsertOrgIncumbents, listLearningProposals, type DbHandle } from '@potion/db';
import { DEFAULT_ORG_POLICY } from '@potion/pareto';
import { seedModelRegistry } from '@potion/db';
import { loadPrices } from '@potion/providers';
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

  // THE OBSERVED REFERENCE (2026-09-16): consent given, nothing priced named
  // ("several"). The org's own requests have been naming mock-cheap on
  // classification. The greenfield fallback would measure against the
  // premium single (mock-mid); the observed reference is what they use.
  it('with consent but nothing priced named, the model the org’s requests NAMED MOST is the reference — not the premium single', async () => {
    const ctx: JobContext = { db: db.db, dbHandle: db, pricesPath };
    await db.db.insert(orgs).values([{ id: 'org_obs', name: 'OBS' }]).onConflictDoNothing();
    await saveFrontier(db.db, 'classification', [point('mock-cheap', 0.96, 0.4, 120), point('mock-mid', 0.98, 2.1, 340)], 'manual', 'test-prices');
    await upsertOrgIncumbents(db.db, { orgId: 'org_obs', models: [], other: 'several', samplingConsent: true });
    for (let i = 0; i < 5; i++) await insertRequestLog(db.db, { orgId: 'org_obs', model: 'mock-cheap', clusterId: 'classification', status: 'ok' });
    await insertTraceSpans(
      db.db,
      Array.from({ length: 10 }, (_, i) => ({
        orgId: 'org_obs', traceId: `obs-r${i}`, spanId: 'chat', parentId: null, name: LEARNING_SPAN_NAME, model: 'mock-cheap', usage: {}, costUsd: 0,
        attrs: { 'gen_ai.operation.name': 'chat', 'gen_ai.prompt': `Is review ${i} positive, negative, or neutral?`, 'gen_ai.completion': 'negative', 'potion.cluster_id': 'classification' },
        ts: new Date(),
      })),
    );
    const report = await runLearningPeriodForOrg(ctx, 'org_obs');
    expect(report.outcome).toBe('ran');
    expect(report.proposals.map((p) => p.clusterId), JSON.stringify(report.skipped)).toEqual(['classification']);
    const p = (await listLearningProposals(db.db, 'org_obs'))[0]!;
    expect(p.incumbentModel, 'observed, not the greenfield premium single').toBe('mock-cheap');
  });

  // THE REGISTRY, NOT THE FILE (2026-09-17). Found live: classification v8
  // serves or-glm-5-3-flash, which entered via the registry; the learning
  // period priced from prices.json alone and refused the customer's
  // classification measurement — "unknown model" — on every run.
  it('a serving model known only to the registry is measurable — no "unknown model" refusal', async () => {
    const ctx: JobContext = { db: db.db, dbHandle: db, pricesPath };
    await db.db.insert(orgs).values([{ id: 'org_reg', name: 'REG' }]).onConflictDoNothing();
    // The registry REPLACES the file once present (registryPrices), so seed it
    // the way production was seeded — from the file — plus one alias the
    // file has never heard of.
    const file = loadPrices(pricesPath).table;
    const seeded = await seedModelRegistry(db.db, {
      version: 'registry-test',
      updatedAt: new Date().toISOString(),
      entries: [...file.entries, { alias: 'mock-registry-only', provider: 'mock', model: 'mock-registry-only', inputPer1M: 0, outputPer1M: 0 }],
    });
    expect(seeded.inserted).toContain('mock-registry-only');
    // The frontier's serving pick is the registry-only model.
    await saveFrontier(db.db, 'classification', [point('mock-registry-only', 0.96, 0.4, 120), point('mock-mid', 0.98, 2.1, 340)], 'manual', 'test-prices');
    await upsertOrgIncumbents(db.db, { orgId: 'org_reg', models: ['mock-mid'], other: null, samplingConsent: true });
    await insertTraceSpans(
      db.db,
      Array.from({ length: 10 }, (_, i) => ({
        orgId: 'org_reg', traceId: `reg-r${i}`, spanId: 'chat', parentId: null, name: LEARNING_SPAN_NAME, model: 'mock-cheap', usage: {}, costUsd: 0,
        attrs: { 'gen_ai.operation.name': 'chat', 'gen_ai.prompt': `Is review ${i} positive, negative, or neutral?`, 'gen_ai.completion': 'negative', 'potion.cluster_id': 'classification' },
        ts: new Date(),
      })),
    );
    const report = await runLearningPeriodForOrg(ctx, 'org_reg');
    expect(report.outcome).toBe('ran');
    expect(report.skipped.map((x) => x.why).join(' | ')).not.toMatch(/unknown model/);
    expect(report.proposals.map((p) => p.clusterId), JSON.stringify(report.skipped)).toEqual(['classification']);
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

// THE DERIVED DEFAULT (2026-09-16). The first test in this file pins the
// doctrine — "a proposal, and nothing is applied" — and it still holds for
// every bar somebody chose. The one exception is the bar NOBODY chose: the
// key mint's 'default' row at DEFAULT_ORG_POLICY, bound so a first request
// works. Once the org's own incumbent is measured on its own work, that
// guess is replaced by the measurement.
describe('the derived default (2026-09-16) — a measurement replaces the signup guess, never a choice', () => {
  async function seedMeasurableOrg(orgId: string, policy: { id: string; name: string; config: Policy }) {
    await db.db.insert(orgs).values([{ id: orgId, name: orgId }]).onConflictDoNothing();
    await saveFrontier(db.db, 'classification', [point('mock-cheap', 0.96, 0.4, 120), point('mock-mid', 0.98, 2.1, 340)], 'manual', 'test-prices');
    await insertPolicy(db.db, { id: policy.id, orgId, name: policy.name, config: policy.config });
    await insertApiKey(db.db, { id: `key-${orgId}`, keyHash: sha256(`pk_${orgId}`), name: 'first key', orgId, policyId: policy.id });
    await upsertOrgIncumbents(db.db, { orgId, models: ['mock-mid'], other: null, samplingConsent: true });
    await insertTraceSpans(
      db.db,
      Array.from({ length: 10 }, (_, i) => ({
        orgId, traceId: `dd-${orgId}-${i}`, spanId: 'chat', parentId: null, name: LEARNING_SPAN_NAME, model: 'mock-cheap', usage: {}, costUsd: 0,
        attrs: { 'gen_ai.operation.name': 'chat', 'gen_ai.prompt': `Is review ${i} positive, negative, or neutral?`, 'gen_ai.completion': 'negative', 'potion.cluster_id': 'classification' },
        ts: new Date(),
      })),
    );
  }

  it("replaces the mint's 'default' row: proposals applied, keys rebound, per-kind floor = the measurement", async () => {
    const ctx: JobContext = { db: db.db, dbHandle: db, pricesPath };
    await seedMeasurableOrg('org_dd_untouched', { id: 'pol-dd-default', name: 'default', config: DEFAULT_ORG_POLICY });
    const report = await runLearningPeriodForOrg(ctx, 'org_dd_untouched');
    expect(report.outcome).toBe('ran');
    expect(report.proposals.map((p) => p.clusterId), JSON.stringify(report.skipped)).toEqual(['classification']);
    expect(report.derivedDefault, 'the signup guess is replaced').not.toBeNull();
    const { policyId, keysRebound, clusterFloors } = report.derivedDefault!;
    expect(keysRebound).toBe(1);
    expect(clusterFloors.classification).toBe(report.proposals[0]!.suggestedFloor);
    const key = await getApiKeyById(db.db, 'org_dd_untouched', 'key-org_dd_untouched');
    expect(key?.policyId).toBe(policyId);
    const pol = await getPolicyById(db.db, 'org_dd_untouched', policyId);
    expect(pol?.name).toContain('derived');
    expect(pol?.config).toMatchObject({ type: 'min_cost', qualityFloor: DEFAULT_ORG_POLICY.type === 'min_cost' ? DEFAULT_ORG_POLICY.qualityFloor : 0.95, clusterFloors: { classification: clusterFloors.classification } });
    const rows = await listLearningProposals(db.db, 'org_dd_untouched');
    expect(rows[0]?.status).toBe('applied');
    expect(rows[0]?.statusReason).toContain('nobody chose');
  });

  it('never replaces a bar somebody chose — same config under a chosen name stays a proposal', async () => {
    const ctx: JobContext = { db: db.db, dbHandle: db, pricesPath };
    // The customer typed 0.95 into the floor card: identical config, but a
    // row named by the click. That is a choice.
    await seedMeasurableOrg('org_dd_chosen', { id: 'pol-dd-chosen', name: 'floor 0.95', config: DEFAULT_ORG_POLICY });
    const report = await runLearningPeriodForOrg(ctx, 'org_dd_chosen');
    expect(report.proposals).toHaveLength(1);
    expect(report.derivedDefault).toBeNull();
    const key = await getApiKeyById(db.db, 'org_dd_chosen', 'key-org_dd_chosen');
    expect(key?.policyId).toBe('pol-dd-chosen');
    expect((await listLearningProposals(db.db, 'org_dd_chosen'))[0]?.status).toBe('proposed');
  });

  it("never replaces a 'default' row whose config was edited", async () => {
    const ctx: JobContext = { db: db.db, dbHandle: db, pricesPath };
    await seedMeasurableOrg('org_dd_edited', { id: 'pol-dd-edited', name: 'default', config: { type: 'min_cost', qualityFloor: 0.9 } });
    const report = await runLearningPeriodForOrg(ctx, 'org_dd_edited');
    expect(report.proposals).toHaveLength(1);
    expect(report.derivedDefault).toBeNull();
    expect((await getApiKeyById(db.db, 'org_dd_edited', 'key-org_dd_edited'))?.policyId).toBe('pol-dd-edited');
  });
});
