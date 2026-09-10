// Recompute planner + queue-driven recompute runner (SPEC §6).
//
// planRecompute: when a new model lands, which strategies are worth evaling?
// A new model can enter the objective space solo, as the CHEAP stage of a
// cascade, as the STRONG stage of a cascade, as best-of-n material, or as a
// draft with a frontier verifier — so we plan exactly that shortlist.
//
// runRecompute: enqueues one `eval` job per cluster (payload {suiteIds,
// strategies, budgetCapUsd}) then ONE `recompute-frontier` job that — after
// the evals — aggregates eval_results, computes + saves a new versioned
// frontier per cluster, and diffs against the previous version. Handlers are
// registered EXPLICITLY on the injected Queue: with the memory driver they
// execute inline in FIFO order (so runRecompute can await the diffs); a
// bullmq driver can take over later by registering the same two handler names
// in a worker.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ClusterId,
  Frontier,
  FrontierDiff,
  FrontierPoint,
  PriceEntry,
  PriceTable,
  StrategyAggregate,
  StrategyConfig,
} from '@potion/core';
import { sha256, strategyHash } from '@potion/core';
import { evalResults, type DbHandle, type PotionDb } from '@potion/db';
import { aggregateResults, runEval, type RunSummary } from '@potion/harness';
import { loadPrices } from '@potion/providers';
import type { Queue } from '@potion/queue';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { computeFrontier } from './dominance.js';
import { diffFrontiers } from './diff.js';
import { loadCurrentFrontier, saveFrontier } from './persistence.js';

/** Queue job names (registered explicitly by runRecompute; a bullmq worker
 * would register the same names). */
export const EVAL_JOB = 'eval';
export const RECOMPUTE_FRONTIER_JOB = 'recompute-frontier';

/** Hard cap on the planned shortlist (documented, SPEC §6 "shortlist"). The
 * current plan emits 5 entries; the cap leaves headroom for one more
 * heuristic without unbounded eval spend. */
export const RECOMPUTE_PLAN_CAP = 6;

/** Payload of one eval job: run `strategies` on `suiteIds` under a budget cap. */
export interface EvalJobPayload {
  suiteIds: string[];
  strategies: StrategyConfig[];
  budgetCapUsd: number;
}

/** Payload of the recompute-frontier job (runs after all eval jobs). */
export interface RecomputeFrontierJobPayload {
  clusterIds: ClusterId[];
  strategies: StrategyConfig[];
  pricesVersion: string;
  /** Include stale eval rows in aggregates (default false = exclude). */
  includeStale?: boolean;
}

export interface RunRecomputeOptions {
  db: DbHandle;
  queue: Queue;
  newModel: PriceEntry;
  clusterIds: ClusterId[];
  /** Base price table; default: loadPrices(pricesPath ?? <cwd>/prices.json). */
  prices?: PriceTable;
  /** Path to the base prices.json (used when `prices` is not given). */
  pricesPath?: string;
  /** Suite directory override (tests; defaults to the harness suites dir). */
  suitesDir?: string;
  /** Budget cap per cluster eval job (default 25 USD). */
  budgetCapUsd?: number;
  /** Where to write the merged price table (default: a fresh tmpdir file). */
  mergedPricesPath?: string;
  /** Include stale eval rows in the frontier aggregates (`--include-stale`;
   * default false — stale evidence never mixes into fresh frontiers). */
  includeStale?: boolean;
}

export interface RunRecomputeResult {
  plan: StrategyConfig[];
  /** Version of the merged price table the evals ran under. */
  pricesVersion: string;
  evalJobIds: string[];
  recomputeJobId: string;
  evalSummaries: RunSummary[];
  frontiers: Frontier[];
  diffs: FrontierDiff[];
}

/** Find an entry by alias, falling back to a heuristic pick (documented). */
function classAlias(
  prices: PriceTable,
  preferred: string,
  fallback: (entries: PriceEntry[]) => PriceEntry,
): string {
  const hit = prices.entries.find((e) => e.alias === preferred);
  if (hit) return hit.alias;
  return fallback(prices.entries).alias;
}

/** Total per-1M price heuristic for class fallbacks. */
function totalPer1M(e: PriceEntry): number {
  return e.inputPer1M + e.outputPer1M;
}

/**
 * planRecompute(newModel, prices) → the eval shortlist for a newly released
 * model (≤ RECOMPUTE_PLAN_CAP = 6 entries, currently 5):
 *
 *  1. `single(newModel)` — solo baseline.
 *  2. `cascade(newModel → frontier-class)` — new model as the CHEAP stage
 *     (frontier-class fallback on low self-report confidence, threshold 0.7
 *     per the mock calibration contract).
 *  3. `cascade(cheap-class → newModel)` — new model as the STRONG stage.
 *  4. `best-of-n(newModel ×3, judge-class)` — new model with a judge.
 *  5. `draft-verify(newModel → frontier-class)` — new model drafts, frontier
 *     verifies.
 *
 * Class aliases resolve from the price table when present (`cheap-class`,
 * `frontier-class`, `judge-class`); otherwise fall back to the cheapest /
 * priciest / priciest entry by total per-1M price.
 */
export function planRecompute(newModel: PriceEntry, prices: PriceTable): StrategyConfig[] {
  const cheap = classAlias(prices, 'cheap-class', (es) =>
    es.reduce((a, b) => (totalPer1M(a) <= totalPer1M(b) ? a : b)),
  );
  const frontier = classAlias(prices, 'frontier-class', (es) =>
    es.reduce((a, b) => (totalPer1M(a) >= totalPer1M(b) ? a : b)),
  );
  const judge = classAlias(prices, 'judge-class', (es) =>
    es.reduce((a, b) => (totalPer1M(a) >= totalPer1M(b) ? a : b)),
  );
  const plan: StrategyConfig[] = [
    { type: 'single', model: newModel.alias },
    {
      type: 'cascade',
      stages: [
        { model: newModel.alias, escalateIf: { confidenceBelow: 0.7 } },
        { model: frontier },
      ],
      confidenceMethod: 'self-report-calibrated',
    },
    {
      type: 'cascade',
      stages: [
        { model: cheap, escalateIf: { confidenceBelow: 0.7 } },
        { model: newModel.alias },
      ],
      confidenceMethod: 'self-report-calibrated',
    },
    { type: 'best-of-n', model: newModel.alias, n: 3, judge: { model: judge } },
    { type: 'draft-verify', draftModel: newModel.alias, verifierModel: frontier },
  ];
  return plan.slice(0, RECOMPUTE_PLAN_CAP);
}

/** Merge `newModel` into a copy of `base` (same-alias entries replaced) with
 * a bumped version stamp. */
/**
 * The next price-table version after a model is added or re-priced.
 *
 * WHY THIS IS NOT `${base.version}+${alias}` (fixed 2026-09-05). It was, and
 * every discovered model appended its own alias — so the live registry's
 * version grew into a 6,549-character list of 333 model names. Two harms,
 * one of them a live outage:
 *
 *   1. LEAK. `research:scan` discovered a sibling of the withheld winner and
 *      wrote its alias into the version string. /api/public/answers publishes
 *      pricesVersion, the redaction sweep found the embargoed name in it, and
 *      the endpoint failed closed for every request — taking the public
 *      answers pages and the daily Frontier Note with it. A version string is
 *      published; it must therefore never carry a model's identity.
 *   2. UNBOUNDED GROWTH. The version keys eval cache cells and rides on every
 *      frontier row; it has no business being kilobytes long.
 *
 * WHAT THE REPLACEMENT PRESERVES. The contract this version has always had is
 * cache invalidation: `cacheKey = sha256(strategyHash + itemId + judgeVersion
 * + pricesVersion)`, so the version must move EXACTLY when the catalog
 * changes and never otherwise. The digest below is taken over the previous
 * version plus the entry's identity AND its prices, so:
 *   · a newly discovered model moves it (new alias in the digest);
 *   · re-pricing a known model moves it (new numbers in the digest) — the
 *     `+n<count>` shape considered first would NOT have, silently serving
 *     stale-priced cells;
 *   · nothing else moves it, and it is chained, so history still matters.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It does not re-derive existing versions.
 * A content hash over the whole table was rejected when the registry was
 * built (see packages/db/src/repos/model-registry.ts) because it would change
 * on first boot and invalidate evidence that cost real money to collect —
 * that reasoning still holds. Only NEWLY MINTED versions take this shape;
 * every version already stored, including the long one live today, is left
 * exactly as it is. The public leak is closed on the publication side, where
 * it can be closed for free.
 */
export function nextPricesVersion(baseVersion: string, entry: PriceEntry): string {
  // One rolling segment, replaced rather than appended, so the string stays
  // bounded however many scans run.
  const head = baseVersion.replace(/\+r[0-9a-f]{10}$/, '');
  const digest = sha256(
    `${baseVersion}|${entry.alias}|${entry.provider}|${entry.model}|${entry.inputPer1M}|${entry.outputPer1M}`,
  ).slice(0, 10);
  return `${head}+r${digest}`;
}

export function mergePriceEntry(base: PriceTable, newModel: PriceEntry): PriceTable {
  return {
    version: nextPricesVersion(base.version, newModel),
    updatedAt: new Date().toISOString().slice(0, 10),
    entries: [...base.entries.filter((e) => e.alias !== newModel.alias), newModel],
  };
}

/** Adapt a persisted FrontierPoint back into aggregate shape so it can join
 * the candidate pool (quality ↔ qualityMean; p95 doubles as p50; n = 0 marks
 * it as carried-over rather than freshly measured). */
export function carriedPointToAggregate(p: FrontierPoint, pricesVersion: string): StrategyAggregate {
  return {
    clusterId: p.clusterId,
    strategyHash: p.strategyHash,
    strategyConfig: p.strategyConfig,
    qualityMean: p.quality,
    qualityCi95: 0,
    n: 0,
    costPer1K: p.costPer1K,
    latencyP50: p.latencyP95,
    latencyP95: p.latencyP95,
    pricesVersion,
    // Carried points keep their recorded provenance (M1a) AND their original
    // evidence links VERBATIM (G1.6): a carried point honestly reports the
    // rubric/evidence it was actually scored under.
    ...(p.providerMode !== undefined ? { providerMode: p.providerMode } : {}),
    ...(p.evidence !== undefined ? { evidence: p.evidence } : {}),
  };
}

/** Aggregate eval_results rows for (clusterId × strategy hashes), restricted
 * to `pricesVersion` so stale-price rows never mix into fresh aggregates.
 * Stale rows (M1a staleness engine) are excluded by default; pass
 * `opts.includeStale` (`--include-stale` on the recompute path) to override. */
export async function aggregatesFromEvalResults(
  db: PotionDb,
  clusterId: ClusterId,
  strategies: StrategyConfig[],
  pricesVersion: string,
  opts: {
    includeStale?: boolean;
    orgId?: string;
    providerMode?: 'live' | 'mock';
    instrument?: 'default' | 'tools' | 'vision' | 'audio';
    /**
     * BOUNDARY SUITE (2026-09-08): the suite's own items, each naming the
     * parent slice it came from. A boundary cluster's evidence is every cell
     * measured on ITS ITEMS — a cell the runner reused from a parent suite is
     * stored under the PARENT's cluster_id, so filtering by cluster alone saw
     * only fresh cells (both boundary frontiers published that day were
     * measured on partial unions). With items given: rows are read for the
     * boundary AND its parents, restricted to the items, deduped per
     * (strategy, item) preferring the boundary's own row, and aggregated with
     * the weakest slice as the point's quality. Absent → unchanged.
     */
    items?: ReadonlyArray<{ id: string; slice?: string }>;
  } = {},
): Promise<StrategyAggregate[]> {
  const hashes = strategies.map((s) => strategyHash(s));
  if (hashes.length === 0) return [];
  const sliced = opts.items !== undefined && opts.items.some((i) => i.slice !== undefined);
  const parentIds = sliced ? [...new Set(opts.items!.map((i) => i.slice).filter((s): s is string => s !== undefined))] : [];
  const itemIds = sliced ? opts.items!.map((i) => i.id) : [];
  const sliceOf = sliced ? (id: string) => opts.items!.find((i) => i.id === id)?.slice : undefined;
  const rows = await db
    .select()
    .from(evalResults)
    .where(
      and(
        sliced ? inArray(evalResults.clusterId, [clusterId, ...parentIds]) : eq(evalResults.clusterId, clusterId),
        ...(sliced ? [inArray(evalResults.itemId, itemIds)] : []),
        inArray(evalResults.strategyHash, hashes),
        eq(evalResults.pricesVersion, pricesVersion),
        // MIXING M3: cells from different instruments are never averaged.
        eq(evalResults.instrument, opts.instrument ?? 'default'),
        // G1.6 tenancy: org recomputes see ONLY their rows; the platform
        // default (orgId absent → IS NULL) keeps every pre-G1.6 caller and
        // fixture reading exactly what it read before.
        opts.orgId !== undefined ? eq(evalResults.orgId, opts.orgId) : isNull(evalResults.orgId),
        // G1.7: provenance-pure aggregation — post-live-sweep clusters hold
        // BOTH mock and live rows at the same coordinates; mixing them
        // yields providerMode 'unknown' aggregates that taint the whole
        // frontier under the live-serving guard.
        ...(opts.providerMode !== undefined
          ? [eq(evalResults.providerMode, opts.providerMode)]
          : []),
        ...(opts.includeStale ? [] : [eq(evalResults.stale, false)]),
      ),
    );
  const byHash = new Map<string, typeof rows>();
  for (const row of rows) {
    const list = byHash.get(row.strategyHash) ?? [];
    list.push(row);
    byHash.set(row.strategyHash, list);
  }
  // One cell per (strategy, item): the boundary's own row wins; otherwise the
  // newest parent row. The same measurement must never count twice.
  const dedupe = (group: typeof rows): typeof rows => {
    if (!sliced) return group;
    const best = new Map<string, (typeof rows)[number]>();
    for (const r of group) {
      const cur = best.get(r.itemId);
      const better =
        cur === undefined ||
        (r.clusterId === clusterId && cur.clusterId !== clusterId) ||
        (r.clusterId === cur.clusterId && r.createdAt > cur.createdAt);
      if (better) best.set(r.itemId, r);
    }
    return [...best.values()];
  };
  const out: StrategyAggregate[] = [];
  for (const strategy of strategies) {
    const sh = strategyHash(strategy);
    const group = dedupe(byHash.get(sh) ?? []);
    if (group.length === 0) continue;
    out.push(
      aggregateResults(
        clusterId,
        sh,
        strategy,
        group.map((r) => ({
          runId: r.runId,
          itemId: r.itemId,
          clusterId: r.clusterId,
          strategyHash: r.strategyHash,
          strategyConfig: r.strategyConfig,
          quality: r.quality,
          scorer: r.scorer,
          // The cell's instrument rides into the aggregate: toolsMeasured
          // derives from it (2026-09-01 — a tools suite may mix scorers).
          ...(r.instrument === 'default' || r.instrument === 'tools' || r.instrument === 'vision' || r.instrument === 'audio'
            ? { instrument: r.instrument }
            : {}),
          ...(r.judgeAgreement !== null ? { judgeAgreement: r.judgeAgreement } : {}),
          usage: r.usage,
          latencyMs: r.latencyMs,
          modelVersions: r.modelVersions,
          pricesVersion: r.pricesVersion,
          // db 'unknown' ↔ core absence (never silently 'live').
          ...(r.providerMode === 'mock' || r.providerMode === 'live'
            ? { providerMode: r.providerMode }
            : {}),
          cacheKey: r.cacheKey,
          createdAt: r.createdAt,
        })),
        pricesVersion,
        undefined,
        sliceOf,
      ),
    );
  }
  return out;
}

/** Placeholder empty frontier used as the `from` side when a cluster has no
 * previous version (diff then reports every point as `appeared`). */
function emptyFrontier(clusterId: ClusterId, pricesVersion: string): Frontier {
  return {
    id: 'fr-none',
    clusterId,
    version: 0,
    parentId: null,
    trigger: 'manual',
    points: [],
    pricesVersion,
    createdAt: new Date().toISOString(),
  };
}

/**
 * runRecompute — end-to-end new-model recompute:
 *   1. merge newModel into the price table (written to a temp prices.json so
 *      the harness runner — which loads prices from a path — picks it up);
 *   2. plan the shortlist (planRecompute);
 *   3. register `eval` + `recompute-frontier` handlers on the queue, enqueue
 *      one eval job per cluster, then the recompute-frontier job;
 *   4. the recompute-frontier handler aggregates eval_results, merges with
 *      the carried-over previous frontier points, computes + saves the new
 *      versioned frontier (trigger 'new-model'), and diffs vs the previous
 *      version.
 *
 * With the memory driver everything executes inline in FIFO order, so the
 * returned promise resolves with the finished diffs. With a future bullmq
 * driver the same jobs/handlers run in workers and callers would await
 * completion asynchronously (job ids are returned either way).
 */
export async function runRecompute(opts: RunRecomputeOptions): Promise<RunRecomputeResult> {
  const base = opts.prices ?? loadPrices(opts.pricesPath).table;
  const merged = mergePriceEntry(base, opts.newModel);
  const mergedPricesPath =
    opts.mergedPricesPath ??
    join(mkdtempSync(join(tmpdir(), 'potion-recompute-')), 'prices.json');
  writeFileSync(mergedPricesPath, JSON.stringify(merged, null, 2));

  const plan = planRecompute(opts.newModel, merged);
  const budgetCapUsd = opts.budgetCapUsd ?? 25;

  const evalSummaries: RunSummary[] = [];
  const frontiers: Frontier[] = [];
  const diffs: FrontierDiff[] = [];

  let resolveDone!: () => void;
  let rejectDone!: (e: unknown) => void;
  const done = new Promise<void>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });

  // ---- explicit handler registration (see header: bullmq can take over) ----
  opts.queue.registerHandler(EVAL_JOB, async (payload: EvalJobPayload) => {
    evalSummaries.push(
      await runEval(
        {
          suiteIds: payload.suiteIds,
          strategies: payload.strategies,
          budgetCapUsd: payload.budgetCapUsd,
          provider: 'mock',
          resume: true,
        },
        {
          db: opts.db,
          pricesPath: mergedPricesPath,
          ...(opts.suitesDir !== undefined ? { suitesDir: opts.suitesDir } : {}),
        },
      ),
    );
  });

  opts.queue.registerHandler(RECOMPUTE_FRONTIER_JOB, async (payload: RecomputeFrontierJobPayload) => {
    try {
      for (const clusterId of payload.clusterIds) {
        const prev = await loadCurrentFrontier(opts.db.db, clusterId);
        const fresh = await aggregatesFromEvalResults(
          opts.db.db,
          clusterId,
          payload.strategies,
          payload.pricesVersion,
          { includeStale: payload.includeStale === true },
        );
        // Candidate pool = freshly measured strategies + carried-over points
        // from the previous frontier (fresh aggregates win on hash collision).
        const freshHashes = new Set(fresh.map((a) => a.strategyHash));
        const carried = (prev?.points ?? [])
          .filter((p) => !freshHashes.has(p.strategyHash))
          .map((p) => carriedPointToAggregate(p, payload.pricesVersion));
        const points = computeFrontier([...carried, ...fresh]);
        const saved = await saveFrontier(
          opts.db.db,
          clusterId,
          points,
          'new-model',
          payload.pricesVersion,
        );
        frontiers.push(saved);
        diffs.push(diffFrontiers(prev ?? emptyFrontier(clusterId, payload.pricesVersion), saved));
      }
      resolveDone();
    } catch (e) {
      rejectDone(e);
    }
  });

  const evalJobIds: string[] = [];
  for (const clusterId of opts.clusterIds) {
    evalJobIds.push(
      await opts.queue.enqueue(EVAL_JOB, {
        suiteIds: [clusterId],
        strategies: plan,
        budgetCapUsd,
      } satisfies EvalJobPayload),
    );
  }
  const recomputeJobId = await opts.queue.enqueue(RECOMPUTE_FRONTIER_JOB, {
    clusterIds: opts.clusterIds,
    strategies: plan,
    pricesVersion: merged.version,
    includeStale: opts.includeStale === true,
  } satisfies RecomputeFrontierJobPayload);

  await done; // memory driver: inline FIFO execution has finished by now

  return {
    plan,
    pricesVersion: merged.version,
    evalJobIds,
    recomputeJobId,
    evalSummaries,
    frontiers,
    diffs,
  };
}

/** Test-only alias (G1.6 provenance tests exercise the carried-point path). */
export const carriedPointToAggregateForTest = carriedPointToAggregate;

/**
 * True when any non-stale LIVE eval evidence exists for (cluster, org) —
 * the "once live, never regress" switch (G1.7): the nightly mock recompute
 * SKIPS its frontier save, and the purge-retirement recompute aggregates
 * live-only, so a live frontier is never clobbered by mock aggregates.
 */
export async function hasLiveEvidence(
  db: PotionDb,
  clusterId: ClusterId,
  orgId: string,
): Promise<boolean> {
  const rows = await db
    .select({ cacheKey: evalResults.cacheKey })
    .from(evalResults)
    .where(
      and(
        eq(evalResults.clusterId, clusterId),
        eq(evalResults.orgId, orgId),
        eq(evalResults.providerMode, 'live'),
        eq(evalResults.stale, false),
      ),
    )
    .limit(1);
  return rows.length > 0;
}
