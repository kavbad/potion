// Serving-measured DEGENERACY exclusion (2026-09-01, the or-gemini-flash
// incident): a route measured q=1.0 on its instrument suite returned six
// consecutive ZERO-TOKEN completions in production. No floor or policy can
// dodge a point whose suite score is perfect — the org's own measured
// traffic must overrule the suite at serve time, exactly as the
// serving-measured latency substitution (G2.6) already does. The bar:
// ≥4 empties AND ≥50% of that strategy's window servings, org+cluster
// scoped over a 7-DAY memory (the 60-min version sawtoothed live), with
// the COLD-START RULE: an org with no reading on a strategy inherits the
// platform's (route health is platform truth — counts only, no content);
// its own readings outrank the platform once they exist. Fail-open when
// exclusion would empty the frontier.
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
  answerShape?: Record<string, unknown>;
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
    ...(over.answerShape !== undefined ? { answerShape: over.answerShape } : {}),
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

  it("a row whose own answer_shape shows content is never 'empty' — zero tokens against a text-bearing answer is a metering failure, not degeneracy", async () => {
    // Six rows shaped like the usage-loss incident: text (or a tool call)
    // came back but the recorded tokens are 0. Excluding a working route
    // over lost usage would be the guard firing on its own instrumentation.
    for (let i = 0; i < 4; i++)
      await serve({ strategyHash: P_BROKEN.strategyHash, completionTokens: 0, answerShape: { v: 1, chars: 66, toolCallsN: 0 } });
    for (let i = 0; i < 2; i++)
      await serve({ strategyHash: P_BROKEN.strategyHash, completionTokens: 0, answerShape: { v: 1, chars: 0, toolCallsN: 1 } });
    const bound = await bindServingDegeneracy(h.db, frontier([P_BROKEN, P_GOOD]), ORG_A, CLUSTER, () => {}, NOW);
    expect(bound.excluded).toEqual([]);
    clearServingLatencyCache();
    // And the true incident shape still trips: zero tokens AND an
    // answer_shape that recorded nothing.
    for (let i = 0; i < 6; i++)
      await serve({ strategyHash: P_BROKEN.strategyHash, completionTokens: 0, answerShape: { v: 1, chars: 0, toolCallsN: 0 } });
    const tripped = await bindServingDegeneracy(h.db, frontier([P_BROKEN, P_GOOD]), ORG_A, CLUSTER, () => {}, NOW);
    expect(tripped.excluded).toEqual([P_BROKEN.strategyHash]);
  });

  it('cluster-scoped, window-bound, ok-status only — those scopes never leak', async () => {
    // Another cluster's empties, stale empties, and errored rows: none of
    // them speak for THIS cluster now.
    for (let i = 0; i < 6; i++) await serve({ strategyHash: P_BROKEN.strategyHash, completionTokens: 0, clusterId: 'code-gen' });
    for (let i = 0; i < 6; i++) await serve({ strategyHash: P_BROKEN.strategyHash, completionTokens: 0, ts: minsAgo(8 * 24 * 60) });
    for (let i = 0; i < 6; i++) await serve({ strategyHash: P_BROKEN.strategyHash, completionTokens: 0, status: 'error' });
    const bound = await bindServingDegeneracy(h.db, frontier([P_BROKEN, P_GOOD]), ORG_A, CLUSTER, () => {}, NOW);
    expect(bound.excluded).toEqual([]);
  });

  it('THE COLD-START RULE: a fresh org inherits the platform reading — the first real signup must not rediscover a failure the platform already paid for', async () => {
    // ORG_B measured the burst; ORG_A has never served this strategy.
    for (let i = 0; i < 6; i++) await serve({ strategyHash: P_BROKEN.strategyHash, completionTokens: 0, orgId: ORG_B });
    const bound = await bindServingDegeneracy(h.db, frontier([P_BROKEN, P_GOOD]), ORG_A, CLUSTER, () => {}, NOW);
    expect(bound.excluded).toEqual([P_BROKEN.strategyHash]);
  });

  it("an org's OWN healthy reading outranks the platform view for that org", async () => {
    // ORG_B's burst says broken; ORG_A's own traffic says the route works
    // for ITS workload — the org's measurement decides for the org.
    for (let i = 0; i < 6; i++) await serve({ strategyHash: P_BROKEN.strategyHash, completionTokens: 0, orgId: ORG_B });
    for (let i = 0; i < 8; i++) await serve({ strategyHash: P_BROKEN.strategyHash, completionTokens: 200, orgId: ORG_A });
    const bound = await bindServingDegeneracy(h.db, frontier([P_BROKEN, P_GOOD]), ORG_A, CLUSTER, () => {}, NOW);
    expect(bound.excluded).toEqual([]);
  });
});
