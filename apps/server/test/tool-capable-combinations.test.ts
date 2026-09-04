// MIXING M3: a measured, tool-capable combination serves tool requests; an
// unmeasured one is narrowed away as before.
import { describe, expect, it } from 'vitest';
import { strategyHash, type Frontier, type FrontierPoint, type Policy, type StrategyConfig } from '@potion/core';
import { resolveOperatingPoint } from '../src/routes/chat.js';

const SINGLE = { type: 'single', model: 'mock-cheap' } as const;
const CASCADE: StrategyConfig = { type: 'cascade', stages: [{ model: 'mock-cheap', escalateIf: { confidenceBelow: 0.9 } }, { model: 'mock-frontier' }], confidenceMethod: 'self-report-calibrated' };
const COMPOSITE = { type: 'composite', startModel: 'mock-cheap', upgradeModel: 'mock-frontier', upgradeIf: { confidenceBelow: 0.9 } } as const;
const POLICY: Policy = { type: 'max_quality', costCeilingPer1K: 100 };

function point(cfg: FrontierPoint['strategyConfig'], quality: number, toolsMeasured?: boolean): FrontierPoint {
  return { clusterId: 'agentic-tool-use', strategyHash: strategyHash(cfg), strategyConfig: cfg, quality, costPer1K: 1, latencyP95: 400, providerMode: 'mock', ...(toolsMeasured !== undefined ? { evidence: { cacheKeys: [], runIds: [], n: 10, qualityCi95: 0.05, toolsMeasured } } : {}) };
}
const frontier = (points: FrontierPoint[]): Frontier => ({
  id: 'f-tool-capable',
  clusterId: 'agentic-tool-use',
  version: 1,
  parentId: null,
  trigger: 'manual',
  points,
  pricesVersion: 'test-prices',
  createdAt: new Date().toISOString(),
});

describe('tool-capable combinations', () => {
  it('an unmeasured cascade is narrowed away for a tool request', () => {
    const op = resolveOperatingPoint(POLICY, frontier([point(CASCADE, 0.95), point(SINGLE, 0.8)]), null, { toolCapableOnly: true });
    expect(op.config).toEqual(SINGLE);
  });
  it('a cascade measured with tools serves the tool request', () => {
    const op = resolveOperatingPoint(POLICY, frontier([point(CASCADE, 0.95, true), point(SINGLE, 0.8)]), null, { toolCapableOnly: true });
    expect(op.config).toEqual(CASCADE);
  });
  it('a composite never does, measured or not — its upgrade check scores text', () => {
    const op = resolveOperatingPoint(POLICY, frontier([point(COMPOSITE, 0.95, true), point(SINGLE, 0.8)]), null, { toolCapableOnly: true });
    expect(op.config).toEqual(SINGLE);
  });
  it('without tools the best point is served as before', () => {
    const op = resolveOperatingPoint(POLICY, frontier([point(CASCADE, 0.95), point(SINGLE, 0.8)]), null);
    expect(op.config).toEqual(CASCADE);
  });
});
