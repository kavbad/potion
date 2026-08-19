// frontier:platform-sweep tests (Lab Step 5) — PGlite, zero network. The
// refusal ladder is pinned refusal-by-refusal (each BEFORE any spend, each
// for its named reason); containment and the publish path are proven through
// the runner's providerModeOverride seam (live-stamped rows without
// network, the G1.7 test pattern). The true live happy path is the Step 5
// operator legs, ledgered per cluster.
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { suiteContentHash, type StrategyConfig } from '@potion/core';
import {
  claimJobExecution,
  createDb,
  createOrg,
  clusters,
  evalResults,
  frontiers,
  insertRequestLog,
  migrate,
  requestLogs,
  upsertBudget,
  type DbHandle,
} from '@potion/db';
import { loadSuite, loadSuiteV2, runEval } from '@potion/harness';
import {
  aggregatesFromEvalResults,
  computeFrontier,
  saveFrontier,
} from '@potion/pareto';
import { loadPrices } from '@potion/providers';
import { buildRegistry, classRepresentative } from '@potion/researcher';
import { SINGLE_ATTEMPT_KINDS } from '@potion/queue';
import { and, eq, isNotNull } from 'drizzle-orm';
import {
  frontierPlatformSweepHandler,
  OrgBudgetRefusalError,
  PlatformSweepRefusalError,
  PLATFORM_OPS_ORG_ID,
  PLATFORM_SUITE_BY_CLUSTER,
  type JobContext,
} from './handlers.js';

const REPO_PRICES = fileURLToPath(new URL('../../../prices.json', import.meta.url));

// The taxonomy, pinned literally (the Step 2 discipline): the suite map
// must cover exactly these clusters — no more, no fewer.
const TAXONOMY = [
  'agentic-tool-use',
  'classification',
  'code-gen',
  'code-review',
  'creative',
  'extraction',
  'multi-step-reasoning',
  'rag-answer',
  'rewrite-edit',
  'summarization',
] as const;

const ENV_KEYS = [
  'POTION_EVAL_PROVIDER',
  'OPENROUTER_API_KEY',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GOOGLE_API_KEY',
] as const;

let root: string;
let pricesPath: string;
let db: DbHandle;
let savedEnv: Record<string, string | undefined>;

function ctx(): JobContext {
  return { db: db.db, dbHandle: db, pricesPath };
}

/** Refusal-ladder preconditions up to (but excluding) the stage under test. */
async function armThrough(stage: 'belt' | 'keys'): Promise<void> {
  process.env.POTION_EVAL_PROVIDER = 'live';
  if (stage === 'keys') {
    await createOrg(db.db, { id: PLATFORM_OPS_ORG_ID, name: 'Platform operations' });
    await upsertBudget(db.db, { orgId: PLATFORM_OPS_ORG_ID, monthlyCapUsd: 60, hardStop: true });
  }
}

async function expectRefusal(
  payload: Parameters<typeof frontierPlatformSweepHandler>[0],
  reason: string,
): Promise<void> {
  const before = (await db.db.select().from(requestLogs)).length;
  try {
    await frontierPlatformSweepHandler(payload, ctx());
    expect.fail('expected a refusal');
  } catch (e) {
    if (e instanceof PlatformSweepRefusalError) {
      expect(e.reason).toBe(reason);
    } else {
      expect(reason).toBe('belt-exceeded');
      expect(e).toBeInstanceOf(OrgBudgetRefusalError);
    }
  }
  // No spend on ANY refusal — the whole point of a pre-spend ladder.
  expect((await db.db.select().from(requestLogs)).length).toBe(before);
}

beforeEach(async () => {
  root = mkdtempSync(path.join(tmpdir(), 'potion-platsweep-'));
  pricesPath = path.join(root, 'prices.json');
  copyFileSync(REPO_PRICES, pricesPath);
  db = await createDb();
  await migrate(db.db);
  savedEnv = {};
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(async () => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  await db.close();
  rmSync(root, { recursive: true, force: true });
});

describe('suite map — both directions against the taxonomy', () => {
  it('covers exactly the taxonomy, and every mapped suite is committed, ≥15 items, cluster-true', () => {
    expect(Object.keys(PLATFORM_SUITE_BY_CLUSTER).sort()).toEqual([...TAXONOMY]);
    for (const [clusterId, mapped] of Object.entries(PLATFORM_SUITE_BY_CLUSTER)) {
      const items =
        mapped.kind === 'v1' ? loadSuite(mapped.suiteId) : loadSuiteV2(mapped.suiteId).items;
      // Tier B samples 15 per cluster; the small v1 suites carry 14 real
      // items (a wc -l over the files counts their provenance comment line
      // — recorded in the Step 5 spec as a measured deviation), so a
      // sample of 15 runs those suites whole.
      expect(items.length, `${mapped.suiteId} too small`).toBeGreaterThanOrEqual(14);
      for (const item of items) expect(item.clusterId, `item ${item.id}`).toBe(clusterId);
    }
  });

  it('suiteContentHash of a committed suite is reproducible and order-independent', () => {
    const items = loadSuite('summarization').map((i) => ({
      itemId: i.id,
      prompt: i.prompt,
      reference: i.reference,
      scoring: i.scoring,
    }));
    const a = suiteContentHash(items);
    const b = suiteContentHash([...items].reverse());
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('openrouter-only class coverage (the or-opus addition)', () => {
  it('one OpenRouter key represents all four classes', () => {
    const { table: prices } = loadPrices(pricesPath);
    const registry = buildRegistry(prices).filter((e) => e.provider === 'openrouter');
    const cheap = classRepresentative(registry, 'cheap');
    const mid = classRepresentative(registry, 'mid');
    const strong = classRepresentative(registry, 'strong');
    const judge = classRepresentative(registry, 'judge');
    expect(cheap).not.toBeNull();
    expect(mid).not.toBeNull();
    expect(judge).not.toBeNull();
    // Pre-Step-5 this was null (no or-* alias classified strong) — the
    // sweep would have silently published a two-single frontier. THAT is the
    // property: every answerer tier has a reachable representative on one
    // key. The specific alias is NOT — this asserted 'or-opus' while the
    // registry held 8 curated models, and ingesting the OpenRouter catalogue
    // (24 → 362 entries) correctly moved it to a cheaper strong-tier model.
    // Pinning the alias would have made every catalogue refresh a test
    // failure that says nothing about whether the sweep can run.
    expect(strong).not.toBeNull();
    expect(strong?.provider).toBe('openrouter');
  });
});

describe('refusal ladder — each refuses BEFORE any spend, for its named reason', () => {
  it('env gate: no POTION_EVAL_PROVIDER=live', async () => {
    await expectRefusal({ clusterId: 'summarization', capUsd: 6 }, 'env-gate');
  });

  it('cap gate: capUsd is REQUIRED — no inherited default', async () => {
    process.env.POTION_EVAL_PROVIDER = 'live';
    await expectRefusal(
      { clusterId: 'summarization' } as Parameters<typeof frontierPlatformSweepHandler>[0],
      'cap-missing',
    );
    await expectRefusal({ clusterId: 'summarization', capUsd: 0 }, 'cap-missing');
    await expectRefusal({ clusterId: 'summarization', capUsd: -1 }, 'cap-missing');
  });

  it('cluster gate: non-taxonomy cluster refused by name', async () => {
    process.env.POTION_EVAL_PROVIDER = 'live';
    await expectRefusal({ clusterId: 'agent-abc123-billing', capUsd: 6 }, 'unknown-cluster');
  });

  it('containment front door: an org-owned cluster row is refused even under a taxonomy id', async () => {
    process.env.POTION_EVAL_PROVIDER = 'live';
    await createOrg(db.db, { id: 'org_squatter', name: 'Squatter' });
    await db.db.insert(clusters).values({
      id: 'summarization',
      name: 'squatted',
      description: 'org-owned row under a taxonomy id',
      orgId: 'org_squatter',
    });
    await expectRefusal({ clusterId: 'summarization', capUsd: 6 }, 'org-owned-cluster');
  });

  it('belt gate: REQUIRED hard-stop budget row on the ops org (review outcome 1)', async () => {
    await armThrough('belt');
    await expectRefusal({ clusterId: 'summarization', capUsd: 6 }, 'belt-missing');
    // A soft (non-hardStop) belt is not a belt.
    await createOrg(db.db, { id: PLATFORM_OPS_ORG_ID, name: 'Platform operations' });
    await upsertBudget(db.db, { orgId: PLATFORM_OPS_ORG_ID, monthlyCapUsd: 60, hardStop: false });
    await expectRefusal({ clusterId: 'summarization', capUsd: 6 }, 'belt-missing');
  });

  it('belt exceeded: fail-CLOSED when mtd + capUsd would cross the belt', async () => {
    await armThrough('keys');
    await insertRequestLog(db.db, {
      orgId: PLATFORM_OPS_ORG_ID,
      status: 'eval_live',
      usage: { inputTokens: 1, outputTokens: 1, costUsd: 58, latencyMs: 1 },
    });
    await expectRefusal({ clusterId: 'summarization', capUsd: 6 }, 'belt-exceeded');
  });

  it('keys gate: no provider keys at all', async () => {
    await armThrough('keys');
    await expectRefusal({ clusterId: 'summarization', capUsd: 6 }, 'no-keys');
  });

  it('class gate: a key set that cannot represent every answerer class refuses (never a silent two-single sweep)', async () => {
    await armThrough('keys');
    // Google alone covers cheap+mid but has no strong-classified alias —
    // the refusal fires BEFORE any provider call, so the fake key is inert.
    process.env.GOOGLE_API_KEY = 'fake-key-never-used';
    await expectRefusal({ clusterId: 'summarization', capUsd: 6 }, 'class-unrepresented');
  });
});

describe('F10: spend-bearing job discipline', () => {
  it('frontier:platform-sweep is a SINGLE_ATTEMPT kind', () => {
    expect(SINGLE_ATTEMPT_KINDS.has('frontier:platform-sweep')).toBe(true);
  });

  it('a redelivery of the same job cannot claim execution twice', async () => {
    const first = await claimJobExecution(db.db, {
      jobId: 'job-ps-1',
      jobKind: 'frontier:platform-sweep',
      attempt: 1,
    });
    expect(first.decision).toBe('proceed');
    const second = await claimJobExecution(db.db, {
      jobId: 'job-ps-1',
      jobKind: 'frontier:platform-sweep',
      attempt: 2,
    });
    expect(second.decision).not.toBe('proceed');
  });
});

describe('containment — platform rows stay platform (the F12 lesson, sweep-shaped)', () => {
  const CLUSTER = 'summarization';
  const strategies: StrategyConfig[] = [{ type: 'single', model: 'mock-mid' }];

  /** Plant rows at IDENTICAL (cluster × strategy × item) coordinates in all
   * three scopes the aggregation must distinguish. $0: mock provider; the
   * live stamp rides the runner's providerModeOverride seam. */
  async function plantAdversarialRows(): Promise<void> {
    const base = {
      suiteIds: [CLUSTER],
      strategies,
      budgetCapUsd: 1000,
      resume: true,
      itemSampleN: 3,
    } as const;
    // 1. Platform MOCK (the seed's shape — SIMULATED evidence).
    await runEval({ ...base }, { db, pricesPath });
    // 2. ORG-attributed LIVE-stamped (a tenant's paid evidence).
    await createOrg(db.db, { id: 'org_tenant', name: 'Tenant' });
    await runEval({ ...base, orgId: 'org_tenant', providerModeOverride: 'live' }, { db, pricesPath });
    // 3. Platform LIVE-stamped (what the sweep produces).
    await runEval({ ...base, providerModeOverride: 'live' }, { db, pricesPath });
  }

  it('platform-live aggregation sees ONLY org-NULL live rows; org aggregation sees only its own', async () => {
    await plantAdversarialRows();
    const { table: prices } = loadPrices(pricesPath);

    const all = await db.db.select().from(evalResults).where(eq(evalResults.clusterId, CLUSTER));
    expect(all.filter((r) => r.orgId === null && r.providerMode === 'mock').length).toBe(3);
    expect(all.filter((r) => r.orgId === 'org_tenant' && r.providerMode === 'live').length).toBe(3);
    expect(all.filter((r) => r.orgId === null && r.providerMode === 'live').length).toBe(3);

    // The platform sweep's exact read: no org (IS NULL), live only.
    const platformLive = await aggregatesFromEvalResults(db.db, CLUSTER, strategies, prices.version, {
      providerMode: 'live',
    });
    expect(platformLive).toHaveLength(1);
    expect(platformLive[0]!.n).toBe(3); // NOT 6 (mock excluded), NOT 9 (org excluded)
    expect(platformLive[0]!.providerMode).toBe('live');

    const orgLive = await aggregatesFromEvalResults(db.db, CLUSTER, strategies, prices.version, {
      orgId: 'org_tenant',
      providerMode: 'live',
    });
    expect(orgLive).toHaveLength(1);
    expect(orgLive[0]!.n).toBe(3);
  });

  it('publish: platform save lands org-NULL with live-only provenance + suiteContentHash; the org chain never moves', async () => {
    await plantAdversarialRows();
    const { table: prices } = loadPrices(pricesPath);

    // A tenant frontier exists first — the platform save must not fork or
    // advance it (version chains are SCOPE-EXACT).
    const orgAggs = await aggregatesFromEvalResults(db.db, CLUSTER, strategies, prices.version, {
      orgId: 'org_tenant',
      providerMode: 'live',
    });
    const orgSaved = await saveFrontier(db.db, CLUSTER, computeFrontier(orgAggs), 'recompute', prices.version, {
      orgId: 'org_tenant',
    });

    const items = loadSuite(CLUSTER).map((i) => ({
      itemId: i.id,
      prompt: i.prompt,
      reference: i.reference,
      scoring: i.scoring,
    }));
    const contentHash = suiteContentHash(items);
    const platformAggs = await aggregatesFromEvalResults(db.db, CLUSTER, strategies, prices.version, {
      providerMode: 'live',
    });
    const saved = await saveFrontier(
      db.db,
      CLUSTER,
      computeFrontier(platformAggs),
      'recompute',
      prices.version,
      { provenance: { suiteId: CLUSTER, suiteContentHash: contentHash } },
    );

    expect(saved.points.length).toBeGreaterThan(0);
    expect(saved.points.every((p) => p.providerMode === 'live')).toBe(true);
    expect(saved.points.every((p) => p.evidence?.suiteContentHash === contentHash)).toBe(true);

    // Scope exactness, read straight from the table: the platform row is
    // org-NULL and v1 of ITS chain; the org row still v1 of its own.
    const rows = await db.db.select().from(frontiers).where(eq(frontiers.clusterId, CLUSTER));
    const platformRows = rows.filter((r) => r.orgId === null);
    const orgRows = rows.filter((r) => r.orgId === 'org_tenant');
    expect(platformRows).toHaveLength(1);
    expect(platformRows[0]!.version).toBe(1);
    expect(platformRows[0]!.parentId).toBeNull();
    expect(orgRows).toHaveLength(1);
    expect(orgRows[0]!.id).toBe(orgSaved.id);

    // And the platform runs created ZERO org-attributed rows: the entire
    // non-NULL-org set for this cluster is exactly the tenant's own 3 rows
    // (its one run, three sampled items) — a set equality, not a WHERE-echo
    // (the first version of this assertion selected WHERE orgId IS NULL and
    // asserted orgId === null: vacuous; caught by the pre-spend review).
    const orgAttributed = await db.db
      .select()
      .from(evalResults)
      .where(and(eq(evalResults.clusterId, CLUSTER), isNotNull(evalResults.orgId)));
    expect(orgAttributed).toHaveLength(3);
    expect(orgAttributed.every((r) => r.orgId === 'org_tenant' && r.providerMode === 'live')).toBe(true);
  });
});
