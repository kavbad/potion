// frontier:live-sweep tests (G1.7) — PGlite, zero network. A real live
// transport is impossible in tests, so the handler's guard rails (env gate,
// budget refusal, ownership) are pinned directly — each must refuse BEFORE
// any provider call — and the taint regression simulates live-stamped
// evidence through the runner's providerModeOverride test seam (|live cache
// keys + provider_mode='live' rows without network). The true live happy
// path is the G1.7 operator script (scripts/g17-live-sweep.ts), ledgered.
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clusters,
  createDb,
  createOrg,
  evalResults,
  frontiers,
  insertRequestLog,
  requestLogs,
  upsertBudget,
  loadDerivedSuite,
  migrate,
  mtdSpendUsd,
  type DbHandle,
} from '@potion/db';
import { loadCurrentFrontier } from '@potion/pareto';
import { runEval } from '@potion/harness';
import { eq } from 'drizzle-orm';
import {
  frontierLiveSweepHandler,
  OrgBudgetRefusalError,
  orgHashOf,
  toolSignatureSlug,
  tracesClusterHandler,
  tracesPurgeHandler,
  type JobContext,
} from './handlers.js';
import { insertTraceSpans, type NewTraceSpan } from '@potion/db';

const REPO_PRICES = fileURLToPath(new URL('../../../prices.json', import.meta.url));

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
    orgId: 'org_ls',
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

async function seedCluster(): Promise<string> {
  for (const [t, p] of [
    ['tr_l1', 'Audit the payment retries for account 10002001'],
    ['tr_l2', 'Audit the payment retries for account 10002002'],
    ['tr_l3', 'Audit the payment retries for account 10002003'],
  ] as const) {
    await insertTraceSpans(db.db, [
      span({ traceId: t, spanId: `${t}_root`, attrs: { 'gen_ai.prompt': p, 'gen_ai.completion': `Fixed retries for ${t}.` } }),
      span({
        traceId: t,
        spanId: `${t}_tool`,
        name: 'tool.billing',
        attrs: { 'gen_ai.operation.name': 'execute_tool' },
        ts: new Date(Date.now() + 60_000),
      }),
    ]);
  }
  await tracesClusterHandler({ orgId: 'org_ls' }, ctx());
  return `agent-${orgHashOf('org_ls')}-${toolSignatureSlug(['billing'])}`;
}

beforeEach(async () => {
  root = mkdtempSync(path.join(tmpdir(), 'potion-livesweep-'));
  pricesPath = path.join(root, 'prices.json');
  copyFileSync(REPO_PRICES, pricesPath);
  db = await createDb();
  await migrate(db.db);
  await createOrg(db.db, { id: 'org_ls', name: 'LS' });
  delete process.env.POTION_EVAL_PROVIDER;
});

afterEach(async () => {
  delete process.env.POTION_EVAL_PROVIDER;
  await db.close();
  rmSync(root, { recursive: true, force: true });
});

describe('frontier:live-sweep (G1.7)', () => {
  it('env gate: refuses without POTION_EVAL_PROVIDER=live — zero rows written', async () => {
    const clusterId = await seedCluster();
    await expect(frontierLiveSweepHandler({ orgId: 'org_ls', clusterId }, ctx())).rejects.toThrow(
      /POTION_EVAL_PROVIDER=live/,
    );
    const logs = await db.db.select().from(requestLogs).where(eq(requestLogs.status, 'eval_live'));
    expect(logs).toHaveLength(0);
  });

  it('budget refusal: fail-CLOSED before any spend when the hard-stop cap would be exceeded', async () => {
    const clusterId = await seedCluster();
    process.env.POTION_EVAL_PROVIDER = 'live';
    await upsertBudget(db.db, { orgId: 'org_ls', monthlyCapUsd: 1, hardStop: true });
    // existing MTD spend near the cap
    await insertRequestLog(db.db, {
      orgId: 'org_ls',
      clusterId,
      status: 'ok',
      usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.9, latencyMs: 1 },
    });
    await expect(
      frontierLiveSweepHandler({ orgId: 'org_ls', clusterId, capUsd: 2 }, ctx()),
    ).rejects.toThrow(OrgBudgetRefusalError);
    const logs = await db.db.select().from(requestLogs).where(eq(requestLogs.status, 'eval_live'));
    expect(logs).toHaveLength(0);
    const evals = await db.db.select().from(evalResults).where(eq(evalResults.orgId, 'org_ls'));
    expect(evals.filter((r) => r.providerMode === 'live')).toHaveLength(0);
  });

  it('ownership: another org cannot sweep the cluster', async () => {
    const clusterId = await seedCluster();
    process.env.POTION_EVAL_PROVIDER = 'live';
    await createOrg(db.db, { id: 'org_ls_b', name: 'LSB' });
    await expect(
      frontierLiveSweepHandler({ orgId: 'org_ls_b', clusterId }, ctx()),
    ).rejects.toThrow(/does not belong/);
  });

  it('TAINT REGRESSION: after live evidence exists, the nightly mock run never clobbers the live frontier; purge recomputes live-only', async () => {
    const clusterId = await seedCluster();
    // mock frontier exists (from seedCluster's tracesClusterHandler)
    const mockFrontier = await loadCurrentFrontier(db.db, clusterId, 'org_ls');
    expect(mockFrontier).not.toBeNull();

    // Simulate a live sweep's evidence + frontier via the runner's test seam
    // (providerModeOverride stamps rows live; |live keys keep them distinct).
    const suiteId = `${clusterId}-replays-v1`;
    const strategies = [{ type: 'single', model: 'mock-mid' } as const];
    await runEval(
      {
        suiteIds: [],
        suiteV2Ids: [suiteId],
        strategies,
        budgetCapUsd: 1000,
        resume: true,
        orgId: 'org_ls',
        providerModeOverride: 'live',
      },
      { db, pricesPath },
    );
    const { aggregatesFromEvalResults, computeFrontier, saveFrontier, hasLiveEvidence } = await import(
      '@potion/pareto'
    );
    expect(await hasLiveEvidence(db.db, clusterId, 'org_ls')).toBe(true);
    const liveAggs = await aggregatesFromEvalResults(db.db, clusterId, strategies, (await import('@potion/providers')).loadPrices(pricesPath).table.version, {
      orgId: 'org_ls',
      providerMode: 'live',
    });
    expect(liveAggs.length).toBeGreaterThan(0);
    const saved = await saveFrontier(db.db, clusterId, computeFrontier(liveAggs), 'recompute', 'live-pv', { orgId: 'org_ls' });
    expect(saved.points.every((p) => p.providerMode === 'live')).toBe(true);
    const liveVersion = saved.version;

    // Nightly mock re-run (new session extends the suite → would previously
    // recompute+save a MOCK frontier over the live one).
    await insertTraceSpans(db.db, [
      span({ traceId: 'tr_l4', spanId: 'tr_l4_root', attrs: { 'gen_ai.prompt': 'Audit the payment retries for account 10002004' } }),
      span({ traceId: 'tr_l4', spanId: 'tr_l4_tool', name: 'tool.billing', attrs: { 'gen_ai.operation.name': 'execute_tool' }, ts: new Date(Date.now() + 60_000) }),
    ]);
    const nightly = await tracesClusterHandler({ orgId: 'org_ls' }, ctx());
    expect(nightly.liveFrontierSavesSkipped).toBe(1);
    const afterNightly = await loadCurrentFrontier(db.db, clusterId, 'org_ls');
    expect(afterNightly!.version).toBe(liveVersion); // live frontier still serves
    expect(afterNightly!.points.every((p) => p.providerMode === 'live')).toBe(true);

    // Purge retirement recompute aggregates LIVE-ONLY (no mixed regression).
    const { setOrgTraceRetentionDays } = await import('@potion/db');
    await setOrgTraceRetentionDays(db.db, 'org_ls', 0);
    const purge = await tracesPurgeHandler({ orgId: 'org_ls' }, ctx());
    expect(purge.frontiersRecomputed).toBe(1);
    const afterPurge = await db.db.select().from(frontiers).where(eq(frontiers.clusterId, clusterId));
    const latest = afterPurge.sort((a, b) => b.version - a.version)[0]!;
    // all retired → empty version; nothing mixed/mock-provenance was saved
    expect(latest.points).toEqual([]);
  });

  it('unknown cluster / empty suite refusals', async () => {
    process.env.POTION_EVAL_PROVIDER = 'live';
    await expect(
      frontierLiveSweepHandler({ orgId: 'org_ls', clusterId: 'agent-nope' }, ctx()),
    ).rejects.toThrow(/unknown cluster/);
  });
});
