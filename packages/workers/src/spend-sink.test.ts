// Per-call spend sink tests (post-capstone item 1): the workers-side chain
// of custody. The harness suite proves calls reach the sink before a mid-run
// death (runner.test.ts kill test); THIS file proves the sink makes each call
// durable in request_logs with the provider id, that the billing rollup
// (mtdSpendUsd — the number every hard-stop pre-check reads) sees those rows,
// and that completion-time reconcile flags both filed failure directions.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createDb,
  createOrg,
  migrate,
  mtdSpendUsd,
  requestLogs,
  type DbHandle,
} from '@potion/db';
import { eq } from 'drizzle-orm';
import {
  perCallRequestLogSink,
  reconcileMetering,
  RECONCILE_TOLERANCE_USD,
} from './spend-sink.js';

const ORG = 'org_sink';
let db: DbHandle;

beforeEach(async () => {
  db = await createDb();
  await migrate(db.db);
  await createOrg(db.db, { id: ORG, name: 'Sink' });
});

afterEach(async () => {
  await db.close();
  vi.restoreAllMocks();
});

const call = (provider: 'openrouter' | 'openai', costUsd: number) => ({
  provider: provider as never,
  model: 'judge-class',
  resolvedModel: 'judge-class-v1',
  inputTokens: 1200,
  outputTokens: 80,
  costUsd,
  latencyMs: 950,
});

describe('perCallRequestLogSink', () => {
  it('writes one durable eval_live row per call — provider id, REAL tokens, cluster attribution', async () => {
    const meter = perCallRequestLogSink(db.db, { orgId: ORG, clusterId: 'cl-1', status: 'eval_live' });
    await meter.sink(call('openrouter', 0.12));
    await meter.sink(call('openai', 0.3));

    const rows = await db.db.select().from(requestLogs).where(eq(requestLogs.orgId, ORG));
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.provider).sort()).toEqual(['openai', 'openrouter']);
    for (const r of rows) {
      expect(r.status).toBe('eval_live');
      expect(r.clusterId).toBe('cl-1');
      expect(r.model).toBe('judge-class');
      // Real token counts — the pre-0030 aggregate rows zeroed them.
      expect(r.usage?.inputTokens).toBe(1200);
      expect(r.usage?.outputTokens).toBe(80);
    }
    expect(meter.calls).toBe(2);
    expect(meter.meteredUsd).toBeCloseTo(0.42, 12);
    expect(meter.perProvider).toEqual({ openrouter: 0.12, openai: 0.3 });
  });

  it('the billing rollup sees per-call rows — a DEAD run\'s spend counts against the next pre-check (the ratchet)', async () => {
    // Simulate a run killed mid-flight: two calls metered, no completion of
    // any kind. Pre-fix, this spend did not exist as far as budgets knew
    // (G2.8 legs 3/4: 60% of real spend invisible to the hard-stop).
    const meter = perCallRequestLogSink(db.db, { orgId: ORG, clusterId: 'cl-1', status: 'eval_live' });
    await meter.sink(call('openrouter', 0.55));
    await meter.sink(call('openrouter', 0.35));
    // …process dies here. No reconcile, no aggregate write, no run row.

    // mtdSpendUsd is THE number every fail-closed job pre-check reads
    // (live-sweep, suite-verify, research) — the dead run's spend is in it.
    const mtd = await mtdSpendUsd(db.db, ORG, new Date());
    expect(mtd).toBeCloseTo(0.9, 12);
  });

  it('rubric_gen status rows land in the rollup too', async () => {
    const meter = perCallRequestLogSink(db.db, { orgId: ORG, clusterId: 'cl-2', status: 'rubric_gen' });
    await meter.sink(call('openrouter', 0.05));
    expect(await mtdSpendUsd(db.db, ORG, new Date())).toBeCloseTo(0.05, 12);
  });
});

describe('reconcileMetering', () => {
  it('within tolerance: records both numbers without warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const meter = perCallRequestLogSink(db.db, { orgId: ORG, status: 'eval_live' });
    meter.calls = 4;
    meter.meteredUsd = 1.234567;
    meter.perProvider = { openrouter: 1.234567 };
    const rec = reconcileMetering(meter, { executedSpendUsd: 1.234569, spendUsd: 2.5 }, 'test');
    expect(Math.abs(rec.deltaUsd)).toBeLessThanOrEqual(RECONCILE_TOLERANCE_USD);
    // evidenceCostUsd (cache-inclusive) is recorded but NEVER billed — the
    // $1.1045 over-metering was billing this number.
    expect(rec.evidenceCostUsd).toBe(2.5);
    expect(rec.executedSpendUsd).toBe(1.234569);
    expect(warn).not.toHaveBeenCalled();
  });

  it('flags UNDER-metering (executed spend the record missed) past tolerance', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const meter = perCallRequestLogSink(db.db, { orgId: ORG, status: 'eval_live' });
    meter.meteredUsd = 1.0;
    const rec = reconcileMetering(meter, { executedSpendUsd: 2.5594, spendUsd: 2.5594 }, 'legs-3-4');
    expect(rec.deltaUsd).toBeCloseTo(1.5594, 6);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]![0]).toContain('under-metering hides spend from hard-stop caps');
  });

  it('flags OVER-metering (metered rows a run this cheap cannot explain)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const meter = perCallRequestLogSink(db.db, { orgId: ORG, status: 'eval_live' });
    meter.meteredUsd = 1.1045;
    const rec = reconcileMetering(meter, { executedSpendUsd: 0, spendUsd: 1.1045 }, 'cached-replay');
    expect(rec.deltaUsd).toBeCloseTo(-1.1045, 6);
    expect(warn).toHaveBeenCalledOnce();
  });
});
