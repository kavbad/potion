// Serving-grade latency rollup (G2.6) — the SQL side of the owner's
// "latency evidence must be serving-grade, not harness-grade" requirement.
//
// The load-bearing claim here is ESTIMATOR PARITY: percentile_disc in Postgres
// and quantileNearestRank in TypeScript are the same order statistic, so a p95
// computed on the serving path and one computed in the harness differ only
// because the underlying latencies differ — never because the two layers
// disagree about what "p95" means. That is asserted against randomized inputs
// below, not taken on faith.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { quantileNearestRank } from '@potion/core';
import { createDb, migrate, type DbHandle } from './index.js';
import { insertRequestLog, servingLatencyP95 } from './repos/request-logs.js';
import { ORG_A, ORG_B, seedIsolationOrgs } from './test-fixtures/orgs.js';

let handle: DbHandle;
const db = (): DbHandle['db'] => handle.db;

const NOW = new Date('2026-08-08T12:00:00.000Z');
const minsAgo = (m: number): Date => new Date(NOW.getTime() - m * 60_000);

beforeEach(async () => {
  handle = await createDb();
  await migrate(handle.db);
  await seedIsolationOrgs(handle.db);
});

afterEach(async () => {
  await handle.close();
});

async function log(
  over: {
    orgId?: string;
    clusterId?: string | null;
    strategyHash?: string | null;
    latencyMs?: number | null;
    status?: string;
    ts?: Date;
  } = {},
): Promise<void> {
  await insertRequestLog(db(), {
    ts: over.ts ?? minsAgo(5),
    orgId: over.orgId ?? ORG_A,
    clusterId: over.clusterId === undefined ? 'code-gen' : over.clusterId,
    strategyHash: over.strategyHash === undefined ? 'h-cascade' : over.strategyHash,
    latencyMs: over.latencyMs === undefined ? 100 : over.latencyMs,
    status: over.status ?? 'ok',
  });
}

async function seedLatencies(latencies: number[], strategyHash = 'h-cascade'): Promise<void> {
  for (const ms of latencies) await log({ latencyMs: ms, strategyHash });
}

describe('servingLatencyP95 — estimator parity with the TS quantile', () => {
  it('percentile_disc equals quantileNearestRank on a hand-checked vector', () => {
    // Documents the shared definition before the SQL is involved: with n=10
    // the 95th percentile is the ceil(0.95·10)=10th order statistic.
    expect(quantileNearestRank([10, 20, 30, 40, 50, 60, 70, 80, 90, 100], 95)).toBe(100);
  });

  it('matches quantileNearestRank EXACTLY across many random samples', async () => {
    // Deterministic pseudo-random vectors (no Math.random — a flaky parity
    // test would be worse than none). Sizes chosen to straddle the rank
    // boundaries where an interpolating estimator would diverge.
    let seed = 20260808;
    const next = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (const n of [1, 2, 5, 19, 20, 21, 40, 100]) {
      const latencies = Array.from({ length: n }, () => Math.round(next() * 5000) + 1);
      await handle.close();
      handle = await createDb();
      await migrate(handle.db);
      await seedIsolationOrgs(handle.db);
      await seedLatencies(latencies);
      const [row] = await servingLatencyP95(db(), ORG_A, 'code-gen', 60, NOW);
      expect(row, `n=${n} produced no row`).toBeDefined();
      expect(row!.p95Ms, `n=${n}`).toBe(quantileNearestRank(latencies, 95));
      expect(row!.n).toBe(n);
    }
    // Eight fresh PGlite instances; comfortably under the default 5s alone,
    // but not when the suite runs contended.
  }, 60_000);

  it('returns an ELEMENT of the input, never an interpolated value', async () => {
    const latencies = [100, 200, 300, 400, 500];
    await seedLatencies(latencies);
    const [row] = await servingLatencyP95(db(), ORG_A, 'code-gen', 60, NOW);
    // percentile_cont would return 480 here.
    expect(latencies).toContain(row!.p95Ms);
    expect(row!.p95Ms).toBe(500);
  });
});

describe('servingLatencyP95 — what counts as served traffic', () => {
  it("excludes non-'ok' rows: platform work never moves a customer's p95", async () => {
    await seedLatencies([100, 110, 120]);
    // guarantee_judge / rubric_gen / eval_live rows carry a latency but are
    // not served traffic. If these leaked in, the p95 would be 9000.
    for (const status of ['guarantee_judge', 'rubric_gen', 'eval_live', 'error']) {
      await log({ latencyMs: 9000, status });
    }
    const [row] = await servingLatencyP95(db(), ORG_A, 'code-gen', 60, NOW);
    expect(row!.p95Ms).toBe(120);
    expect(row!.n).toBe(3);
  });

  it('excludes rows outside the window, at the boundary', async () => {
    await log({ latencyMs: 100, ts: minsAgo(59) }); // inside
    await log({ latencyMs: 9000, ts: minsAgo(61) }); // outside
    const [row] = await servingLatencyP95(db(), ORG_A, 'code-gen', 60, NOW);
    expect(row!.n).toBe(1);
    expect(row!.p95Ms).toBe(100);
  });

  it('excludes NULL latencies from BOTH the quantile and the sample count', async () => {
    await seedLatencies([100, 200]);
    await log({ latencyMs: null });
    const [row] = await servingLatencyP95(db(), ORG_A, 'code-gen', 60, NOW);
    // n must be the EVIDENCE count, not the row count — the caller's
    // minimum-sample gate depends on it.
    expect(row!.n).toBe(2);
  });

  it('excludes rows with no strategy_hash (nothing to attribute them to)', async () => {
    await seedLatencies([100]);
    await log({ latencyMs: 9000, strategyHash: null });
    const [row] = await servingLatencyP95(db(), ORG_A, 'code-gen', 60, NOW);
    expect(row!.n).toBe(1);
  });
});

describe('servingLatencyP95 — scoping', () => {
  it('is ORG-scoped: another tenant’s traffic never enters the rollup', async () => {
    await seedLatencies([100, 110]);
    for (const ms of [8000, 9000, 9500]) await log({ orgId: ORG_B, latencyMs: ms });
    const [row] = await servingLatencyP95(db(), ORG_A, 'code-gen', 60, NOW);
    expect(row!.n).toBe(2);
    expect(row!.p95Ms).toBe(110);
    // …and org B sees only its own.
    const [bRow] = await servingLatencyP95(db(), ORG_B, 'code-gen', 60, NOW);
    expect(bRow!.n).toBe(3);
    expect(bRow!.p95Ms).toBe(9500);
  });

  it('is CLUSTER-scoped', async () => {
    await seedLatencies([100]);
    await log({ clusterId: 'extraction', latencyMs: 9000 });
    const rows = await servingLatencyP95(db(), ORG_A, 'code-gen', 60, NOW);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.p95Ms).toBe(100);
  });

  it('groups per strategy — each point binds against its OWN distribution', async () => {
    await seedLatencies([100, 120, 140], 'h-strong');
    await seedLatencies([2000, 2100, 3400], 'h-cascade');
    const rows = await servingLatencyP95(db(), ORG_A, 'code-gen', 60, NOW);
    const byHash = Object.fromEntries(rows.map((r) => [r.strategyHash, r]));
    expect(byHash['h-strong']!.p95Ms).toBe(140);
    expect(byHash['h-cascade']!.p95Ms).toBe(3400);
  });

  it('an org with no serving traffic yields no rows (not a zero p95)', async () => {
    // A zero would look like an infinitely fast strategy and pass any bound.
    expect(await servingLatencyP95(db(), ORG_A, 'code-gen', 60, NOW)).toEqual([]);
  });
});

describe('migration 0027', () => {
  it('creates the partial serving-latency index and is idempotent', async () => {
    const check = async (): Promise<number> => {
      const res = await db().execute(
        `SELECT indexdef FROM pg_indexes WHERE indexname = 'request_logs_serving_latency_idx'`,
      );
      const rows = res.rows as Array<{ indexdef: string }>;
      if (rows.length === 1) {
        // The predicate must be IN the index — otherwise the planner cannot
        // use it for the rollup's status='ok' filter.
        expect(rows[0]!.indexdef).toMatch(/WHERE .*status/i);
      }
      return rows.length;
    };
    expect(await check()).toBe(1);
    await migrate(db()); // re-run: boot re-applies every migration
    expect(await check()).toBe(1);
  });
});
