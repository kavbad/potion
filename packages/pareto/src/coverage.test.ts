// COVERAGE RANKING (SERVING-ROADMAP S7 L3) on a real database.
//
// The unit tests in core cover the verdict logic. What is proven here is the
// ASSEMBLY — that the evidence handed to that logic is the same evidence
// serving would use:
//
//   mock points are not coverage (serving refuses them under the provenance
//   guard, so counting them would report a cluster as measured when nothing
//   was ever bought);
//
//   a tool-capable CASCADE is not tool coverage (serving narrows tool
//   requests to single points, so that cascade could never be selected);
//
//   and an unmeasured model's absent context window does not become a
//   context guarantee.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FrontierPoint } from '@potion/core';
import { DemandAccumulator } from '@potion/core';
import {
  addScannedModels,
  createDb,
  mergeDemandDeltas,
  migrate,
  type DbHandle,
} from '@potion/db';
import { saveFrontier } from './persistence.js';
import { rankCoverageGaps } from './coverage.js';

const AT = new Date('2026-08-19T12:00:00Z');
const SMALL = { minOrgs: 2, minRequests: 2 };

function point(over: Partial<FrontierPoint>): FrontierPoint {
  return {
    clusterId: 'code-gen',
    strategyHash: 'h',
    strategyConfig: { type: 'single', model: 'tooly' },
    quality: 0.9,
    costPer1K: 1,
    latencyP95: 500,
    providerMode: 'live',
    ...over,
  } as FrontierPoint;
}

async function demand(
  handle: DbHandle,
  over: { bucket?: string; shapeClass?: string; requests?: number } = {},
): Promise<void> {
  const acc = new DemandAccumulator();
  for (const orgId of ['org-a', 'org-b', 'org-c']) {
    for (let i = 0; i < (over.requests ?? 10); i++) {
      acc.observe({
        bucket: over.bucket ?? 'code-gen',
        shapeClass: over.shapeClass ?? 'no-tools/sync/0-1k',
        at: AT,
        orgId,
        confidence: 0.7,
      });
    }
  }
  await mergeDemandDeltas(handle.db, acc.drain(), SMALL);
}

describe('rankCoverageGaps', () => {
  let handle: DbHandle;
  beforeAll(async () => {
    handle = await createDb('pglite://');
    await migrate(handle.db);
    await addScannedModels(
      handle.db,
      [
        { alias: 'tooly', provider: 'openrouter', model: 'x/tooly', inputPer1M: 1, outputPer1M: 2, supportsTools: true, contextLength: 32_000 },
        { alias: 'plain', provider: 'openrouter', model: 'x/plain', inputPer1M: 1, outputPer1M: 2, supportsTools: false, contextLength: 8_000 },
        { alias: 'mystery', provider: 'openrouter', model: 'x/mystery', inputPer1M: 1, outputPer1M: 2 },
      ],
      'pv-test',
    );
  }, 60_000);
  afterAll(async () => {
    await handle.close();
  });

  it('reports no_live_points for demand on a cluster with only MOCK evidence', async () => {
    await demand(handle, { bucket: 'summarization' });
    await saveFrontier(
      handle.db,
      'summarization',
      [point({ clusterId: 'summarization', providerMode: 'mock', strategyHash: 'm1' })],
      'manual',
      'pv-test',
    );
    const gaps = await rankCoverageGaps(handle.db);
    const gap = gaps.find((g) => g.cell.bucket === 'summarization')!;
    expect(gap.reason).toBe('no_live_points');
    expect(gap.evidence!.livePoints).toBe(0);
  }, 60_000);

  it('does not count a tool-capable CASCADE as tool coverage', async () => {
    await demand(handle, { bucket: 'extraction', shapeClass: 'tools/sync/0-1k' });
    await saveFrontier(
      handle.db,
      'extraction',
      [
        // Every stage is tool-capable, and it still cannot serve a tools
        // request: the serve path narrows to single points.
        point({
          clusterId: 'extraction',
          strategyHash: 'casc',
          strategyConfig: {
            type: 'cascade',
            stages: [{ model: 'tooly' }, { model: 'tooly' }],
            confidenceMethod: 'logprob',
          },
        }),
        point({ clusterId: 'extraction', strategyHash: 'plain1', strategyConfig: { type: 'single', model: 'plain' } }),
        point({ clusterId: 'extraction', strategyHash: 'plain2', strategyConfig: { type: 'single', model: 'plain' }, quality: 0.8 }),
      ],
      'manual',
      'pv-test',
    );
    const gap = (await rankCoverageGaps(handle.db)).find((g) => g.cell.bucket === 'extraction')!;
    expect(gap.reason).toBe('no_tool_capable_point');
    expect(gap.evidence!.livePoints).toBe(3);
    expect(gap.evidence!.toolCapablePoints).toBe(0);
  }, 60_000);

  it('takes a strategy context window from its SMALLEST member', async () => {
    await demand(handle, { bucket: 'general', shapeClass: 'no-tools/sync/16k-64k' });
    await saveFrontier(
      handle.db,
      'general',
      [
        // 32k and 8k ensembled: the pair can only hold 8k.
        point({
          clusterId: 'general',
          strategyHash: 'ens',
          strategyConfig: { type: 'ensemble', models: ['tooly', 'plain'], fusion: { method: 'concat-rank' } },
        }),
      ],
      'manual',
      'pv-test',
    );
    const gap = (await rankCoverageGaps(handle.db)).find((g) => g.cell.bucket === 'general')!;
    expect(gap.evidence!.maxContextTokens).toBe(8_000);
    expect(gap.reason).toBe('context_too_short');
    expect(gap.requiredContextTokens).toBe(16_000);
  }, 60_000);

  it('an unmeasured context window is not a context guarantee', async () => {
    await demand(handle, { bucket: 'translation', shapeClass: 'no-tools/sync/4k-16k' });
    await saveFrontier(
      handle.db,
      'translation',
      [point({ clusterId: 'translation', strategyHash: 'myst', strategyConfig: { type: 'single', model: 'mystery' } })],
      'manual',
      'pv-test',
    );
    const gap = (await rankCoverageGaps(handle.db)).find((g) => g.cell.bucket === 'translation')!;
    expect(gap.evidence!.maxContextTokens).toBeNull();
    expect(gap.reason).toBe('context_too_short');
  }, 60_000);

  it('ranks worst-first, totally ordered, and hides covered cells by default', async () => {
    // A fully covered cluster: three live single points, tool-capable, roomy.
    await demand(handle, { bucket: 'classification' });
    await saveFrontier(
      handle.db,
      'classification',
      [1, 2, 3].map((i) =>
        point({ clusterId: 'classification', strategyHash: `ok${i}`, quality: 0.8 + i / 100 }),
      ),
      'manual',
      'pv-test',
    );
    const gaps = await rankCoverageGaps(handle.db);
    expect(gaps.map((g) => g.cell.bucket)).not.toContain('classification');
    for (let i = 1; i < gaps.length; i++) {
      expect(gaps[i - 1]!.score).toBeGreaterThanOrEqual(gaps[i]!.score);
    }
    // Same input, same order — a job that acts on "the top gap" must act on
    // the same one twice.
    const again = await rankCoverageGaps(handle.db);
    expect(again.map((g) => g.cell.cellKey)).toEqual(gaps.map((g) => g.cell.cellKey));

    const withCovered = await rankCoverageGaps(handle.db, { includeCovered: true });
    expect(withCovered.map((g) => g.cell.bucket)).toContain('classification');
    expect(withCovered.find((g) => g.cell.bucket === 'classification')!.score).toBe(0);
  }, 60_000);

  it('an unassigned region is a gap no cluster evidence can close', async () => {
    await demand(handle, { bucket: 'lsh:1234', requests: 40 });
    const gap = (await rankCoverageGaps(handle.db)).find((g) => g.cell.bucket === 'lsh:1234')!;
    expect(gap.reason).toBe('unassigned_region');
    expect(gap.evidence).toBeNull();
  }, 60_000);
});
