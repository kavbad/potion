// JOURNEY instrument tests (eval-review adoption, 2026-08-25): task
// completion as the atomic outcome. Templating, chaining, usage summing,
// the field-contains end-artifact scorer, the checked-in journey-e2e-v1
// suite, and a mock end-to-end run whose SUMMED latency proves the runner
// executed the chain (mock latency profile: frontier = 1800ms/call, so a
// 2-step journey must report exactly 3600).
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EvalItem } from '@potion/core';
import { createDb, migrate, type DbHandle } from '@potion/db';
import { estimateItemCostUsd } from './estimate.js';
import { executeJourney, templateJourneyPrompt } from './journey.js';
import { loadSuiteV2 } from './ingest/suite-v2.js';
import { runEval, type RunDeps } from './runner.js';
import { scoreAnswer, scoreFieldContains } from './scorers.js';

const PRICES_PATH = fileURLToPath(new URL('../../../prices.json', import.meta.url));

describe('templateJourneyPrompt', () => {
  const outputs = ['first', 'second', 'third'];
  it('{{prev}} is the last output; {{prevN}} reaches back', () => {
    expect(templateJourneyPrompt('use {{prev}}', outputs)).toBe('use third');
    expect(templateJourneyPrompt('a {{prev1}} b {{prev2}}', outputs)).toBe('a second b first');
  });
  it('out-of-range references resolve to empty, never crash', () => {
    expect(templateJourneyPrompt('x {{prev9}} y', outputs)).toBe('x  y');
  });
});

describe('executeJourney', () => {
  const item: EvalItem = {
    id: 'j-unit',
    clusterId: 'journey' as never,
    prompt: [{ role: 'user', content: 'step one' }],
    journeySteps: [
      { clusterId: 'classification', prompt: 'classify: {{prev}}' },
      { clusterId: 'extraction', prompt: 'final from {{prev}} and {{prev1}}' },
    ],
    scoring: { kind: 'exact' },
  };
  it('chains outputs, sums usage, returns only the FINAL text', async () => {
    const seen: string[] = [];
    const out = await executeJourney(item, async (messages, stepIndex) => {
      seen.push(`${stepIndex}:${messages[0]!.content}`);
      return {
        text: `out${stepIndex}`,
        usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.01, latencyMs: 100 },
      };
    });
    expect(seen).toEqual([
      '0:step one',
      '1:classify: out0',
      '2:final from out1 and out0',
    ]);
    expect(out.text).toBe('out2');
    expect(out.usage).toEqual({ inputTokens: 30, outputTokens: 15, costUsd: 0.03, latencyMs: 300 });
  });
});

describe('scoreFieldContains (the journey end-artifact check)', () => {
  const scoring = {
    kind: 'field-contains',
    fields: { 'extract.order_ref': '88231', priority: ['standard', 'std'] },
  } as const;
  it('dotted paths + accepted alternatives + case-insensitive contains', () => {
    const answer = '{"extract":{"order_ref":"order 88231"},"priority":"Standard"}';
    expect(scoreFieldContains(answer, scoring)).toBe(1);
  });
  it('fractional credit per missed path; fenced JSON is unwrapped', () => {
    const fenced = '```json\n{"extract":{"order_ref":"88231"},"priority":"urgent"}\n```';
    expect(scoreFieldContains(fenced, scoring)).toBe(0.5);
  });
  it('unparseable answer scores 0', () => {
    expect(scoreFieldContains('not json at all', scoring)).toBe(0);
  });
  it('dispatches through scoreAnswer with scorer name field-contains', async () => {
    const item: EvalItem = {
      id: 'fc-01',
      clusterId: 'journey' as never,
      prompt: [{ role: 'user', content: 'x' }],
      scoring: scoring as never,
    };
    const out = await scoreAnswer(item, '{"extract":{"order_ref":"88231"},"priority":"standard"}');
    expect(out).toEqual({ quality: 1, scorer: 'field-contains' });
  });
});

describe('journey-e2e-v1 (the checked-in promoted suite)', () => {
  it('loads: 9 journeys, deterministic ends only, every item multi-step', () => {
    const { manifest, items } = loadSuiteV2('journey-e2e-v1');
    expect(manifest.clusterId).toBe('journey');
    expect(items).toHaveLength(9);
    for (const item of items) {
      expect(item.clusterId).toBe('journey');
      expect(item.journeySteps!.length).toBeGreaterThanOrEqual(1);
      expect(['field-contains', 'code-exec']).toContain(item.scoring.kind);
    }
    // The constraint-erosion lesson stays in the data: the code family's
    // restate step must pin the function name verbatim (requirement 1).
    const jc = items.find((i) => i.id === 'jc-a')!;
    expect(jc.prompt[0]!.content).toContain('MUST state the exact function name');
  });
});

describe('journey preflight projection (the belt must price every step)', () => {
  const prices = {
    version: 'jt-v1',
    updatedAt: '2026-08-25',
    entries: [{ alias: 'm1', provider: 'mock' as const, model: 'm1-v1', inputPer1M: 100, outputPer1M: 100 }],
  };
  it('a journey projects strictly MORE than its first step alone', () => {
    const single: EvalItem = {
      id: 'p-01',
      clusterId: 'journey' as never,
      prompt: [{ role: 'user', content: 'step one prompt' }],
      scoring: { kind: 'exact' },
    };
    const journey: EvalItem = {
      ...single,
      journeySteps: [
        { clusterId: 'extraction', prompt: 'refine {{prev}}' },
        { clusterId: 'extraction', prompt: 'final from {{prev}} and {{prev1}}' },
      ],
    };
    const strategy = { type: 'single', model: 'm1' } as const;
    const one = estimateItemCostUsd(strategy as never, single, prices as never);
    const chain = estimateItemCostUsd(strategy as never, journey, prices as never);
    expect(chain).toBeGreaterThan(one * 2.5); // 3 steps, refs bounded at a full answer each
  });
});

describe('runEval executes journey items end-to-end (mock)', () => {
  let handle: DbHandle;
  const suitesV2Dir = mkdtempSync(`${tmpdir()}/potion-journey-v2-`);
  beforeAll(async () => {
    handle = await createDb('pglite://');
    await migrate(handle.db);
    const dir = `${suitesV2Dir}/journey-mock-v1`;
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      `${dir}/manifest.json`,
      JSON.stringify({
        suiteId: 'journey-mock-v1',
        clusterId: 'journey',
        version: '1.0.0',
        source: { kind: 'authored', name: 'journey mechanics fixture', license: 'Proprietary' },
        items: 'items.jsonl',
        scoring: { allowed: ['field-contains'] },
        createdAt: '2026-08-25T00:00:00.000Z',
      }),
    );
    writeFileSync(
      `${dir}/items.jsonl`,
      JSON.stringify({
        id: 'jm-01',
        clusterId: 'journey',
        prompt: [{ role: 'user', content: 'draft a plan' }],
        journeySteps: [{ clusterId: 'extraction', prompt: 'as json: {{prev}}' }],
        scoring: { kind: 'field-contains', fields: { anything: 'unmatchable-by-mock-prose' } },
      }) + '\n',
    );
  });
  afterAll(async () => {
    await handle.close();
  });

  it('one journey = ONE result; latency is the SUM of its steps', async () => {
    const summary = await runEval(
      {
        suiteIds: [],
        suiteV2Ids: ['journey-mock-v1'],
        strategies: [{ type: 'single', model: 'mock-frontier' }],
        budgetCapUsd: 5,
      },
      { db: handle, suitesV2Dir, pricesPath: PRICES_PATH } as RunDeps,
    );
    expect(summary.results).toHaveLength(1);
    const r = summary.results[0]!;
    expect(r.itemId).toBe('jm-01');
    expect(r.clusterId).toBe('journey');
    expect(r.scorer).toBe('field-contains');
    // Mock latency profile: frontier-class = 1800ms per call — a 2-step
    // journey MUST report 3600, the proof the chain actually executed.
    expect(r.usage.latencyMs).toBe(3600);
    expect(r.quality).toBeGreaterThanOrEqual(0);
    expect(r.quality).toBeLessThanOrEqual(1);
    expect(summary.aggregates).toHaveLength(1);
    expect(summary.aggregates[0]!.clusterId).toBe('journey');
    expect(summary.aggregates[0]!.qualityCi).toBeDefined();
  });
});
