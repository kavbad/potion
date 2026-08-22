// THE AUTONOMOUS PROBE (SERVING-ROADMAP S7 L4).
//
// What is proven here is the part that decides whether money moves, and on
// what. The sweep it launches is already covered by the platform-sweep
// tests; these are the gates in front of it:
//
//   nothing is authorized by default — the standing cap is OFF unless the
//   operator set it, and with it off the loop still plans;
//
//   the day's budget counts an IN-FLIGHT run at its projection, so two
//   probes cannot each spend the whole day;
//
//   and the gap's reason DECIDES the candidate filter — a tools gap must
//   narrow the sweep to tool-capable models, or it spends real money and
//   leaves the gap exactly where it was.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DemandAccumulator, type FrontierPoint } from '@potion/core';
import {
  addScannedModels,
  createDb,
  insertLearningRun,
  learningRuns,
  mergeDemandDeltas,
  migrate,
  orgs,
  spentTodayUsd,
  type DbHandle,
} from '@potion/db';
import { saveFrontier } from '@potion/pareto';
import { eq } from 'drizzle-orm';
import {
  capabilityFilterFor,
  filterByCapability,
  isRefusal,
  learningAutonomyFromEnv,
  planProbe,
  type LearningAutonomy,
} from './learning.js';

const AT = new Date('2026-08-19T12:00:00Z');
const SMALL = { minOrgs: 2, minRequests: 2 };
const SWEEPABLE = new Set(['code-gen', 'extraction', 'summarization']);
const isSweepable = (id: string): boolean => SWEEPABLE.has(id);

const AUTONOMY: LearningAutonomy = {
  enabled: true,
  dailyCapUsd: 10,
  perRunCapUsd: 2,
  priorityWeight: 2,
};

let h: DbHandle;

async function demand(
  bucket: string,
  shapeClass = 'no-tools/sync/0-1k',
  orgIds = ['org-a', 'org-b'],
): Promise<void> {
  const acc = new DemandAccumulator();
  for (const orgId of orgIds) {
    for (let i = 0; i < 10; i++) {
      acc.observe({ bucket, shapeClass, at: AT, orgId, confidence: 0.7 });
    }
  }
  await mergeDemandDeltas(h.db, acc.drain(), SMALL);
}

function point(over: Partial<FrontierPoint>): FrontierPoint {
  return {
    clusterId: 'code-gen',
    strategyHash: 'h',
    strategyConfig: { type: 'single', model: 'plain' },
    quality: 0.9,
    costPer1K: 1,
    latencyP95: 500,
    providerMode: 'live',
    ...over,
  } as FrontierPoint;
}

beforeAll(async () => {
  h = await createDb('pglite://');
  await migrate(h.db);
  await addScannedModels(
    h.db,
    [
      { alias: 'plain', provider: 'openrouter', model: 'x/plain', inputPer1M: 1, outputPer1M: 2, supportsTools: false, contextLength: 8_000 },
    ],
    'pv-test',
  );
}, 60_000);
afterAll(async () => {
  await h.close();
});

describe('learningAutonomyFromEnv — off unless the operator says otherwise', () => {
  it('is DISABLED with no configuration at all', () => {
    const a = learningAutonomyFromEnv({});
    expect(a.enabled).toBe(false);
    expect(a.dailyCapUsd).toBe(0);
  });

  it('is disabled by an explicit zero, and by nonsense', () => {
    expect(learningAutonomyFromEnv({ POTION_AUTONOMOUS_LEARNING_DAILY_USD: '0' }).enabled).toBe(false);
    expect(learningAutonomyFromEnv({ POTION_AUTONOMOUS_LEARNING_DAILY_USD: 'lots' }).enabled).toBe(false);
    expect(learningAutonomyFromEnv({ POTION_AUTONOMOUS_LEARNING_DAILY_USD: '-5' }).enabled).toBe(false);
  });

  it('never lets a per-run ceiling exceed the day it is drawn from', () => {
    const a = learningAutonomyFromEnv({
      POTION_AUTONOMOUS_LEARNING_DAILY_USD: '1',
      POTION_AUTONOMOUS_LEARNING_PER_RUN_USD: '50',
    });
    expect(a.perRunCapUsd).toBe(1);
  });
});

describe('capabilityFilterFor — the reason IS the filter', () => {
  const gap = (reason: string, requiredContextTokens = 16_000) =>
    ({ reason, requiredContextTokens }) as never;

  it('narrows a tools gap to tool-capable models', () => {
    expect(capabilityFilterFor(gap('no_tool_capable_point'))).toEqual({ tools: true });
  });

  it('narrows a context gap to models that can hold the cell', () => {
    expect(capabilityFilterFor(gap('context_too_short', 32_000))).toEqual({
      minContextTokens: 32_000,
    });
  });

  it('does NOT narrow a breadth gap — that would measure less for the money', () => {
    expect(capabilityFilterFor(gap('no_live_points'))).toBeUndefined();
    expect(capabilityFilterFor(gap('thin_evidence'))).toBeUndefined();
  });
});

describe('planProbe', () => {
  it('refuses without a standing authorization, and says so', async () => {
    const d = await planProbe(h.db, {
      autonomy: learningAutonomyFromEnv({}),
      isSweepable,
    });
    expect(isRefusal(d)).toBe(true);
    if (isRefusal(d)) {
      expect(d.refusal).toBe('not-authorized');
      expect(d.detail).toContain('POTION_AUTONOMOUS_LEARNING_DAILY_USD');
    }
  }, 30_000);

  it('refuses when there is no demand at all', async () => {
    const d = await planProbe(h.db, { autonomy: AUTONOMY, isSweepable });
    expect(isRefusal(d) && d.refusal).toBe('no-gaps');
  }, 30_000);

  it('plans the worst sweepable gap and derives its filter', async () => {
    // An unmeasured cluster (no frontier) plus a tools gap on a measured one.
    await demand('code-gen', 'tools/sync/0-1k');
    await saveFrontier(h.db, 'code-gen', [point({}), point({ strategyHash: 'h2', quality: 0.8 })], 'manual', 'pv-test');

    const d = await planProbe(h.db, { autonomy: AUTONOMY, isSweepable, now: AT });
    expect(isRefusal(d)).toBe(false);
    if (!isRefusal(d)) {
      expect(d.clusterId).toBe('code-gen');
      expect(d.gap.reason).toBe('no_tool_capable_point');
      expect(d.capabilityFilter).toEqual({ tools: true });
      expect(d.capUsd).toBe(2); // the per-run ceiling, under the day's $10
    }
  }, 60_000);

  it('skips what a sweep cannot close, and REPORTS what it skipped', async () => {
    // An unassigned region outranks everything (lots of demand), and no
    // sweep can close it — it needs a taxonomy proposal (L5).
    const acc = new DemandAccumulator();
    for (const orgId of ['org-a', 'org-b', 'org-c']) {
      for (let i = 0; i < 200; i++) {
        acc.observe({ bucket: 'lsh:beef', shapeClass: 'no-tools/sync/0-1k', at: AT, orgId, confidence: 0.1 });
      }
    }
    await mergeDemandDeltas(h.db, acc.drain(), SMALL);

    const d = await planProbe(h.db, { autonomy: AUTONOMY, isSweepable, now: AT });
    expect(isRefusal(d)).toBe(false);
    if (!isRefusal(d)) {
      expect(d.clusterId).toBe('code-gen'); // the sweepable one, not the biggest
      expect(d.skipped.map((s) => s.reason)).toContain('unassigned-region-needs-taxonomy');
    }
  }, 60_000);

  it('counts an IN-FLIGHT run at its projection so two probes cannot double-spend', async () => {
    await insertLearningRun(h.db, {
      id: 'lrn-inflight',
      status: 'running',
      projectedUsd: 10,
      startedAt: AT,
    });
    expect(await spentTodayUsd(h.db, AT)).toBe(10);

    const d = await planProbe(h.db, { autonomy: AUTONOMY, isSweepable, now: AT });
    expect(isRefusal(d) && d.refusal).toBe('daily-cap-exhausted');
  }, 60_000);

  it('does not count REFUSED runs against the day', async () => {
    await h.db.delete(learningRuns).where(eq(learningRuns.id, 'lrn-inflight'));
    await insertLearningRun(h.db, {
      id: 'lrn-refused',
      status: 'refused',
      projectedUsd: 0,
      startedAt: AT,
      detail: 'not-authorized',
    });
    expect(await spentTodayUsd(h.db, AT)).toBe(0);
    const d = await planProbe(h.db, { autonomy: AUTONOMY, isSweepable, now: AT });
    expect(isRefusal(d)).toBe(false);
  }, 60_000);

  it('premium priority changes the ORDER, never the k-gate', async () => {
    // 'extraction' is a LESSER gap than code-gen — measured, just thinly
    // (2 live points, no capability problem: severity 0.4 against 0.9) — and
    // it has a priority contributor. Without the weight it ranks second.
    await demand('extraction', 'no-tools/sync/0-1k', ['org-p', 'org-q']);
    await saveFrontier(
      h.db,
      'extraction',
      [
        point({ clusterId: 'extraction', strategyHash: 'e1' }),
        point({ clusterId: 'extraction', strategyHash: 'e2', quality: 0.7 }),
      ],
      'manual',
      'pv-test',
    );
    await h.db.insert(orgs).values({ id: 'org-p', name: 'Premium' }).onConflictDoNothing();
    await h.db.update(orgs).set({ learningPriority: true }).where(eq(orgs.id, 'org-p'));

    const plain = await planProbe(h.db, {
      autonomy: { ...AUTONOMY, priorityWeight: 1 },
      isSweepable,
      now: AT,
    });
    const premium = await planProbe(h.db, {
      autonomy: { ...AUTONOMY, priorityWeight: 50 },
      isSweepable,
      now: AT,
    });
    expect(isRefusal(plain)).toBe(false);
    expect(isRefusal(premium)).toBe(false);
    if (!isRefusal(plain) && !isRefusal(premium)) {
      expect(plain.clusterId).toBe('code-gen');
      expect(premium.clusterId).toBe('extraction');
    }
  }, 60_000);
});

describe('filterByCapability — what the sweep is allowed to measure', () => {
  const catalog = new Map([
    ['tooly', { alias: 'tooly', supportsTools: true, contextLength: 128_000 }],
    ['plain', { alias: 'plain', supportsTools: false, contextLength: 8_000 }],
    ['mystery', { alias: 'mystery', supportsTools: null, contextLength: null }],
  ]);
  const pool = [{ alias: 'tooly' }, { alias: 'plain' }, { alias: 'mystery' }];

  it('keeps only models KNOWN to support tools', () => {
    expect(filterByCapability(pool, catalog, { tools: true }).map((e) => e.alias)).toEqual(['tooly']);
  });

  it('excludes UNKNOWN capability rather than assuming it', () => {
    // 'mystery' reports neither. Assuming yes spends the budget on a model
    // that may reject the tool definition, and leaves the gap open.
    expect(filterByCapability(pool, catalog, { tools: true }).map((e) => e.alias)).not.toContain('mystery');
    expect(
      filterByCapability(pool, catalog, { minContextTokens: 4_000 }).map((e) => e.alias),
    ).not.toContain('mystery');
  });

  it('keeps only models that can hold the cell', () => {
    expect(
      filterByCapability(pool, catalog, { minContextTokens: 32_000 }).map((e) => e.alias),
    ).toEqual(['tooly']);
    expect(
      filterByCapability(pool, catalog, { minContextTokens: 8_000 }).map((e) => e.alias).sort(),
    ).toEqual(['plain', 'tooly']);
  });

  it('applies both constraints together', () => {
    expect(filterByCapability(pool, catalog, { tools: true, minContextTokens: 256_000 })).toEqual([]);
  });

  it('a model absent from the catalog is not a capability claim', () => {
    expect(filterByCapability([{ alias: 'ghost' }], catalog, { tools: true })).toEqual([]);
  });
});

describe('S7 L4 spend safety', () => {
  it('learning:probe is a SINGLE-ATTEMPT job — a blind retry re-spends', async () => {
    const { SINGLE_ATTEMPT_KINDS } = await import('@potion/queue');
    expect(SINGLE_ATTEMPT_KINDS.has('learning:probe')).toBe(true);
  });
});
