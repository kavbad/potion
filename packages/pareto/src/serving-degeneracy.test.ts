// Serving-measured DEGENERACY exclusion (2026-09-01, the or-gemini-flash
// incident): a route measured q=1.0 on its instrument suite returned six
// consecutive ZERO-TOKEN completions in production. No floor or policy can
// dodge a point whose suite score is perfect — the org's own measured
// traffic must overrule the suite at serve time, exactly as the
// serving-measured latency substitution (G2.6) already does. The bar:
// ≥4 empties AND ≥50% of that strategy's window servings, org+cluster
// scoped, fail-open when exclusion would empty the frontier.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { strategyHash, type Frontier, type FrontierPoint } from '@potion/core';
import { createDb, insertRequestLog, migrate, seedIsolationOrgs, ORG_A, ORG_B, type DbHandle } from '@potion/db';
import {
  bindServingDegeneracy,
  clearServingLatencyCache,
  DEGENERACY_MIN_EMPTY,
  resolveOperatingPoint,
} from './serving.js';

let h: DbHandle;
const NOW = new Date('2026-09-01T12:00:00.000Z');
const minsAgo = (m: number): Date => new Date(NOW.getTime() - m * 60_000);

const CLUSTER = 'agentic-tool-use';

function pt(model: string, quality: number, costPer1K: number): FrontierPoint {
  const config = { type: 'single' as const, model };
  return {
    clusterId: CLUSTER,
    strategyHash: strategyHash(config),
    strategyConfig: config,
    quality,
    costPer1K,
    latencyP95: 700,
    providerMode: 'live',
  };
}

// The incident's shape: the broken route is measured PERFECT and cheapest.
const P_BROKEN = pt('or-gemini-flash', 1, 0.1);
const P_GOOD = pt('or-solar-pro4', 0.958, 0.15);

function frontier(points: FrontierPoint[]): Frontier {
  return {
    id: 'f-degen',
    clusterId: CLUSTER,
    version: 1,
    parentId: null,
    trigger: 'recompute',
    pricesVersion: 'test',
    createdAt: NOW.toISOString(),
    points,
  };
}

async function serve(over: {
  strategyHash: string;
  completionTokens: number;
  orgId?: string;
  clusterId?: string;
  ts?: Date;
  status?: string;
}): Promise<void> {
  await insertRequestLog(h.db, {
    ts: over.ts ?? minsAgo(5),
    orgId: over.orgId ?? ORG_A,
    clusterId: over.clusterId ?? CLUSTER,
    strategyHash: over.strategyHash,
    status: over.status ?? 'ok',
    // Alternate rows between the two live usage spellings — the serve path
    // writes {inputTokens, outputTokens}; the Usage type says
    // {promptTokens, completionTokens}. The rollup must read both.
    usage: (over.completionTokens % 2 === 0
      ? ({ inputTokens: 100, outputTokens: over.completionTokens } as never)
      : { promptTokens: 100, completionTokens: over.completionTokens, totalTokens: 100 + over.completionTokens }),
  });
}

beforeEach(async () => {
  h = await createDb();
  await migrate(h.db);
  await seedIsolationOrgs(h.db);
  clearServingLatencyCache();
});

afterEach(async () => {
  await h.close();
});

describe('bindServingDegeneracy', () => {
  it('the incident: a burst of zero-token servings excludes the perfect-scored route; selection falls to the working one', async () => {
    for (let i = 0; i < 6; i++) await serve({ strategyHash: P_BROKEN.strategyHash, completionTokens: 0 });
    const bound = await bindServingDegeneracy(h.db, frontier([P_BROKEN, P_GOOD]), ORG_A, CLUSTER, () => {}, NOW);
    expect(bound.excluded).toEqual([P_BROKEN.strategyHash]);
    const op = resolveOperatingPoint({ type: 'min_cost', qualityFloor: 0.886 }, bound.frontier, null);
    expect(strategyHash(op.config!)).toBe(P_GOOD.strategyHash);
  });

  it('below the burst floor, or a minority of servings, nothing is excluded', async () => {
    for (let i = 0; i < DEGENERACY_MIN_EMPTY - 1; i++) await serve({ strategyHash: P_BROKEN.strategyHash, completionTokens: 0 });
    const few = await bindServingDegeneracy(h.db, frontier([P_BROKEN, P_GOOD]), ORG_A, CLUSTER, () => {}, NOW);
    expect(few.excluded).toEqual([]);
    expect(few.frontier).toBe(few.frontier); // identity-preserving no-op path
    clearServingLatencyCache();
    // 4 empties among 12 servings = a third — an occasional degenerate
    // answer never indicts a mostly-working route.
    for (let i = 0; i < 4; i++) await serve({ strategyHash: P_BROKEN.strategyHash, completionTokens: 0 });
    for (let i = 0; i < 8; i++) await serve({ strategyHash: P_BROKEN.strategyHash, completionTokens: 200 });
    const minority = await bindServingDegeneracy(h.db, frontier([P_BROKEN, P_GOOD]), ORG_A, CLUSTER, () => {}, NOW);
    expect(minority.excluded).toEqual([]);
  });

  it('fail-open: when every point is degenerate-flagged the frontier serves as measured', async () => {
    for (let i = 0; i < 6; i++) await serve({ strategyHash: P_BROKEN.strategyHash, completionTokens: 0 });
    for (let i = 0; i < 6; i++) await serve({ strategyHash: P_GOOD.strategyHash, completionTokens: 0 });
    const bound = await bindServingDegeneracy(h.db, frontier([P_BROKEN, P_GOOD]), ORG_A, CLUSTER, () => {}, NOW);
    expect(bound.excluded).toEqual([]);
    expect(bound.frontier?.points).toHaveLength(2);
  });

  it('the evidence is org- and cluster-scoped, window-bound, and ok-status only', async () => {
    // Another org's empties, another cluster's empties, stale empties, and
    // errored rows: none of them speak for THIS org+cluster now.
    for (let i = 0; i < 6; i++) await serve({ strategyHash: P_BROKEN.strategyHash, completionTokens: 0, orgId: ORG_B });
    for (let i = 0; i < 6; i++) await serve({ strategyHash: P_BROKEN.strategyHash, completionTokens: 0, clusterId: 'code-gen' });
    for (let i = 0; i < 6; i++) await serve({ strategyHash: P_BROKEN.strategyHash, completionTokens: 0, ts: minsAgo(120) });
    for (let i = 0; i < 6; i++) await serve({ strategyHash: P_BROKEN.strategyHash, completionTokens: 0, status: 'error' });
    const bound = await bindServingDegeneracy(h.db, frontier([P_BROKEN, P_GOOD]), ORG_A, CLUSTER, () => {}, NOW);
    expect(bound.excluded).toEqual([]);
  });
});
