import { describe, expect, it } from 'vitest';
import type { ChatMessage, PriceTable, StrategyConfig } from '@potion/core';
import { createProviders } from '@potion/providers';
import type { CompleteRequest, Provider } from '@potion/providers';
import {
  calibrateSelfReport,
  createResolver,
  execute,
  SELF_REPORT_CALIBRATION,
  type ExecContext,
} from './index.js';

const PRICES: PriceTable = {
  version: '2026-08-04',
  updatedAt: '2026-08-04',
  entries: [
    // Priced aliases routed through the mock transport so cost math is real.
    { alias: 'cheap-class', provider: 'anthropic', model: 'claude-haiku-4-5-20251001', inputPer1M: 1, outputPer1M: 5 },
    { alias: 'frontier-priced', provider: 'anthropic', model: 'claude-opus-4-1-20250805', inputPer1M: 15, outputPer1M: 75 },
    { alias: 'mock-cheap', provider: 'mock', model: 'mock-cheap-v1', inputPer1M: 0, outputPer1M: 0 },
    { alias: 'mock-frontier', provider: 'mock', model: 'mock-frontier-v1', inputPer1M: 0, outputPer1M: 0 },
  ],
};

const MESSAGES: ChatMessage[] = [
  { role: 'system', content: 'You are terse.' },
  { role: 'user', content: 'Summarize the plot of Hamlet briefly.' },
];

/** All aliases route through the deterministic mock transport. */
function makeCtx(extra?: Partial<ExecContext>): ExecContext {
  const providers = createProviders({ prices: PRICES });
  const routed = { ...providers, anthropic: providers.mock };
  return {
    providers: routed,
    prices: PRICES,
    resolve: createResolver(routed, PRICES),
    ...extra,
  };
}

const ESCALATING: StrategyConfig = {
  type: 'cascade',
  stages: [
    { model: 'cheap-class', escalateIf: { confidenceBelow: 0.9 } },
    { model: 'frontier-priced' },
  ],
  confidenceMethod: 'logprob',
};

describe("cascade (confidenceMethod: 'logprob')", () => {
  it('escalates when confidence is below the threshold — golden transcript', async () => {
    const r = await execute(ESCALATING, MESSAGES, makeCtx({ seed: 7 }));
    expect(r.trace.map((t) => `${t.stage}:${t.decision ?? ''}`)).toEqual([
      'stage-0:escalate',
      'stage-1:accept',
    ]);
    // Deterministic transcript (seed 7):
    expect(r.trace[0]).toMatchObject({
      stage: 'stage-0',
      model: 'cheap-class',
      text: '[mock:cheap-class] result approach response example compute valid finally item complete because given concise.',
      confidence: 0.7540172473993152,
      decision: 'escalate',
    });
    expect(r.trace[1]).toMatchObject({
      stage: 'stage-1',
      model: 'frontier-priced',
      text: '[mock:frontier-priced] record note response list valid simple finally case result example answer item then given reason.',
      decision: 'accept',
    });
    expect(r.text).toBe(r.trace[1]!.text); // final stage answer wins
  });

  it('accepts at stage 0 when confidence meets the threshold (no escalation)', async () => {
    const accepting: StrategyConfig = {
      type: 'cascade',
      stages: [
        { model: 'cheap-class', escalateIf: { confidenceBelow: 0.7 } },
        { model: 'frontier-priced' },
      ],
      confidenceMethod: 'logprob',
    };
    const r = await execute(accepting, MESSAGES, makeCtx({ seed: 7 }));
    expect(r.trace).toHaveLength(1); // frontier stage never runs
    expect(r.trace[0]).toMatchObject({
      stage: 'stage-0',
      confidence: 0.7540172473993152, // >= 0.7 threshold
      decision: 'accept',
    });
    expect(r.text).toBe(
      '[mock:cheap-class] result approach response example compute valid finally item complete because given concise.',
    );
  });

  it('cost accounting: hand-computed cascade escalation total to the cent', async () => {
    // HAND-COMPUTED (mock token rule = ceil(chars/4); prices cheap-class $1/$5
    // and frontier-priced $15/$75 per 1M tokens):
    //   prompt text = 'system:You are terse.\nuser:Summarize the plot of Hamlet briefly.'
    //     = 64 chars → inputTokens = ceil(64/4) = 16 (both stages, same prompt)
    //   stage-0 answer (seed 7, cheap-class) = 110 chars → ceil(110/4) = 28 out
    //     cost0 = (16 × $1 + 28 × $5) / 1e6 = (16 + 140) / 1e6 = $0.000156
    //   stage-1 answer (seed 8, frontier-priced) = 120 chars → ceil(120/4) = 30 out
    //     cost1 = (16 × $15 + 30 × $75) / 1e6 = (240 + 2250) / 1e6 = $0.002490
    //   total = $0.000156 + $0.002490 = $0.002646 (roundCost keeps 6 decimals)
    const r = await execute(ESCALATING, MESSAGES, makeCtx({ seed: 7 }));
    expect(r.trace[0]!.usage).toMatchObject({ inputTokens: 16, outputTokens: 28, costUsd: 0.000156 });
    expect(r.trace[1]!.usage).toMatchObject({ inputTokens: 16, outputTokens: 30, costUsd: 0.00249 });
    expect(r.usage.inputTokens).toBe(32);
    expect(r.usage.outputTokens).toBe(58);
    expect(r.usage.costUsd).toBe(0.002646);
    expect(r.usage.latencyMs).toBe(300 + 1800);
  });

  it('is deterministic for a fixed ctx.seed', async () => {
    const a = await execute(ESCALATING, MESSAGES, makeCtx({ seed: 7 }));
    const b = await execute(ESCALATING, MESSAGES, makeCtx({ seed: 7 }));
    expect(a).toEqual(b);
  });
});

describe("cascade (confidenceMethod: 'self-report-calibrated')", () => {
  const SELF_REPORT: StrategyConfig = {
    type: 'cascade',
    stages: [
      { model: 'mock-cheap', escalateIf: { confidenceBelow: 0.9 } },
      { model: 'mock-frontier' },
    ],
    confidenceMethod: 'self-report-calibrated',
  };

  it('probes self-confidence, calibrates it, and records both in the trace', async () => {
    const r = await execute(SELF_REPORT, MESSAGES, makeCtx({ seed: 7 }));
    expect(r.trace.map((t) => t.stage)).toEqual([
      'stage-0',
      'stage-0-self-report',
      'stage-1',
    ]);
    const probe = r.trace[1]!;
    expect(probe.text).toBe('CONFIDENCE: 0.58'); // mock structured fixture (seed 8)
    expect(probe.confidence).toBe(0.58); // RAW self-report
    // calibrated = 0.85 × 0.58 + 0.07 = 0.563 recorded on the STAGE entry
    expect(r.trace[0]!.confidence).toBeCloseTo(0.563, 12);
    expect(r.trace[0]!.confidence).toBe(calibrateSelfReport(0.58));
    expect(r.trace[0]!.decision).toBe('escalate'); // 0.563 < 0.9
    // probe usage is included in the aggregate
    expect(r.usage.inputTokens).toBe(
      r.trace.reduce((s, t) => s + t.usage.inputTokens, 0),
    );
  });

  it('calibration map is the documented linear fit, clamped to [0,1]', () => {
    expect(SELF_REPORT_CALIBRATION).toEqual({ slope: 0.85, intercept: 0.07 });
    expect(calibrateSelfReport(0.5)).toBeCloseTo(0.495, 12);
    expect(calibrateSelfReport(0.99)).toBeCloseTo(0.9115, 12);
    expect(calibrateSelfReport(1.2)).toBe(1);
    expect(calibrateSelfReport(-1)).toBe(0);
  });
});

describe('cascade logprob fallback', () => {
  it('warns in the trace and falls back to self-report when the provider returns no logprobConfidence', async () => {
    const providers = createProviders({ prices: PRICES });
    const stripLogprob: Provider = {
      id: 'mock',
      complete: async (req: CompleteRequest) => {
        const r = await providers.mock.complete(req);
        const { logprobConfidence: _drop, ...rest } = r;
        return rest;
      },
    };
    const routed = { ...providers, mock: stripLogprob, anthropic: stripLogprob };
    const ctx: ExecContext = {
      providers: routed,
      prices: PRICES,
      resolve: createResolver(routed, PRICES),
      seed: 7,
    };
    const r = await execute(ESCALATING, MESSAGES, ctx);
    const stages = r.trace.map((t) => t.stage);
    expect(stages[0]).toBe('stage-0');
    expect(stages[1]).toBe('stage-0-warning');
    expect(r.trace[1]!.decision).toMatch(/warn:no-logprob-confidence/);
    expect(stages[2]).toBe('stage-0-self-report');
    expect(r.trace[2]!.decision).toMatch(/fallback:no-logprob-confidence/);
    expect(r.trace[0]!.decision).toMatch(/escalate|accept/);
    // warning entry carries zero usage — cost accounting untouched
    expect(r.trace[1]!.usage.costUsd).toBe(0);
  });
});

describe('cascade validation', () => {
  it('rejects an empty stage list', async () => {
    await expect(
      execute(
        { type: 'cascade', stages: [], confidenceMethod: 'logprob' },
        MESSAGES,
        makeCtx({ seed: 7 }),
      ),
    ).rejects.toThrow(/at least one stage/);
  });
});
