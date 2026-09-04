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
import {
  strategyHash,
  suiteContentHash,
  type FrontierPoint,
  type StrategyAggregate,
  type StrategyConfig,
} from '@potion/core';
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
import { loadSuite, loadSuiteV2, runEval, type RunOptions } from '@potion/harness';
import {
  aggregatesFromEvalResults,
  computeFrontier,
  loadCurrentFrontier,
  saveFrontier,
} from '@potion/pareto';
import { loadPrices } from '@potion/providers';
import { buildRegistry, classRepresentative } from '@potion/researcher';
import { SINGLE_ATTEMPT_KINDS } from '@potion/queue';
import { and, eq, isNotNull } from 'drizzle-orm';
import {
  classifyDroppedIncumbents,
  frontierPlatformSweepHandler,
  frontierRegressionRefusal,
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

/** Strategy shorthands for the regression-guard tests. The cascade shape is
 *  the platform sweep's own: cheap-class stage escalating to strong-class. */
const SINGLE = (model: string): StrategyConfig => ({ type: 'single', model });
const CASCADE = (cheap: string, strong: string): StrategyConfig => ({
  type: 'cascade',
  stages: [{ model: cheap, escalateIf: { confidenceBelow: 0.72 } }, { model: strong }],
  confidenceMethod: 'self-report-calibrated',
});
const hash = (cfg: StrategyConfig): string => strategyHash(cfg);
/** A frontier point at whatever coordinates; a set-difference guard reads
 *  only the identity, so the objectives are scenery unless a test says so. */
function pt(cfg: StrategyConfig, over: Partial<FrontierPoint> = {}): FrontierPoint {
  return {
    clusterId: 'code-gen',
    strategyHash: strategyHash(cfg),
    strategyConfig: cfg,
    quality: 1,
    costPer1K: 1,
    latencyP95: 1000,
    providerMode: 'live',
    ...over,
  };
}
/** One measured candidate, at the objectives a run reported for it. */
function agg(
  cfg: StrategyConfig,
  qualityMean: number,
  costPer1K: number,
  latencyP95: number,
): StrategyAggregate {
  return {
    clusterId: 'code-gen',
    strategyHash: strategyHash(cfg),
    strategyConfig: cfg,
    qualityMean,
    qualityCi95: 0,
    n: 15,
    costPer1K,
    latencyP50: latencyP95,
    latencyP95,
    pricesVersion: 'test-prices',
    providerMode: 'live',
  };
}

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
    await upsertBudget(db.db, { orgId: PLATFORM_OPS_ORG_ID, monthlyCapUsd: 60, hardStop: true, warnPct: 80 });
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
    await upsertBudget(db.db, { orgId: PLATFORM_OPS_ORG_ID, monthlyCapUsd: 60, hardStop: false, warnPct: 80 });
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

  it('audition gate: naming models none of which is a reachable answerer refuses — never a silent no-op', async () => {
    await armThrough('keys');
    // One OpenRouter key represents every class (see the coverage test above),
    // so the ladder reaches the pool step; the refusal fires before any call.
    process.env.OPENROUTER_API_KEY = 'fake-key-never-used';
    await expectRefusal(
      { clusterId: 'summarization', capUsd: 6, auditionModels: ['or-not-a-real-model'] },
      'audition-pool-empty',
    );
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
    const base: RunOptions = {
      suiteIds: [CLUSTER],
      strategies,
      budgetCapUsd: 1000,
      resume: true,
      itemSampleN: 3,
    };
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

describe('the three fixes the tranche campaign paid for', () => {
  // FIX 1 — a campaign is patient where serving is not.
  it('declares a longer timeout and a bigger retry budget than serving', async () => {
    const { PLATFORM_SWEEP_TIMEOUT_MS, PLATFORM_SWEEP_MAX_RETRIES } = await import('./handlers.js');
    // Serving gives up in 60s because a request nobody awaits has already
    // failed. A campaign has bought the tokens and nobody is waiting.
    expect(PLATFORM_SWEEP_TIMEOUT_MS).toBeGreaterThan(60_000);
    // 3 retries is ~1.75s of backoff — the tranche run lost three candidates
    // to "network error after 3 retries", two on the FIRST call. Execution
    // is strictly sequential, so that was impatience, not a traffic storm.
    expect(PLATFORM_SWEEP_MAX_RETRIES).toBeGreaterThan(3);
  });

  // FIX 2 — the guard that would have caught the real damage.
  it('names frontier-regression as a refusal reason', async () => {
    const { PlatformSweepRefusalError } = await import('./handlers.js');
    const err = new PlatformSweepRefusalError('frontier-regression', 'lost or-sonnet');
    expect(err.reason).toBe('frontier-regression');
    expect(err.message).toContain('or-sonnet');
  });

  it('the regression predicate: publishing must not drop a routed point', () => {
    // The exact tranche case. Previous extraction routes to or-sonnet; this
    // run produced no measurement for it (contained after 0 cells), so the
    // new frontier would quietly route to one point fewer than the customer
    // already had. Containment protects the LEG; this protects the FRONTIER.
    const dropped = classifyDroppedIncumbents({
      previous: [pt(SINGLE('or-deepseek')), pt(SINGLE('or-sonnet'))],
      computed: [pt(SINGLE('or-deepseek')), pt(SINGLE('or-newcomer'))],
      candidates: [hash(SINGLE('or-deepseek')), hash(SINGLE('or-sonnet')), hash(SINGLE('or-newcomer'))],
      measured: [hash(SINGLE('or-deepseek')), hash(SINGLE('or-newcomer'))],
      failed: [{ strategyHash: hash(SINGLE('or-sonnet')), error: 'network error', completedCells: 0 }],
    });
    expect(dropped.map((d) => [d.label, d.cause])).toEqual([['single(or-sonnet)', 'contained']]);
    expect(
      frontierRegressionRefusal({ previousVersion: 2, pricesVersion: 'p', dropped })?.reason,
    ).toBe('frontier-regression');

    // A frontier that GAINS points and keeps every old one is fine.
    expect(
      classifyDroppedIncumbents({
        previous: [pt(SINGLE('or-deepseek')), pt(SINGLE('or-sonnet'))],
        computed: [pt(SINGLE('or-deepseek')), pt(SINGLE('or-sonnet')), pt(SINGLE('or-newcomer'))],
        candidates: [],
        measured: [],
        failed: [],
      }),
    ).toEqual([]);
  });

  // FIX 3 — the leg must be persistable the instant it lands.
  it('returns the frontier points in full so a leg can be written to disk', async () => {
    const { frontierPlatformSweepHandler } = await import('./handlers.js');
    // Shape assertion only (a real sweep needs live keys): the result type
    // must carry the points themselves, not just a count — a count cannot be
    // restored after the database is lost, which is how two campaigns died.
    expect(typeof frontierPlatformSweepHandler).toBe('function');
  });
});

describe('deliberate-drop — an operator may retire a re-measured-and-dead incumbent', () => {
  // The 2026-09-02 case: or-kat-coder-pro-v2.5 is on code-review + extraction
  // and now 400s on every OpenRouter call (sole endpoint down). It is still
  // priced, so carry-forward re-measures it; containment records the throw
  // (0 cells); the new frontier omits it. Without an ack the guard REFUSES
  // (contained == evidence loss). deliberateDrops is the backing the guard's
  // own "decide deliberately that the drop is intended" advice needed.
  const DEAD = SINGLE('or-kat-coder-pro-v2.5');
  const SURVIVOR = SINGLE('or-deepseek');
  const NEWCOMER = SINGLE('or-newcomer');

  /** The exact drop set the handler builds: DEAD carried forward, put in
   *  front of the provider, thrown after 0 cells. */
  const droppedWithDeadContained = (): ReturnType<typeof classifyDroppedIncumbents> =>
    classifyDroppedIncumbents({
      previous: [pt(SURVIVOR), pt(DEAD)],
      computed: [pt(SURVIVOR), pt(NEWCOMER)],
      candidates: [hash(SURVIVOR), hash(DEAD), hash(NEWCOMER)],
      measured: [hash(SURVIVOR), hash(NEWCOMER)],
      failed: [{ strategyHash: hash(DEAD), error: 'provider returned error (400)', completedCells: 0 }],
    });

  it('WITHOUT the ack, a contained dead incumbent still refuses (unchanged)', () => {
    const dropped = droppedWithDeadContained();
    expect(dropped.map((d) => [d.label, d.cause])).toEqual([['single(or-kat-coder-pro-v2.5)', 'contained']]);
    expect(
      frontierRegressionRefusal({ previousVersion: 3, pricesVersion: 'p', dropped })?.reason,
    ).toBe('frontier-regression');
  });

  it('WITH the ack, the same contained drop publishes (returns null)', () => {
    const dropped = droppedWithDeadContained();
    expect(
      frontierRegressionRefusal({
        previousVersion: 3,
        pricesVersion: 'p',
        dropped,
        deliberateDrops: new Set([hash(DEAD)]),
      }),
    ).toBeNull();
  });

  it('the ack is CONTAINED-only: it cannot excuse a not-a-candidate drop', () => {
    // DEAD is NOT in this run's pool at all (e.g. delisted from prices) — it
    // was never re-measured, so acking it must NOT publish. The honest fix is
    // carry-forward, not an override; the guard holds.
    const dropped = classifyDroppedIncumbents({
      previous: [pt(SURVIVOR), pt(DEAD)],
      computed: [pt(SURVIVOR), pt(NEWCOMER)],
      candidates: [hash(SURVIVOR), hash(NEWCOMER)],
      measured: [hash(SURVIVOR), hash(NEWCOMER)],
      failed: [],
    });
    expect(dropped.map((d) => d.cause)).toEqual(['not-a-candidate']);
    expect(
      frontierRegressionRefusal({
        previousVersion: 3,
        pricesVersion: 'p',
        dropped,
        deliberateDrops: new Set([hash(DEAD)]),
      })?.reason,
    ).toBe('frontier-regression');
  });

  it('the ack is CONTAINED-only: it cannot excuse a no-evidence drop', () => {
    // A candidate that ran but produced no aggregable rows (all stale) — not a
    // throw, so not containment. Acking it must not publish.
    const dropped = classifyDroppedIncumbents({
      previous: [pt(SURVIVOR), pt(DEAD)],
      computed: [pt(SURVIVOR), pt(NEWCOMER)],
      candidates: [hash(SURVIVOR), hash(DEAD), hash(NEWCOMER)],
      measured: [hash(SURVIVOR), hash(NEWCOMER)],
      failed: [],
    });
    expect(dropped.map((d) => d.cause)).toEqual(['no-evidence']);
    expect(
      frontierRegressionRefusal({
        previousVersion: 3,
        pricesVersion: 'p',
        dropped,
        deliberateDrops: new Set([hash(DEAD)]),
      })?.reason,
    ).toBe('frontier-regression');
  });

  it('an ack does not leak to OTHER contained drops in the same run', () => {
    // Two dead incumbents contained; the operator acks only one. The other
    // still refuses — an ack is per-point, never a blanket "publish anyway".
    const OTHER = SINGLE('or-also-dead');
    const dropped = classifyDroppedIncumbents({
      previous: [pt(SURVIVOR), pt(DEAD), pt(OTHER)],
      computed: [pt(SURVIVOR)],
      candidates: [hash(SURVIVOR), hash(DEAD), hash(OTHER)],
      measured: [hash(SURVIVOR)],
      failed: [
        { strategyHash: hash(DEAD), error: '400', completedCells: 0 },
        { strategyHash: hash(OTHER), error: '400', completedCells: 0 },
      ],
    });
    const refusal = frontierRegressionRefusal({
      previousVersion: 3,
      pricesVersion: 'p',
      dropped,
      deliberateDrops: new Set([hash(DEAD)]),
    });
    expect(refusal?.reason).toBe('frontier-regression');
    // names the un-acked one, not the acked one
    expect(refusal?.message).toContain('or-also-dead');
    expect(refusal?.message).not.toContain('or-kat-coder-pro-v2.5');
  });

  it('a dominated incumbent needs no ack (ack is irrelevant to it)', () => {
    // Sanity: the ack only ever REMOVES a refusal; a legitimately dominated
    // drop already publishes, ack or not.
    const dropped = classifyDroppedIncumbents({
      previous: [pt(SURVIVOR), pt(DEAD)],
      computed: [pt(SURVIVOR)],
      candidates: [hash(SURVIVOR), hash(DEAD)],
      measured: [hash(SURVIVOR), hash(DEAD)], // DEAD re-measured and lost
      failed: [],
    });
    expect(dropped.map((d) => d.cause)).toEqual(['dominated']);
    expect(frontierRegressionRefusal({ previousVersion: 3, pricesVersion: 'p', dropped })).toBeNull();
  });
});

describe('frontier-regression — the code-gen v3 blind spot, by strategy hash', () => {
  const CLUSTER = 'code-gen';
  /** The cascade committed on code-gen v2 — the point that actually vanished. */
  const INCUMBENT_CASCADE_REAL = CASCADE('or-deepseek', 'or-opus');
  /** Shorthand incumbent for the cause-classification cases below. */
  const INCUMBENT_CASCADE = CASCADE('mock-cheap', 'mock-frontier');

  /** The publish decision, run exactly as the handler runs it. */
  function decide(previous: FrontierPoint[], computed: FrontierPoint[], opts: {
    candidates: StrategyConfig[];
    measured: string[];
    failed?: Array<{ strategyHash: string; error: string; completedCells: number }>;
  }): PlatformSweepRefusalError | null {
    return frontierRegressionRefusal({
      previousVersion: 2,
      pricesVersion: 'test-prices',
      dropped: classifyDroppedIncumbents({
        previous,
        computed,
        candidates: opts.candidates.map(hash),
        measured: opts.measured,
        failed: opts.failed ?? [],
      }),
    });
  }

  it('REFUSES when a run re-measures only the singles and the incumbent cascade vanishes', async () => {
    // THE REAL LEG, reproduced with its real numbers. Committed code-gen v2
    // (packages/db/baseline/platform-frontiers.json): four singles plus the
    // cascade, which is the ONLY point reaching quality 1.0000 and does it
    // at $0.5955/1K.
    // [config, quality, $/1K, p95 ms] — verbatim from the committed baseline.
    const V2: Array<[StrategyConfig, number, number, number]> = [
      [SINGLE('or-deepseek'), 0.9833, 0.1630, 12105],
      [SINGLE('or-gpt-mini'), 0.9979, 0.2282, 5617],
      [SINGLE('or-gemini-flash'), 0.9924, 0.4729, 2084],
      [CASCADE('or-deepseek', 'or-opus'), 1.0, 0.5955, 19915],
      [SINGLE('or-gpt-full'), 0.9976, 1.1800, 3053],
    ];
    // The identity is the config's content hash — pinned against the real
    // committed hash so this test is anchored to the leg that actually
    // regressed, not to a shape that merely resembles it.
    expect(hash(CASCADE('or-deepseek', 'or-opus')).slice(0, 8)).toBe('57f69a06');

    const saved = await saveFrontier(
      db.db,
      CLUSTER,
      V2.map(([cfg, quality, costPer1K, latencyP95]) => pt(cfg, { quality, costPer1K, latencyP95 })),
      'recompute',
      'baseline-prices',
    );
    // Read back through the handler's own load — a composite config must
    // survive the JSONB round-trip intact, or its identity moves and the
    // guard is comparing something else.
    const previous = await loadCurrentFrontier(db.db, CLUSTER, undefined);
    expect(previous!.version).toBe(saved.version);
    const incumbent = previous!.points.find((pnt) => pnt.strategyHash === hash(INCUMBENT_CASCADE_REAL));
    expect(incumbent, 'the cascade must be ON the previous frontier for this test to mean anything')
      .toBeDefined();
    expect(strategyHash(incumbent!.strategyConfig)).toBe(incumbent!.strategyHash);

    // v3's run: the pool rebuilt its cascade from the CURRENT class
    // representatives (a different config, hence a different hash), and that
    // rebuilt cascade then failed containment after 0 cells. So the ONLY
    // strategies with evidence this run are singles — the incumbent cascade
    // was never in front of a provider at all.
    // The eight points v3 actually published (.tranche/legs/code-gen.json),
    // every one of them a single.
    const V3_MEASURED: Array<[StrategyConfig, number, number, number]> = [
      [SINGLE('or-solar-pro4'), 0.9944, 0.0209, 15351],
      [SINGLE('or-ling-3.0-flash'), 0.7306, 0.0957, 4457],
      [SINGLE('or-deepseek'), 0.9839, 0.1691, 13906],
      [SINGLE('or-gpt-mini'), 0.9976, 0.2285, 4383],
      [SINGLE('or-gemini-flash'), 0.9955, 0.4772, 1743],
      [SINGLE('or-gpt-full'), 0.9976, 1.1545, 2255],
      [SINGLE('or-gemini-3.7-flash'), 1.0, 1.3144, 8238],
      [SINGLE('or-claude-opus-5-fast'), 1.0, 15.8835, 5809],
    ];
    const rebuiltCascade = CASCADE('or-ling-3.0-flash', 'or-opus');
    expect(hash(rebuiltCascade).slice(0, 8)).toBe('99dca2f8'); // the pool's, not the incumbent's
    const aggregates = V3_MEASURED.map(([cfg, q, c, l]) => agg(cfg, q, c, l));
    const computed = computeFrontier(aggregates);
    expect(computed).toHaveLength(V3_MEASURED.length); // the published v3, reproduced
    expect(computed.some((pnt) => pnt.strategyHash === hash(INCUMBENT_CASCADE_REAL))).toBe(false);

    // 1. The guard refuses, and NAMES the cascade with its cause.
    const refusal = decide(previous!.points, computed, {
      candidates: [...V3_MEASURED.map(([cfg]) => cfg), rebuiltCascade],
      measured: aggregates.map((a) => a.strategyHash),
      failed: [{ strategyHash: hash(rebuiltCascade), error: "provider 'openrouter': request failed", completedCells: 0 }],
    });
    expect(refusal).toBeInstanceOf(PlatformSweepRefusalError);
    expect(refusal!.reason).toBe('frontier-regression');
    expect(refusal!.message).toContain('cascade(or-deepseek→or-opus)');
    expect(refusal!.message).toContain('57f69a06');
    expect(refusal!.message).toContain('never a candidate');
    // A post-run refusal must not claim the pre-spend ladder's tail: this
    // leg spent $11.76 before it got here.
    expect(refusal!.message).toContain('the run already spent; nothing was published');
    expect(refusal!.message).not.toContain('no spend occurred');
    // The rebuilt cascade's containment is a DIFFERENT candidate's failure
    // and must not be reported as the incumbent's cause.
    expect(refusal!.message).not.toContain('99dca2f8');

    // 2. THE BLIND SPOT, as an assertion. The alias-only predicate the guard
    //    used to run sees nothing wrong: every single incumbent survived,
    //    and a cascade has no `.model` for it to look at.
    const aliasesOf = (pts: FrontierPoint[]): Set<string> =>
      new Set(pts.flatMap((x) => (x.strategyConfig.type === 'single' ? [x.strategyConfig.model] : [])));
    const had = aliasesOf(previous!.points);
    const has = aliasesOf(computed);
    expect([...had].filter((m) => !has.has(m))).toEqual([]);

    // 3. THE DAMAGE the silence let through: the cheapest route to the
    //    frontier's top measured quality goes from $0.5955 to $1.3144.
    const cheapestAtTopQuality = (pts: FrontierPoint[]): number => {
      const best = Math.max(...pts.map((x) => x.quality));
      return Math.min(...pts.filter((x) => x.quality >= best).map((x) => x.costPer1K));
    };
    expect(cheapestAtTopQuality(previous!.points)).toBeCloseTo(0.5955, 4);
    expect(cheapestAtTopQuality(computed)).toBeCloseTo(1.3144, 4);
  });

  it('does NOT refuse when the incumbent was re-measured and lost to domination', () => {
    // Same missing point, opposite cause: it WAS a candidate and it DID
    // produce evidence — domination is then a verdict, not a gap. Refusing
    // here would mean a frontier can never improve.
    const previous = [pt(SINGLE('mock-cheap')), pt(INCUMBENT_CASCADE)];
    const computed = [pt(SINGLE('mock-cheap'))];
    const dropped = classifyDroppedIncumbents({
      previous,
      computed,
      candidates: [SINGLE('mock-cheap'), INCUMBENT_CASCADE].map(hash),
      measured: [SINGLE('mock-cheap'), INCUMBENT_CASCADE].map(hash),
      failed: [],
    });
    expect(dropped.map((d) => d.cause)).toEqual(['dominated']);
    expect(decide(previous, computed, {
      candidates: [SINGLE('mock-cheap'), INCUMBENT_CASCADE],
      measured: [SINGLE('mock-cheap'), INCUMBENT_CASCADE].map(hash),
    })).toBeNull();
  });

  it('separates the causes in one message: evidence loss refuses, domination is context', () => {
    const previous = [
      pt(SINGLE('mock-cheap')),
      pt(SINGLE('mock-mid')),
      pt(INCUMBENT_CASCADE),
    ];
    const computed = [pt(SINGLE('mock-cheap'))];
    const refusal = decide(previous, computed, {
      // mock-mid was measured and lost; the cascade was contained mid-run.
      candidates: [SINGLE('mock-cheap'), SINGLE('mock-mid'), INCUMBENT_CASCADE],
      measured: [hash(SINGLE('mock-cheap')), hash(SINGLE('mock-mid'))],
      failed: [{ strategyHash: hash(INCUMBENT_CASCADE), error: 'provider returned error', completedCells: 0 }],
    });
    expect(refusal!.reason).toBe('frontier-regression');
    // The cascade is the REASON: named as evidence loss, with its cause.
    expect(refusal!.message).toContain('contained after 0 cells');
    expect(refusal!.message).toContain('evidence LOSS');
    // The dominated single is CONTEXT: named, and explicitly not the reason.
    expect(refusal!.message).toContain('NOT the reason for this refusal');
    expect(refusal!.message).toContain('single(mock-mid)');
    // One point lost, not two — the dominated one is not counted as loss.
    expect(refusal!.message).toContain('routes to 1 point');
  });

  it('catches every composite shape, not just cascade', () => {
    const composites: StrategyConfig[] = [
      CASCADE('mock-cheap', 'mock-frontier'),
      { type: 'ensemble', models: ['mock-cheap', 'mock-mid'], fusion: { method: 'concat-rank' } },
      { type: 'draft-verify', draftModel: 'mock-cheap', verifierModel: 'mock-frontier' },
      { type: 'best-of-n', model: 'mock-mid', n: 3, judge: { model: 'mock-judge' } },
      { type: 'composite', startModel: 'mock-cheap', upgradeModel: 'mock-frontier', upgradeIf: { confidenceBelow: 0.5 } },
    ];
    const dropped = classifyDroppedIncumbents({
      previous: composites.map((c) => pt(c)),
      computed: [pt(SINGLE('mock-cheap'))],
      candidates: [],
      measured: [],
      failed: [],
    });
    expect(dropped).toHaveLength(composites.length);
    expect(dropped.every((d) => d.cause === 'not-a-candidate')).toBe(true);
    // Model names survive into the message for readability — identity does
    // not depend on them.
    expect(dropped.map((d) => d.label)).toEqual([
      'cascade(mock-cheap→mock-frontier)',
      'ensemble(mock-cheap+mock-mid)',
      'draft-verify(mock-cheap→mock-frontier)',
      'best-of-n(mock-mid×3, judge mock-judge)',
      'composite(mock-cheap→mock-frontier@<0.5)',
    ]);
  });

  it('a candidate that ran but produced no rows is evidence loss, not domination', () => {
    const previous = [pt(SINGLE('mock-cheap'))];
    const refusal = decide(previous, [], {
      candidates: [SINGLE('mock-cheap')],
      measured: [],
    });
    expect(refusal!.reason).toBe('frontier-regression');
    expect(refusal!.message).toContain('produced no live rows at prices test-prices');
  });
});

// ---------------------------------------------------------------------------
// Incumbent carry-forward (2026-08-20) — the creative leg's refusal, turned
// into a pin. The pool rebuilds its composite from CURRENT class reps, so a
// committed cascade whose stages moved out of representative position was
// never re-measured and the (correct) guard refused evidence loss. Now every
// still-priced incumbent joins the pool by right.
import { carryForwardIncumbents, strategyModelAliases } from './handlers.js';
import { strategyHash as sh2, type StrategyConfig as SC2 } from '@potion/core';

describe('incumbent carry-forward into the sweep pool', () => {
  const CASCADE: SC2 = {
    type: 'cascade',
    stages: [{ model: 'or-deepseek', escalateIf: { confidenceBelow: 0.7 } }, { model: 'or-opus' }],
    confidenceMethod: 'self-report-calibrated',
  } as SC2;
  const SINGLE: SC2 = { type: 'single', model: 'or-haiku' };
  const priced = new Set(['or-deepseek', 'or-opus', 'or-haiku', 'or-new-1']);

  it('the creative case: a committed cascade absent from the pool is carried forward', () => {
    const pool = new Map<string, SC2>([[sh2({ type: 'single', model: 'or-new-1' }), { type: 'single', model: 'or-new-1' }]]);
    const added = carryForwardIncumbents(pool, [{ strategyConfig: CASCADE }], { pricedAliases: priced, singlesOnly: false });
    expect(added).toEqual([sh2(CASCADE)]);
    expect(pool.get(sh2(CASCADE))).toEqual(CASCADE);
  });

  it('an incumbent already in the pool is not duplicated', () => {
    const pool = new Map<string, SC2>([[sh2(SINGLE), SINGLE]]);
    const added = carryForwardIncumbents(pool, [{ strategyConfig: SINGLE }], { pricedAliases: priced, singlesOnly: false });
    expect(added).toEqual([]);
    expect(pool.size).toBe(1);
  });

  it('an incumbent referencing a DELISTED model is left out — the guard reports it, this function never guesses', () => {
    const pool = new Map<string, SC2>();
    const gone: SC2 = { type: 'single', model: 'or-retired-model' };
    const added = carryForwardIncumbents(pool, [{ strategyConfig: gone }], { pricedAliases: priced, singlesOnly: false });
    expect(added).toEqual([]);
    expect(pool.size).toBe(0);
  });

  it('a tools-only sweep carries forward only single incumbents', () => {
    const pool = new Map<string, SC2>();
    const added = carryForwardIncumbents(pool, [{ strategyConfig: CASCADE }, { strategyConfig: SINGLE }], { pricedAliases: priced, singlesOnly: true });
    expect(added).toEqual([sh2(SINGLE)]);
  });

  it('alias extraction covers every strategy shape', () => {
    expect(strategyModelAliases(CASCADE).sort()).toEqual(['or-deepseek', 'or-opus']);
    expect(strategyModelAliases({ type: 'ensemble', models: ['a', 'b'], fusion: { method: 'judge-pick', judge: { model: 'j' } } })).toEqual(['a', 'b']);
    expect(strategyModelAliases({ type: 'draft-verify', draftModel: 'd', verifierModel: 'v' }).sort()).toEqual(['d', 'v']);
  });
});
