// org:delete TRUE-CASCADE e2e (G2.7) — the "nothing derived survives" proof.
// Builds a FULL org through the REAL pipeline (traces → cluster → derived
// suite → mock eval → org frontier → rubric generation + probe calibration
// → live-stamped rows via the providerModeOverride seam), seeds every
// remaining inventory table (alerts+deliveries, budgets+events, shares,
// shadow, quality samples, custody, auth events, request logs, usage, billing,
// invites/pins, the guarantee trio, the Lab runtime), then deletes and asserts
// EVERY org-scoped table empty for the org, platform assets UNCHANGED, and the
// run idempotent. The asserted table list is DERIVED from the migrated schema
// (see orgFkTables), and the fixture's own coverage of it is asserted too — a
// hardcoded list is how this test drifted to ~26 of ~51 tables.
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

interface OrgFkTable {
  table: string;
  /** 'no action' BLOCKS `DELETE FROM orgs`; 'cascade' is swept by Postgres. */
  onDelete: 'cascade' | 'no action';
}

/**
 * The org-scoped table inventory, DERIVED from the migrated database rather
 * than hand-listed. A mutation audit (2026-09-04) found the hardcoded list this
 * replaces had drifted to ~26 of the ~51 tables the cascade handles: about 30
 * were unasserted, and `lab_harnesses` — a NO ACTION FK, so a real deletion
 * ABORTS without its delete — was among them. Reading pg_constraint means a
 * migration that adds an org-scoped table widens this test automatically; there
 * is no list to forget to update.
 */
async function orgFkTables(): Promise<OrgFkTable[]> {
  const res = await db.db.execute(sql.raw(
    `SELECT c.conrelid::regclass::text AS t, c.confdeltype AS del
     FROM pg_constraint c
     WHERE c.contype = 'f' AND c.confrelid = 'orgs'::regclass
     ORDER BY 1`,
  ));
  return (res.rows as Array<{ t: string; del: string }>).map((r) => ({
    table: r.t,
    onDelete: r.del === 'c' ? 'cascade' : 'no action',
  }));
}

/** Tables with an `org_id` column but NO FK to orgs — the silent-orphan class:
 * nothing blocks the delete, so an omission can never surface as an error. */
async function bareOrgIdTables(): Promise<string[]> {
  const res = await db.db.execute(sql.raw(
    `SELECT c.table_name AS t
     FROM information_schema.columns c
     JOIN information_schema.tables t
       ON t.table_name = c.table_name AND t.table_schema = c.table_schema
     WHERE c.column_name = 'org_id' AND c.table_schema = 'public'
       AND t.table_type = 'BASE TABLE'
       AND c.table_name NOT IN (
         SELECT k.conrelid::regclass::text FROM pg_constraint k
         WHERE k.contype = 'f' AND k.confrelid = 'orgs'::regclass)
     ORDER BY 1`,
  ));
  return (res.rows as Array<{ t: string }>).map((r) => r.t);
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
    await upsertBudget(db.db, { orgId: ORG, monthlyCapUsd: 10, hardStop: false, warnPct: 80 });
    await db.db.execute(sql.raw(`INSERT INTO budget_events (org_id, kind, day) VALUES ('${ORG}', 'budget_warning', '2026-08-07')`));
    // The other two bare-org_id tables (no FK, so nothing aborts if the
    // cascade misses them). Seeded so their "is empty after" assertions
    // below are non-vacuous — an empty table proves nothing.
    await db.db.execute(sql.raw(`INSERT INTO demand_cell_contributors (cell_key, org_id) VALUES ('cell-casc', '${ORG}')`));
    await db.db.execute(sql.raw(
      `INSERT INTO job_executions (job_id, job_kind, org_id) VALUES ('job-casc', 'eval:run', '${ORG}')`,
    ));
    // A router generation (0092) — a NO ACTION org FK, so an org holding one
    // cannot be deleted until the cascade clears it.
    await db.db.execute(sql.raw(
      `INSERT INTO router_generations (id, org_id, status, pins) VALUES ('gen-casc', '${ORG}', 'serving', '{}'::jsonb)`,
    ));
    const ruleRes = await db.db.execute(sql.raw(
      `INSERT INTO alert_rules (org_id, kind, target_url, events) VALUES ('${ORG}', 'webhook', 'https://x.example/hook?token=s3cret', ARRAY['recipe_promoted']) RETURNING id`,
    ));
    const ruleId = String((ruleRes.rows[0] as { id: string }).id);
    await insertAlertDelivery(db.db, { ruleId, event: 'recipe_promoted', status: 'delivered', attempts: 1, deliveredAt: new Date() });
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
    // Billing (R0/0039+0054), the invite/pin surfaces, the guarantee trio and
    // the Lab runtime — every one of them a NO ACTION org FK the pipeline
    // fixture above never reaches. Seeded because an EMPTY table makes its
    // `orgCount === 0` assertion vacuous: with a row present, a delete dropped
    // from the cascade aborts `DELETE FROM orgs` with an FK violation instead
    // of passing silently. The seeded set is not hand-picked — the assertion
    // right before the delete DERIVES it and fails if any is missed.
    await db.db.execute(sql.raw(
      `INSERT INTO billing_customers (org_id, customer_id) VALUES ('${ORG}', 'cus_casc')`,
    ));
    await db.db.execute(sql.raw(
      `INSERT INTO invoice_charges (id, org_id, period, amount_cents, status, transport) VALUES ('ic_casc', '${ORG}', '2026-08', 1000, 'pending', 'ledger')`,
    ));
    await db.db.execute(sql.raw(
      `INSERT INTO frontier_pins (org_id, cluster_id, frontier_id, frontier_version, pinned_by) VALUES ('${ORG}', '${clusterId}', 'fr_casc', 1, 'casc@x.dev')`,
    ));
    await db.db.execute(sql.raw(
      `INSERT INTO invites (org_id, email, role, invited_by) VALUES ('${ORG}', 'invitee@x.dev', 'member', 'casc@x.dev')`,
    ));
    await db.db.execute(sql.raw(
      `INSERT INTO cluster_incumbents (org_id, cluster_id, strategy_hash) VALUES ('${ORG}', '${clusterId}', 'h_casc')`,
    ));
    await db.db.execute(sql.raw(
      `INSERT INTO guarantee_verdicts (org_id, policy_id, cluster_id, candidate_hash, outcome) VALUES ('${ORG}', 'pol_casc', '${clusterId}', 'c_casc', 'all-clear')`,
    ));
    await db.db.execute(sql.raw(
      `INSERT INTO suite_certifications (org_id, cluster_id, suite_id, suite_version, status) VALUES ('${ORG}', '${clusterId}', '${suiteId}', '1.0.0', 'certified')`,
    ));
    await db.db.execute(sql.raw(
      `INSERT INTO research_cycles (org_id, trigger) VALUES ('${ORG}', 'manual')`,
    ));
    await db.db.execute(sql.raw(
      `INSERT INTO lab_harnesses (org_id, harness_hash, name, spec_text, sidecar, cluster_id) VALUES ('${ORG}', 'hh_casc', 'h', 'spec', '{}'::jsonb, '${clusterId}')`,
    ));
    await db.db.execute(sql.raw(
      `INSERT INTO lab_harness_memory (org_id, harness_hash, key, value) VALUES ('${ORG}', 'hh_casc', 'k', '{"v":1}'::jsonb)`,
    ));
    await db.db.execute(sql.raw(
      `INSERT INTO lab_felt_samples (org_id, probe_hash, policy_hash, frontier_id, strategy_hash, frontier_version, provenance, output, latency_ms, completion_id) VALUES ('${ORG}', 'ph_casc', 'poh_casc', 'fr_casc', 'h_casc', 1, 'mock', 'out', 1, 'cmp_casc')`,
    ));
    await db.db.execute(sql.raw(
      `INSERT INTO lab_runs (id, org_id, harness_hash, harness_name, spec, state) VALUES ('lr_casc', '${ORG}', 'hh_casc', 'h', '{}'::jsonb, 'completed')`,
    ));
    await db.db.execute(sql.raw(
      `INSERT INTO lab_run_steps (run_id, org_id, seq, kind, payload) VALUES ('lr_casc', '${ORG}', 1, 'model', '{}'::jsonb)`,
    ));
    await db.db.execute(sql.raw(
      `INSERT INTO lab_superpower_grants (id, org_id, connector_id, superpower_id, scopes_granted, token_envelope, status, granted_by) VALUES ('lsg_casc', '${ORG}', 'conn', 'sp', '[]'::jsonb, 'env', 'active', 'casc@x.dev')`,
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

    // The fixture's OWN completeness is asserted, not assumed. `orgCount === 0`
    // on a table that never had a row is a vacuous assertion — it passes just
    // as happily when the cascade forgot the table. For a NO ACTION FK a seeded
    // row converts a forgotten delete into an FK violation on `DELETE FROM
    // orgs`, which is loud. So: every NO ACTION org FK must be non-empty here,
    // and a new one fails THIS assertion (pointing at the fixture) rather than
    // quietly widening the hole.
    const orgFks = await orgFkTables();
    expect(orgFks.length, 'the pg_constraint derivation found the org FKs').toBeGreaterThan(45);
    const unseeded: string[] = [];
    for (const { table, onDelete } of orgFks) {
      if (onDelete === 'no action' && (await orgCount(table)) === 0) unseeded.push(table);
    }
    expect(
      unseeded,
      `NO ACTION org-FK table(s) this fixture never seeds: ${unseeded.join(', ')}. ` +
        'Seed each one above — an empty table makes its "nothing survives" check vacuous, ' +
        'and a NO ACTION FK left out of the cascade aborts real org deletions.',
    ).toEqual([]);

    // ---- DELETE ----
    let invalidated: string | null = null;
    const handler = createOrgDeleteHandler({ onOrgDeleted: (o) => void (invalidated = o) });
    const report = await handler({ orgId: ORG }, ctx());
    expect(report.alreadyDeleted).toBe(false);
    expect(invalidated).toBe(ORG);
    expect(report.deleted.orgs).toBe(1);
    expect(report.usersErased).toBe(1);

    // ---- NOTHING DERIVED SURVIVES ----
    // Every table with an FK to orgs, derived above — not a hand-kept list.
    for (const { table } of orgFks) {
      expect(await orgCount(table), table).toBe(0);
    }

    // The silent-orphan class: an `org_id` column with NO FK to orgs. Postgres
    // can never object, so only an explicit delete clears these. The set is
    // FROZEN so a new bare-org_id table fails here instead of leaking quietly.
    expect(new Set(await bareOrgIdTables())).toEqual(
      new Set(['budget_events', 'clusters', 'demand_cell_contributors', 'job_executions']),
    );
    // All four, now that the cascade clears all four. `demand_cell_contributors`
    // and `job_executions` were the open gap this block recorded on
    // 2026-09-04: org-attributed rows outliving the org, with no FK for
    // Postgres to object to and no assertion able to reveal it. Fixed in
    // deleteOrgCascade; the seeds above make these checks non-vacuous.
    for (const table of ['budget_events', 'clusters', 'demand_cell_contributors', 'job_executions']) {
      expect(await orgCount(table), table).toBe(0);
    }

    expect(await totalCount('derived_suite_items')).toBe(0); // rides the derived_suites cascade
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
