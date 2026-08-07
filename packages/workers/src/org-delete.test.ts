// org:delete TRUE-CASCADE e2e (G2.7) — the "nothing derived survives" proof.
// Builds a FULL org through the REAL pipeline (traces → cluster → derived
// suite → mock eval → org frontier → rubric generation + probe calibration
// → live-stamped rows via the providerModeOverride seam), seeds every
// remaining inventory table (alerts+deliveries, budgets+events, shares,
// shadow, quality samples, custody, auth events, request logs, usage), then
// deletes and asserts EVERY table empty for the org, platform assets
// UNCHANGED, and the run idempotent.
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sha256 } from '@potion/core';
import { sql } from 'drizzle-orm';
import {
  createDb,
  createMembership,
  createOrg,
  createSession,
  createUser,
  insertAlertDelivery,
  insertApiKey,
  insertPolicy,
  insertRequestLog,
  insertQualitySample,
  insertTraceSpans,
  migrate,
  upsertBudget,
  type DbHandle,
  type NewTraceSpan,
} from '@potion/db';
import { runEval } from '@potion/harness';
import {
  orgHashOf,
  rubricGenerateHandler,
  toolSignatureSlug,
  tracesClusterHandler,
  type JobContext,
} from './handlers.js';
import { createOrgDeleteHandler } from './org-delete.js';

const REPO_PRICES = fileURLToPath(new URL('../../../prices.json', import.meta.url));
const ORG = 'org_cascade';

let root: string;
let pricesPath: string;
let db: DbHandle;

function wordHash(word: string): number {
  let h = 0;
  for (let i = 0; i < word.length; i++) h = (Math.imul(h, 31) + word.charCodeAt(i)) | 0;
  return Math.abs(h);
}
const fakeEmbedder = {
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => {
      const v = new Array<number>(384).fill(0);
      for (const w of t.toLowerCase().split(/[^a-z0-9]+/)) if (w.length > 0) v[wordHash(w) % 384]! += 1;
      const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
      return v.map((x) => x / norm);
    });
  },
};

function ctx(): JobContext {
  return { db: db.db, dbHandle: db, pricesPath, embedder: fakeEmbedder };
}

function span(over: Partial<NewTraceSpan>): NewTraceSpan {
  return {
    orgId: ORG,
    traceId: 'tr',
    spanId: 'sp',
    name: 'agent.root',
    model: 'mock-cheap',
    usage: { input_tokens: 10, output_tokens: 5 },
    costUsd: 0,
    attrs: {},
    ts: new Date(),
    ...over,
  };
}

async function orgCount(table: string, orgPredicate = `org_id = '${ORG}'`): Promise<number> {
  const res = await db.db.execute(sql.raw(`SELECT count(*)::int AS n FROM ${table} WHERE ${orgPredicate}`));
  return Number((res.rows[0] as { n: number }).n);
}

async function totalCount(table: string): Promise<number> {
  const res = await db.db.execute(sql.raw(`SELECT count(*)::int AS n FROM ${table}`));
  return Number((res.rows[0] as { n: number }).n);
}

beforeEach(async () => {
  root = mkdtempSync(path.join(tmpdir(), 'potion-orgdel-'));
  pricesPath = path.join(root, 'prices.json');
  copyFileSync(REPO_PRICES, pricesPath);
  db = await createDb();
  await migrate(db.db);
  await createOrg(db.db, { id: ORG, name: 'Cascade Org' });
});

afterEach(async () => {
  await db.close();
  rmSync(root, { recursive: true, force: true });
});

describe('org:delete TRUE CASCADE (G2.7)', () => {
  it('NOTHING DERIVED SURVIVES: full-pipeline org → delete → every table empty; platform unchanged', async () => {
    // ---- build the org through the REAL pipeline ----
    for (const [t, p] of [
      ['tr_c1', 'Reconcile the vendor statements for account 50001001'],
      ['tr_c2', 'Reconcile the vendor statements for account 50001002'],
      ['tr_c3', 'Reconcile the vendor statements for account 50001003'],
    ] as const) {
      await insertTraceSpans(db.db, [
        span({ traceId: t, spanId: `${t}_root`, attrs: { 'gen_ai.prompt': p, 'gen_ai.completion': `Reconciled ${t} across both ledgers.` } }),
        span({
          traceId: t,
          spanId: `${t}_tool`,
          name: 'tool.ledger',
          attrs: { 'gen_ai.operation.name': 'execute_tool', 'tool.args': 'pull statements', 'tool.result': 'ok' },
          ts: new Date(Date.now() + 60_000),
        }),
      ]);
    }
    await tracesClusterHandler({ orgId: ORG }, ctx());
    const clusterId = `agent-${orgHashOf(ORG)}-${toolSignatureSlug(['ledger'])}`;
    const suiteId = `${clusterId}-replays-v1`;
    // rubric generation (mock) → cluster_rubrics + judge_calibrations via
    // the load-bearing calibration_id route
    const rub = await rubricGenerateHandler({ orgId: ORG, clusterId }, ctx());
    expect(rub.calibration).not.toBeNull();
    // live-stamped org eval rows (|live cache keys, providerMode 'live')
    await runEval(
      {
        suiteIds: [],
        suiteV2Ids: [suiteId],
        strategies: [{ type: 'single', model: 'mock-mid' }],
        budgetCapUsd: 1000,
        resume: true,
        orgId: ORG,
        providerModeOverride: 'live',
      },
      { db, pricesPath },
    );

    // ---- seed every remaining inventory table ----
    await createUser(db.db, { id: 'u_casc', email: 'casc@x.dev', name: 'c' });
    await createMembership(db.db, { orgId: ORG, userId: 'u_casc', role: 'admin' });
    await createSession(db.db, {
      id: 's_casc',
      userId: 'u_casc',
      tokenHash: sha256('t_casc'),
      orgId: ORG,
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    await insertPolicy(db.db, { id: 'pol_casc', orgId: ORG, name: 'p', config: { type: 'max_quality', costCeilingPer1K: 1 } });
    await insertApiKey(db.db, { id: 'key_casc', keyHash: sha256('pk_casc'), name: 'k', orgId: ORG, policyId: 'pol_casc' });
    await insertRequestLog(db.db, { orgId: ORG, clusterId, status: 'ok', usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.01, latencyMs: 1 } });
    await insertQualitySample(db.db, { orgId: ORG, strategyHash: 'h', quality: 0.5, clusterId, policyId: 'pol_casc' });
    await upsertBudget(db.db, { orgId: ORG, monthlyCapUsd: 10, hardStop: false });
    await db.db.execute(sql.raw(`INSERT INTO budget_events (org_id, kind, day) VALUES ('${ORG}', 'budget_warning', '2026-08-07')`));
    const ruleRes = await db.db.execute(sql.raw(
      `INSERT INTO alert_rules (org_id, kind, target_url, events) VALUES ('${ORG}', 'webhook', 'https://x.example/hook?token=s3cret', ARRAY['recipe_promoted']) RETURNING id`,
    ));
    const ruleId = String((ruleRes.rows[0] as { id: string }).id);
    await insertAlertDelivery(db.db, { ruleId, event: 'recipe_promoted', ok: true, status: 200 });
    await db.db.execute(sql.raw(
      `INSERT INTO share_tokens (org_id, kind, token_hash) VALUES ('${ORG}', 'frontier', '${sha256('share_casc')}')`,
    ));
    await db.db.execute(sql.raw(
      `INSERT INTO shadow_results (org_id, cluster_id, primary_hash, candidate_hash, candidate_model, cost_usd, latency_ms) VALUES ('${ORG}', '${clusterId}', 'h1', 'h2', 'mock-mid', 0, 0)`,
    ));
    await db.db.execute(sql.raw(
      `INSERT INTO custody_audit (id, org_id, actor, action) VALUES ('ca_casc', '${ORG}', 'test', 'decrypt')`,
    ));
    await db.db.execute(sql.raw(
      `INSERT INTO auth_events (id, org_id, kind, method, actor) VALUES ('ae_casc', '${ORG}', 'login', 'magic_link', 'casc@x.dev')`,
    ));
    await db.db.execute(sql.raw(
      `INSERT INTO incidents (org_id, kind, detail) VALUES ('${ORG}', 'quality_breach', '{}')`,
    ));
    await db.db.execute(sql.raw(
      `INSERT INTO usage_daily (org_id, day, cluster_id, requests, input_tokens, output_tokens, cost_usd, platform_cost_usd) VALUES ('${ORG}', '2026-08-07', '${clusterId}', 1, 1, 1, 0.01, 0.01)`,
    ));
    await db.db.execute(sql.raw(
      `INSERT INTO provider_keys (id, org_id, provider, name, masked_key, key_hash) VALUES ('pvk_casc', '${ORG}', 'openrouter', 'k', 'sk-…casc', 'kh_casc')`,
    ));
    await db.db.execute(sql.raw(
      `INSERT INTO magic_links (token_hash, email, org_id, expires_at) VALUES ('${sha256('ml_casc')}', 'casc@x.dev', '${ORG}', now() + interval '1 hour')`,
    ));

    // ---- platform baselines (must be UNCHANGED afterwards) ----
    const platformBefore = {
      models: await totalCount('models'),
      strategyConfigs: await totalCount('strategy_configs'),
      recipeStatus: await totalCount('recipe_status'),
      platformClusters: await orgCount('clusters', 'org_id IS NULL'),
      demoRequestLogs: await orgCount('request_logs', `org_id = 'org_demo'`),
    };

    // sanity: the org actually HAS data everywhere that matters
    expect(await orgCount('trace_spans')).toBeGreaterThan(0);
    expect(await orgCount('derived_suites')).toBe(1);
    expect(await orgCount('cluster_rubrics')).toBe(1);
    expect(await orgCount('eval_results')).toBeGreaterThan(0);
    expect(await orgCount('frontiers')).toBeGreaterThan(0);
    const exemplarsBefore = await totalCount('cluster_exemplars');
    expect(exemplarsBefore).toBeGreaterThan(0);
    const calsBefore = await totalCount('judge_calibrations');
    expect(calsBefore).toBeGreaterThan(0);

    // ---- DELETE ----
    let invalidated: string | null = null;
    const handler = createOrgDeleteHandler({ onOrgDeleted: (o) => void (invalidated = o) });
    const report = await handler({ orgId: ORG }, ctx());
    expect(report.alreadyDeleted).toBe(false);
    expect(invalidated).toBe(ORG);
    expect(report.deleted.orgs).toBe(1);
    expect(report.usersErased).toBe(1);

    // ---- NOTHING DERIVED SURVIVES ----
    for (const table of [
      'memberships', 'sessions', 'magic_links', 'policies', 'api_keys',
      'request_logs', 'provider_keys', 'custody_audit', 'usage_daily',
      'shadow_results', 'quality_samples', 'incidents', 'share_tokens',
      'alert_rules', 'budgets', 'auth_events', 'trace_spans',
      'derived_suites', 'cluster_rubrics', 'eval_runs', 'eval_results',
      'frontiers', 'frontier_points', 'research_cycles', 'budget_events',
      'clusters',
    ]) {
      expect(await orgCount(table), table).toBe(0);
    }
    expect(await totalCount('derived_suite_items')).toBe(0); // the one real FK cascade
    expect(await totalCount('cluster_exemplars')).toBe(0); // transitive via org clusters
    expect(await totalCount('judge_calibrations')).toBe(0); // three-route union
    expect(await db.db.execute(sql.raw(`SELECT count(*)::int AS n FROM alert_deliveries WHERE rule_id = '${ruleId}'`)).then((r) => Number((r.rows[0] as { n: number }).n))).toBe(0);
    expect(await db.db.execute(sql.raw(`SELECT count(*)::int AS n FROM orgs WHERE id = '${ORG}'`)).then((r) => Number((r.rows[0] as { n: number }).n))).toBe(0);

    // ---- platform UNCHANGED ----
    expect(await totalCount('models')).toBe(platformBefore.models);
    expect(await totalCount('strategy_configs')).toBe(platformBefore.strategyConfigs);
    expect(await totalCount('recipe_status')).toBe(platformBefore.recipeStatus);
    expect(await orgCount('clusters', 'org_id IS NULL')).toBe(platformBefore.platformClusters);
    expect(await orgCount('request_logs', `org_id = 'org_demo'`)).toBe(platformBefore.demoRequestLogs);

    // ---- idempotent re-run ----
    const again = await handler({ orgId: ORG }, ctx());
    expect(again.alreadyDeleted).toBe(true);
  });

  it('zero-data org deletes cleanly', async () => {
    await createOrg(db.db, { id: 'org_empty', name: 'Empty' });
    const report = await createOrgDeleteHandler()({ orgId: 'org_empty' }, ctx());
    expect(report.alreadyDeleted).toBe(false);
    expect(report.deleted.orgs).toBe(1);
    expect(report.usersErased).toBe(0);
  });
});
