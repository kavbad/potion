// Boot-time frontier ↔ registry consistency (the 2026-08-21 production lesson:
// a frontier routing to a model the loaded registry could not resolve turned
// every measured route into a 503 while /readyz stayed green).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { strategyHash, type FrontierPoint, type JudgeConfig, type StrategyConfig } from '@potion/core';
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
    // A best-of-n judge is a JudgeConfig (`model` + optional `rubric`) — this
    // fixture used to hold an llm-judge SCORING method (`judgeModel`/`scale`),
    // a shape no StrategyConfig can contain.
    const judge: JudgeConfig = { model: 'J', rubric: 'r' };
    const cases: Array<[StrategyConfig, string[]]> = [
      [{ type: 'single', model: 'A' }, ['A']],
      // CascadeStage escalation is `escalateIf.confidenceBelow`, never a
      // top-level `confidenceThreshold` (the field runCascade cannot read).
      [{ type: 'cascade', stages: [{ model: 'A', escalateIf: { confidenceBelow: 0.5 } }, { model: 'B' }], confidenceMethod: 'logprob' }, ['A', 'B']],
      [{ type: 'best-of-n', model: 'A', n: 3, judge }, ['A', 'J']],
      [{ type: 'draft-verify', draftModel: 'A', verifierModel: 'B' }, ['A', 'B']],
      // FusionConfig keys on `method`, not `kind`, and 'vote' is not one of
      // its methods; concat-rank is the model-free one, so the expectation
      // (models reached through `models[]` only) is unchanged.
      [{ type: 'ensemble', models: ['A', 'B', 'C'], fusion: { method: 'concat-rank' } }, ['A', 'B', 'C']],
      [{ type: 'decompose', decomposerModel: 'D', routing: { 'code-gen': 'A', extraction: 'B' } }, ['A', 'B', 'D']],
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
