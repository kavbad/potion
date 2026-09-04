// R2 — the two new sweep seams, proven without a live leg (the
// platform-sweep test pattern): grammar-generated shapes bought explicitly,
// and the pre-spend latency gate. Plus the latency-evidence query on PGlite.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { strategyHash, type StrategyConfig } from '@potion/core';
import { createDb, evalResults, migrate, singleModelLatencyP95, type DbHandle } from '@potion/db';
import { buildRegistry } from '@potion/researcher';
import { loadPrices } from '@potion/providers';
import { fileURLToPath } from 'node:url';
import { gateMixturesByP95, generateSweepShapes } from './handlers.js';

const REPO_PRICES = fileURLToPath(new URL('../../../prices.json', import.meta.url));

describe('generateSweepShapes (R2)', () => {
  const registry = buildRegistry(loadPrices(REPO_PRICES).table);
  const answerers = registry.filter((e) => e.cls !== 'judge').slice(0, 4);

  it('buys only the named shapes, never singles, under the leg budget', () => {
    const candidates = new Map<string, StrategyConfig>();
    const got = generateSweepShapes({ answerers, registry, shapes: ['draft-verify', 'best-of-n'], shapeBudget: 6, candidates });
    expect(got.length).toBeGreaterThan(0);
    expect(got.length).toBeLessThanOrEqual(6);
    for (const g of got) expect(['draft-verify', 'best-of-n']).toContain(g.type);
    // everything reported is also a candidate now, under its own hash
    for (const g of got) expect(candidates.has(g.strategyHash)).toBe(true);
    expect([...candidates.values()].every((c) => c.type !== 'single')).toBe(true);
  });

  it('never duplicates an existing candidate and stays deterministic', () => {
    const a = new Map<string, StrategyConfig>();
    const first = generateSweepShapes({ answerers, registry, shapes: ['cascade'], shapeBudget: 8, candidates: a });
    const b = new Map<string, StrategyConfig>(a); // pre-seed with the first batch
    const second = generateSweepShapes({ answerers, registry, shapes: ['cascade'], shapeBudget: 8, candidates: b });
    expect(second.map((s) => s.strategyHash)).not.toEqual(expect.arrayContaining(first.map((s) => s.strategyHash)));
    // deterministic: same inputs, same output
    const c = new Map<string, StrategyConfig>();
    const again = generateSweepShapes({ answerers, registry, shapes: ['cascade'], shapeBudget: 8, candidates: c });
    expect(again).toEqual(first);
  });
});

describe('gateMixturesByP95 (R2)', () => {
  const cheap: StrategyConfig = { type: 'single', model: 'cheap' } as StrategyConfig;
  const slowMix: StrategyConfig = { type: 'draft-verify', draftModel: 'cheap', verifierModel: 'slow' } as StrategyConfig;
  const fastMix: StrategyConfig = { type: 'draft-verify', draftModel: 'cheap', verifierModel: 'fast' } as StrategyConfig;
  const unknownMix: StrategyConfig = { type: 'draft-verify', draftModel: 'cheap', verifierModel: 'mystery' } as StrategyConfig;
  const evidence = new Map([
    ['cheap', 1000],
    ['fast', 1500],
    ['slow', 60000],
  ]);

  function pool(): Map<string, StrategyConfig> {
    return new Map([cheap, slowMix, fastMix, unknownMix].map((c) => [strategyHash(c), c]));
  }

  it('refuses over-cap mixtures pre-spend, keeps the rest, itemises the unprojectable', () => {
    const candidates = pool();
    const gateable = new Set(candidates.keys());
    const { latencyRefused, latencyUnprojected } = gateMixturesByP95(candidates, gateable, 10_000, evidence);
    expect(latencyRefused).toEqual([
      { strategyHash: strategyHash(slowMix), type: 'draft-verify', projectedP95Ms: 61000 },
    ]);
    expect(latencyUnprojected).toEqual([strategyHash(unknownMix)]);
    expect(candidates.has(strategyHash(slowMix))).toBe(false); // refused = not measured
    expect(candidates.has(strategyHash(fastMix))).toBe(true);
    expect(candidates.has(strategyHash(unknownMix))).toBe(true); // unknown is not slow
    expect(candidates.has(strategyHash(cheap))).toBe(true); // singles never gated
  });

  it('a carried-forward incumbent re-measures by right, over-cap or not', () => {
    const candidates = pool();
    const gateable = new Set([...candidates.keys()].filter((h) => h !== strategyHash(slowMix)));
    const { latencyRefused } = gateMixturesByP95(candidates, gateable, 10_000, evidence);
    expect(latencyRefused).toEqual([]);
    expect(candidates.has(strategyHash(slowMix))).toBe(true);
  });
});

describe('singleModelLatencyP95 (R2 evidence base)', () => {
  let db: DbHandle;
  let dir: string;
  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'potion-lat-'));
    db = await createDb(`pglite://${dir}`);
    await migrate(db.db);
  });
  afterEach(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function cell(
    model: string,
    p95: number,
    opts: { mode?: string; type?: string } = {},
  ): typeof evalResults.$inferInsert {
    const config =
      opts.type === 'cascade'
        ? ({ type: 'cascade', stages: [{ model }, { model }], confidenceMethod: 'self-report-calibrated' } as StrategyConfig)
        : ({ type: 'single', model } as StrategyConfig);
    return {
      runId: 'run-lat',
      itemId: `it-${model}-${p95}-${opts.mode ?? 'live'}-${opts.type ?? 'single'}`,
      clusterId: 'extraction',
      strategyHash: strategyHash(config),
      strategyConfig: config,
      quality: 1,
      scorer: 'exact',
      usage: { inputTokens: 1, outputTokens: 1, costUsd: 0, latencyMs: p95 },
      latencyMs: { p50: p95 / 2, p95, mean: p95 / 2 },
      modelVersions: {},
      pricesVersion: 'v-test',
      providerMode: opts.mode ?? 'live',
      cacheKey: `ck-${model}-${p95}-${opts.mode ?? 'live'}-${opts.type ?? 'single'}`,
      // eval_results.created_at is TEXT holding an ISO string (it mirrors
      // core EvalResult.createdAt), so write one — the query under test does
      // not filter on it.
      createdAt: new Date().toISOString(),
    };
  }

  it('aggregates live single cells only — mock rows and mixtures are excluded', async () => {
    await db.db.insert(evalResults).values([
      cell('m-a', 1000),
      cell('m-a', 2000),
      cell('m-a', 3000),
      cell('m-a', 900, { mode: 'mock' }), // excluded: wrong provenance
      cell('m-b', 400, { type: 'cascade' }), // excluded: not a single
    ]);
    const got = await singleModelLatencyP95(db.db, 'extraction', 'live');
    expect(got.has('m-b')).toBe(false);
    const p95 = got.get('m-a');
    expect(p95).toBeDefined();
    expect(p95!).toBeGreaterThan(2000); // 95th percentile of {1000,2000,3000}
    expect(p95!).toBeLessThanOrEqual(3000);
    const other = await singleModelLatencyP95(db.db, 'code-gen', 'live');
    expect(other.size).toBe(0);
  });
});
