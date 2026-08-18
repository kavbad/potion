// Autoresearcher worker tests (M4b #37, SPEC §15) — PGlite + tmp prices.json,
// zero network. Covers: research:scan (mock fixture diff + registry persist +
// cycle enqueue + idempotency + live-source guard), research:cycle (mock
// candidate generation + sweep + ledger row + candidate shortlisting +
// eval-cache pruning), single-recipe narrowing, and the §15.4 promotion gate
// end-to-end (seeded LIVE heldout rows → paired bootstrap → frontier version
// + lifecycle flips + alert fan-out; bootstrap publish with no incumbent).
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { strategyHash, type EvalResult, type StrategyConfig } from '@potion/core';
import {
  loadModelRegistry,
  alertDeliveries,
  alertRules,
  createDb,
  createOrg,
  DEFAULT_ORG_ID,
  evalResults,
  getRecipeStatusByHashes,
  getResearchCycle,
  insertEvalResult,
  insertResearchCycle,
  insertTraceSpans,
  migrate,
  recipeStatus,
  strategyConfigs,
  type DbHandle,
  type NewTraceSpan,
} from '@potion/db';
import { loadCurrentFrontier, saveFrontier } from '@potion/pareto';
import { cacheKeyOf, loadSuiteV2 } from '@potion/harness';
import { loadPrices } from '@potion/providers';
import { inArray } from 'drizzle-orm';
import {
  orgHashOf,
  researchCycleHandler,
  researchScanHandler,
  RESEARCH_V2_SUITE_IDS,
  toolSignatureSlug,
  tracesClusterHandler,
  type JobContext,
} from './handlers.js';
import type { PotionQueue } from '@potion/queue';

const REPO_PRICES = fileURLToPath(new URL('../../../prices.json', import.meta.url));

let root: string;
let pricesPath: string;
let db: DbHandle;

beforeEach(async () => {
  root = mkdtempSync(path.join(tmpdir(), 'potion-research-'));
  pricesPath = path.join(root, 'prices.json');
  copyFileSync(REPO_PRICES, pricesPath);
  db = await createDb();
  await migrate(db.db);
});

afterEach(async () => {
  await db.close();
  rmSync(root, { recursive: true, force: true });
  delete process.env.POTION_RESEARCH_PROVIDER;
  delete process.env.OPENROUTER_API_KEY;
});

function ctx(queue?: PotionQueue): JobContext {
  return {
    db: db.db,
    dbHandle: db,
    pricesPath,
    ...(queue !== undefined ? { queue } : {}),
  };
}

/** Queue stub capturing enqueues. */
function stubQueue() {
  const calls: { kind: string; payload: unknown }[] = [];
  const queue = {
    enqueue: async (kind: string, payload: unknown) => {
      calls.push({ kind, payload });
      return `job-${calls.length}`;
    },
  } as unknown as PotionQueue;
  return { queue, calls };
}

// ---------------------------------------------------------------------------
// research:scan (SPEC §15.2)
// ---------------------------------------------------------------------------

describe('research:scan', () => {
  it('mock source: diffs fixture, persists registry, lists cycle foci', async () => {
    const res = await researchScanHandler({ source: 'mock' }, ctx());
    expect(res.source).toBe('mock');
    expect(res.added).toEqual(['or-mock-nova-1', 'or-mock-apex-1']);
    expect(res.alreadyKnown).toBe(1); // mock-cheap-v1
    expect(res.skippedNoPricing).toEqual(['mock/mock-free-0']);
    expect(res.pricesVersion).toContain('+or-mock-nova-1');
    expect(res.cyclesEnqueued).toEqual(['or-mock-nova-1', 'or-mock-apex-1']);

    // S5: the registry is the DATABASE now, not the file. A scan used to
    // writeFileSync into prices.json, which meant every discovery died on the
    // next redeploy and never reached the running process anyway (loadPrices
    // runs once at boot). Same assertions — pricing converted per-token × 1e6
    // → per-1M — read from where the catalog actually lives.
    const merged = (await loadModelRegistry(db.db))!;
    const nova = merged.entries.find((e) => e.alias === 'or-mock-nova-1');
    expect(nova?.inputPer1M).toBeCloseTo(0.2, 12);
    const apex = merged.entries.find((e) => e.alias === 'or-mock-apex-1');
    expect(apex?.inputPer1M).toBeCloseTo(12, 12);
  });

  it('enqueues research:cycle per new alias on the queue; re-scan is a no-op', async () => {
    const { queue, calls } = stubQueue();
    const res = await researchScanHandler({ source: 'mock' }, ctx(queue));
    expect(res.cyclesEnqueued.length).toBe(2);
    expect(calls.map((c) => c.kind)).toEqual(['research:cycle', 'research:cycle']);
    expect((calls[0]!.payload as { focusAlias: string }).focusAlias).toBe('or-mock-nova-1');
    expect((calls[0]!.payload as { trigger: string }).trigger).toBe('scan');

    const again = await researchScanHandler({ source: 'mock' }, ctx(queue));
    expect(again.added).toEqual([]);
    expect(again.cyclesEnqueued).toEqual([]);
    expect(calls.length).toBe(2); // nothing new enqueued
  });

  it("source 'openrouter' without a key fails with a clear error", async () => {
    await expect(researchScanHandler({ source: 'openrouter' }, ctx())).rejects.toThrow(
      'OPENROUTER_API_KEY',
    );
  });
});

// ---------------------------------------------------------------------------
// research:cycle — mock (SPEC §15.3): shortlist, never promote
// ---------------------------------------------------------------------------

describe('research:cycle (mock)', () => {
  it('generates, sweeps, ledgers — and never promotes from mock evidence', async () => {
    // Scan first so the focus alias exists in the tmp registry.
    await researchScanHandler({ source: 'mock' }, ctx());

    const res = await researchCycleHandler(
      { focusAlias: 'or-mock-nova-1', trigger: 'scan', seed: 42 },
      ctx(),
    );
    expect(res.candidates).toBeGreaterThan(0);
    expect(res.suitesRun).toEqual([...RESEARCH_V2_SUITE_IDS]);
    expect(res.provenance).toBe('mock');
    expect(res.promotions).toEqual([]);
    expect(res.stoppedEarly).toBe(false);

    // Ledger row: completed, seeded, candidates persisted.
    const row = await getResearchCycle(db.db, res.cycleId);
    expect(row?.status).toBe('completed');
    expect(row?.seed).toBe(42);
    expect(row?.trigger).toBe('scan');
    expect(row?.focusAlias).toBe('or-mock-nova-1');
    expect((row?.candidates as unknown[]).length).toBe(res.candidates);
    expect(row?.completedAt).not.toBeNull();

    // Every candidate: strategy_configs registered + recipe_status candidate
    // with the sticky firstCycleId.
    const statuses = await getRecipeStatusByHashes(db.db, res.candidateHashes);
    expect(statuses.size).toBe(res.candidates);
    for (const [, s] of statuses) {
      expect(s.status).toBe('candidate');
      expect(s.firstCycleId).toBe(res.cycleId);
    }
    const configs = await db.db
      .select()
      .from(strategyConfigs)
      .where(inArray(strategyConfigs.hash, res.candidateHashes));
    expect(configs.length).toBe(res.candidates);

    // Mock cycles publish NOTHING: no frontier rows appeared.
    expect(await loadCurrentFrontier(db.db, 'code-gen')).toBeNull();
    expect(await loadCurrentFrontier(db.db, 'extraction')).toBeNull();
  }, 30_000);

  it('prunes already-evaluated candidates (eval-cache cells) on the next cycle', async () => {
    await researchScanHandler({ source: 'mock' }, ctx());
    const first = await researchCycleHandler(
      { focusAlias: 'or-mock-nova-1', trigger: 'scan', seed: 42 },
      ctx(),
    );
    expect(first.candidates).toBeGreaterThan(0);

    const second = await researchCycleHandler(
      { focusAlias: 'or-mock-nova-1', trigger: 'schedule', seed: 43 },
      ctx(),
    );
    expect(second.candidates).toBe(0);
    expect(second.stopReason).toContain('no new candidates');
  }, 60_000);

  it('recipeHash narrows the cycle to one registered recipe; unknown hash throws', async () => {
    const config: StrategyConfig = { type: 'single', model: 'mock-cheap' };
    const hash = strategyHash(config);
    await db.db.insert(strategyConfigs).values({ hash, config }).onConflictDoNothing();

    const res = await researchCycleHandler({ recipeHash: hash, trigger: 'manual', seed: 7 }, ctx());
    expect(res.candidates).toBe(1);
    expect(res.candidateHashes).toEqual([hash]);
    expect(res.suitesRun.length).toBe(2);

    await expect(
      researchCycleHandler({ recipeHash: 'sha-nope', trigger: 'manual' }, ctx()),
    ).rejects.toThrow('unknown recipe hash');
  });
});

// ---------------------------------------------------------------------------
// §15.4 promotion gate — seeded LIVE heldout evidence
// ---------------------------------------------------------------------------

const CODEGEN_SUITE = 'code-gen-humaneval-js-v1';
const EXTRACTION_SUITE = 'extraction-authored-v1';

/** Seed live-provenance eval rows for `config` over every item of a v2 suite
 * at the registry's current prices version. Rows use the runner's own cache
 * key formula, so a later mock sweep sees the cells as occupied (mock
 * recomputes but never overwrites) and aggregates stay purely live. */
async function seedLiveRows(
  config: StrategyConfig,
  suiteId: string,
  quality: number,
  costUsd: number,
  runId: string,
): Promise<string> {
  const { table: prices } = loadPrices(pricesPath);
  const suite = loadSuiteV2(suiteId);
  const hash = strategyHash(config);
  for (const item of suite.items) {
    const result: EvalResult = {
      runId,
      itemId: item.id,
      clusterId: item.clusterId,
      strategyHash: hash,
      strategyConfig: config,
      quality,
      scorer: 'exact',
      usage: { inputTokens: 100, outputTokens: 50, costUsd, latencyMs: 10 },
      latencyMs: { p50: 10, p95: 10, mean: 10 },
      modelVersions: {},
      pricesVersion: prices.version,
      providerMode: 'live',
      cacheKey: cacheKeyOf(hash, item, item.scoring, prices),
      createdAt: new Date().toISOString(),
    };
    await insertEvalResult(db.db, result);
  }
  return hash;
}

describe('research:cycle promotion gate (SPEC §15.4)', () => {
  it('promotes a live-verified candidate: frontier v2, lifecycle flips, alert fan-out', async () => {
    const incumbent: StrategyConfig = { type: 'single', model: 'mock-cheap' };
    const candidate: StrategyConfig = { type: 'single', model: 'mock-mid' };
    // Candidate: +5pts at equal cost on the SAME items → quality path.
    const incHash = await seedLiveRows(incumbent, CODEGEN_SUITE, 0.8, 0.001, 'live-run-inc');
    const candHash = await seedLiveRows(candidate, CODEGEN_SUITE, 0.85, 0.001, 'live-run-cand');
    await db.db
      .insert(strategyConfigs)
      .values([
        { hash: incHash, config: incumbent },
        { hash: candHash, config: candidate },
      ])
      .onConflictDoNothing();

    // Current frontier v1 = the incumbent alone.
    await saveFrontier(
      db.db,
      'code-gen',
      [
        {
          clusterId: 'code-gen',
          strategyHash: incHash,
          strategyConfig: incumbent,
          quality: 0.8,
          costPer1K: 1,
          latencyP95: 10,
          providerMode: 'live',
        },
      ],
      'manual',
      loadPrices(pricesPath).table.version,
    );

    // An org subscribed to recipe_promoted (dead URL → delivery row, failed,
    // secrets redacted — enough to prove the fan-out path).
    await db.db.insert(alertRules).values({
      orgId: DEFAULT_ORG_ID,
      kind: 'webhook',
      targetUrl: 'http://127.0.0.1:1/hook?secret=topsecret',
      events: ['recipe_promoted'],
    });

    const res = await researchCycleHandler(
      { recipeHash: candHash, trigger: 'manual', seed: 7, suiteV2Ids: [CODEGEN_SUITE] },
      ctx(),
    );

    expect(res.promotions.length).toBe(1);
    const promo = res.promotions[0]!;
    expect(promo.clusterId).toBe('code-gen');
    expect(promo.strategyHash).toBe(candHash);
    expect(promo.path).toBe('quality');
    expect(promo.frontierVersion).toBe(2);

    // New frontier version chained off v1; incumbent (dominated: +5pts at
    // equal cost) fell off.
    const frontier = await loadCurrentFrontier(db.db, 'code-gen');
    expect(frontier?.version).toBe(2);
    expect(frontier?.parentId).not.toBeNull();
    const hashes = frontier!.points.map((p) => p.strategyHash);
    expect(hashes).toContain(candHash);
    expect(hashes).not.toContain(incHash);

    // Lifecycle: candidate → frontier; fallen incumbent → archived.
    const statuses = await getRecipeStatusByHashes(db.db, [candHash, incHash]);
    expect(statuses.get(candHash)?.status).toBe('frontier');
    expect(statuses.get(incHash)?.status).toBe('archived');

    // Alert fan-out: one delivery row for the subscribed org, target secret
    // never copied into the audit row.
    const deliveries = await db.db.select().from(alertDeliveries);
    expect(deliveries.length).toBe(1);
    expect(deliveries[0]!.event).toBe('recipe_promoted');
    expect(JSON.stringify(deliveries[0])).not.toContain('topsecret');

    // The RUN was mock — the cycle row says so — while the PROMOTION was
    // driven purely by the seeded live evidence. This is the §15.3/§15.4
    // separation working as contracted.
    const row = await getResearchCycle(db.db, res.cycleId);
    expect(row?.provenance).toBe('mock');
  });

  it('holds when the CI overlaps the threshold (no publish, stays candidate)', async () => {
    const incumbent: StrategyConfig = { type: 'single', model: 'mock-cheap' };
    const candidate: StrategyConfig = { type: 'single', model: 'mock-mid' };
    // +0.5pts at equal cost: below the +1.5pt quality bar, no cost cut.
    const incHash = await seedLiveRows(incumbent, CODEGEN_SUITE, 0.8, 0.001, 'live-i');
    const candHash = await seedLiveRows(candidate, CODEGEN_SUITE, 0.805, 0.001, 'live-c');
    await db.db
      .insert(strategyConfigs)
      .values([
        { hash: incHash, config: incumbent },
        { hash: candHash, config: candidate },
      ])
      .onConflictDoNothing();
    await saveFrontier(
      db.db,
      'code-gen',
      [
        {
          clusterId: 'code-gen',
          strategyHash: incHash,
          strategyConfig: incumbent,
          quality: 0.8,
          costPer1K: 1,
          latencyP95: 10,
          providerMode: 'live',
        },
      ],
      'manual',
      loadPrices(pricesPath).table.version,
    );

    const res = await researchCycleHandler(
      { recipeHash: candHash, trigger: 'manual', seed: 7, suiteV2Ids: [CODEGEN_SUITE] },
      ctx(),
    );
    expect(res.promotions).toEqual([]);
    expect((await loadCurrentFrontier(db.db, 'code-gen'))?.version).toBe(1);
    const statuses = await getRecipeStatusByHashes(db.db, [candHash]);
    expect(statuses.get(candHash)?.status).toBe('candidate'); // held
  });

  it('bootstrap-publishes the first live frontier for a cluster (no incumbent)', async () => {
    const candidate: StrategyConfig = { type: 'single', model: 'mock-frontier' };
    const candHash = await seedLiveRows(candidate, EXTRACTION_SUITE, 0.9, 0.002, 'live-boot');
    await db.db.insert(strategyConfigs).values({ hash: candHash, config: candidate }).onConflictDoNothing();

    const res = await researchCycleHandler(
      { recipeHash: candHash, trigger: 'scan', seed: 9, suiteV2Ids: [EXTRACTION_SUITE] },
      ctx(),
    );
    expect(res.promotions.length).toBe(1);
    expect(res.promotions[0]!.path).toBe('bootstrap');
    expect(res.promotions[0]!.frontierVersion).toBe(1);
    const frontier = await loadCurrentFrontier(db.db, 'extraction');
    expect(frontier?.version).toBe(1);
    expect(frontier?.trigger).toBe('new-model'); // scan-triggered publish
    const statuses = await getRecipeStatusByHashes(db.db, [candHash]);
    expect(statuses.get(candHash)?.status).toBe('frontier');
  });
});

// ---------------------------------------------------------------------------
// research ledger sanity
// ---------------------------------------------------------------------------

describe('research ledger', () => {
  it('cycle rows carry spend + provenance independently of any M1b accounting', async () => {
    const cycle = await insertResearchCycle(db.db, { trigger: 'manual', seed: 1 });
    expect(cycle.spendUsd).toBe(0);
    expect(cycle.provenance).toBe('unknown');
    void cycle;
    const rows = await db.db.select().from(evalResults);
    expect(rows.length).toBe(0); // no eval evidence fabricated by ledgering
  });
});

// ---------------------------------------------------------------------------
// G1.8 — per-org research cycles
// ---------------------------------------------------------------------------

describe('research:cycle per-org (G1.8)', () => {
  const ORG = 'org_rc';

  function rcSpan(over: Partial<NewTraceSpan>): NewTraceSpan {
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

  const wordHash = (w: string) => {
    let h = 0;
    for (let i = 0; i < w.length; i++) h = (Math.imul(h, 31) + w.charCodeAt(i)) | 0;
    return Math.abs(h);
  };
  const embedder = {
    async embed(texts: string[]): Promise<number[][]> {
      return texts.map((t) => {
        const v = new Array<number>(384).fill(0);
        for (const w of t.toLowerCase().split(/[^a-z0-9]+/)) if (w.length > 0) v[wordHash(w) % 384]! += 1;
        const norm = Math.sqrt(v.reduce((s2, x) => s2 + x * x, 0)) || 1;
        return v.map((x) => x / norm);
      });
    },
  };

  async function seedOrgSuite(): Promise<string> {
    await createOrg(db.db, { id: ORG, name: 'RC' });
    for (const [t, p] of [
      ['tr_rc1', 'Summarize the incident report for case 40001001'],
      ['tr_rc2', 'Summarize the incident report for case 40001002'],
    ] as const) {
      await insertTraceSpans(db.db, [
        rcSpan({ traceId: t, spanId: `${t}_root`, attrs: { 'gen_ai.prompt': p } }),
        rcSpan({
          traceId: t,
          spanId: `${t}_tool`,
          name: 'tool.reports',
          attrs: { 'gen_ai.operation.name': 'execute_tool' },
          ts: new Date(Date.now() + 60_000),
        }),
      ]);
    }
    await tracesClusterHandler({ orgId: ORG }, { ...ctx(), embedder });
    return `agent-${orgHashOf(ORG)}-${toolSignatureSlug(['reports'])}-replays-v1`;
  }

  it('org cycle over an owned derived suite: db loading, org-stamped evidence, cycle org_id, NO recipe_status mutation', async () => {
    const suiteId = await seedOrgSuite();
    const statusesBefore = await db.db.select().from(recipeStatus);
    const res = await researchCycleHandler(
      { suiteV2Ids: [suiteId], orgId: ORG, seed: 11, trigger: 'manual' },
      ctx(),
    );
    expect(res.candidates).toBeGreaterThan(0);
    expect(res.suitesRun).toEqual([suiteId]);
    // cycle row carries the org
    const cycle = (await getResearchCycle(db.db, res.cycleId))!;
    expect(cycle.orgId).toBe(ORG);
    // evidence is org-stamped (|org cache keys → distinct rows)
    const rows = await db.db.select().from(evalResults);
    const orgRows = rows.filter((r) => r.orgId === ORG && r.runId !== 'run-seeded');
    expect(orgRows.length).toBeGreaterThan(0);
    // recipe_status untouched by the org cycle (platform library)
    const statusesAfter = await db.db.select().from(recipeStatus);
    expect(statusesAfter.length).toBe(statusesBefore.length);
  });

  it('org-scoped dedupe: a hash with PLATFORM-only rows is still evaluated for the org', async () => {
    const suiteId = await seedOrgSuite();
    // First: a platform cycle over an authored suite evaluates the grammar.
    const platform = await researchCycleHandler({ seed: 11, trigger: 'manual' }, ctx());
    expect(platform.candidates).toBeGreaterThan(0);
    // Then: the ORG cycle with the same seed must NOT dedupe those hashes
    // away (its own evidence set is empty).
    const org = await researchCycleHandler(
      { suiteV2Ids: [suiteId], orgId: ORG, seed: 11, trigger: 'manual' },
      ctx(),
    );
    expect(org.candidates).toBeGreaterThan(0);
  }, 60_000);

  it('ownership: an org cycle over ANOTHER org\'s suite throws; platform cycles refuse agent-* suites', async () => {
    const suiteId = await seedOrgSuite();
    await createOrg(db.db, { id: 'org_rc_b', name: 'RCB' });
    await expect(
      researchCycleHandler({ suiteV2Ids: [suiteId], orgId: 'org_rc_b', trigger: 'manual' }, ctx()),
    ).rejects.toThrow(/does not belong/);
    await expect(
      researchCycleHandler({ suiteV2Ids: [suiteId], trigger: 'manual' }, ctx()),
    ).rejects.toThrow(/org cycles only/);
  });
});
