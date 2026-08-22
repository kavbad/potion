// Boot-time frontier ↔ registry consistency (the 2026-08-21 production lesson:
// a frontier routing to a model the loaded registry could not resolve turned
// every measured route into a 503 while /readyz stayed green).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { strategyHash, type FrontierPoint, type StrategyConfig } from '@potion/core';
import { saveFrontier } from '@potion/pareto';
import { buildServer } from '../src/server.js';
import {
  checkPlatformFrontiersAgainstRegistry,
  formatFailure,
  modelsInStrategy,
} from '../src/frontier-registry-check.js';

function point(clusterId: string, config: StrategyConfig, cost = 1): FrontierPoint {
  return { clusterId, strategyHash: strategyHash(config), strategyConfig: config, quality: 0.9, costPer1K: cost, latencyP95: 100 };
}

describe('modelsInStrategy — every shape, every model field', () => {
  it('finds the model in each strategy shape, including nested judge/routing/stages', () => {
    const judge = { kind: 'llm-judge', rubric: 'r', judgeModel: 'J', scale: [0, 1] } as const;
    const cases: Array<[StrategyConfig, string[]]> = [
      [{ type: 'single', model: 'A' }, ['A']],
      [{ type: 'cascade', stages: [{ model: 'A', confidenceThreshold: 0.5 }, { model: 'B', confidenceThreshold: 0 }] as never, confidenceMethod: 'logprob' }, ['A', 'B']],
      [{ type: 'best-of-n', model: 'A', n: 3, judge } as never, ['A', 'J']],
      [{ type: 'draft-verify', draftModel: 'A', verifierModel: 'B' }, ['A', 'B']],
      [{ type: 'ensemble', models: ['A', 'B', 'C'], fusion: { kind: 'vote' } } as never, ['A', 'B', 'C']],
      [{ type: 'decompose', decomposerModel: 'D', routing: { 'code-gen': 'A', extraction: 'B' } } as never, ['A', 'B', 'D']],
      [{ type: 'composite', startModel: 'A', upgradeModel: 'B', upgradeIf: { confidenceBelow: 0.5 } }, ['A', 'B']],
    ];
    for (const [cfg, expected] of cases) expect(modelsInStrategy(cfg)).toEqual(expected);
  });
});

describe('checkPlatformFrontiersAgainstRegistry', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await buildServer({ seed: false });
  });
  afterAll(async () => {
    await app.close();
  });

  it('passes when every routed model resolves in the registry', async () => {
    await saveFrontier(app.potion.db.db, 'code-gen', [point('code-gen', { type: 'single', model: 'mock-mid' })], 'manual', 'test-prices');
    const report = await checkPlatformFrontiersAgainstRegistry(app.potion.db.db, app.potion.prices, { production: false });
    expect(report.clustersChecked).toContain('code-gen');
    expect(report.unresolved).toEqual([]);
  });

  it('reports a frontier that routes to a model the registry cannot resolve', async () => {
    await saveFrontier(
      app.potion.db.db,
      'extraction',
      [point('extraction', { type: 'single', model: 'mock-mid' }), point('extraction', { type: 'single', model: 'or-not-in-registry' }, 0.01)],
      'manual',
      'prices-from-a-campaign',
    );
    const report = await checkPlatformFrontiersAgainstRegistry(app.potion.db.db, app.potion.prices, { production: false });
    expect(report.unresolved.map((u) => u.model)).toEqual(['or-not-in-registry']);
    expect(report.unresolved[0]!.clusterId).toBe('extraction');
    expect(report.frontierPricesVersions).toContain('prices-from-a-campaign');
    const msg = formatFailure(report);
    expect(msg).toContain('or-not-in-registry');
    expect(msg).toContain('POTION_PRICES_PATH');
  });

  it('FAILS CLOSED in production: the mismatch is a boot error, not a log line', async () => {
    await expect(
      checkPlatformFrontiersAgainstRegistry(app.potion.db.db, app.potion.prices, { production: true }),
    ).rejects.toThrow(/or-not-in-registry/);
  });
});
