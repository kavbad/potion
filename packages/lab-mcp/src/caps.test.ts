// Per-tool cap meters — derived from the durable record, fail-closed.
import { describe, expect, it } from 'vitest';
import {
  attributedEstUsd,
  attributedEstUsdForConnector,
  checkToolCaps,
  DEFAULT_TOOL_CAPS,
  toolCallCount,
  toolResultBytes,
  truncateResult,
  type StepLike,
} from './caps.js';

const modelStep = (tools: string[], estCostUsd: number): StepLike => ({
  kind: 'model',
  payload: { toolCalls: tools.map((name) => ({ function: { name } })), estCostUsd },
});
const toolStep = (toolName: string, toolOutput: unknown): StepLike => ({
  kind: 'tool',
  payload: { toolName, toolOutput },
});

describe('meters over the durable record', () => {
  const steps: StepLike[] = [
    modelStep(['github.get_me'], 0.01),
    toolStep('github.get_me', { login: 'kavon' }),
    modelStep(['github.search_code', 'github.get_me'], 0.02),
    toolStep('github.search_code', 'x'.repeat(100)),
    toolStep('github.get_me', { login: 'kavon' }),
    modelStep([], 0.5), // no tool emitted — attributed to nothing
  ];

  it('callCount counts TOOL steps for the named tool only', () => {
    expect(toolCallCount(steps, 'github.get_me')).toBe(2);
    expect(toolCallCount(steps, 'github.search_code')).toBe(1);
    expect(toolCallCount(steps, 'github.list_issues')).toBe(0);
  });

  it('attributed spend = est of EMITTING model steps (provisional rule)', () => {
    expect(attributedEstUsd(steps, 'github.get_me')).toBeCloseTo(0.03);
    expect(attributedEstUsd(steps, 'github.search_code')).toBeCloseTo(0.02);
    expect(attributedEstUsd(steps, 'github.list_issues')).toBe(0);
  });

  it('GRANT-scoped attribution sums each emitting step ONCE across the connector (review fix)', () => {
    // step 3 emitted BOTH get_me and search_code; its $0.02 counts once for
    // the connector, not twice. Connector total = $0.01 + $0.02 = $0.03.
    expect(attributedEstUsdForConnector(steps, 'github')).toBeCloseTo(0.03);
    expect(attributedEstUsdForConnector(steps, 'linear')).toBe(0);
  });

  it('resultBytes sums recorded (post-truncation) outputs per tool', () => {
    expect(toolResultBytes(steps, 'github.search_code')).toBe(JSON.stringify('x'.repeat(100)).length);
  });
});

describe('checkToolCaps — every crossing is a typed refusal', () => {
  it('calls cap', () => {
    const steps = Array.from({ length: 20 }, () => toolStep('t', 'ok'));
    expect(checkToolCaps(steps, 't', DEFAULT_TOOL_CAPS)?.capExceeded).toBe('calls');
    expect(checkToolCaps(steps.slice(0, 19), 't', DEFAULT_TOOL_CAPS)).toBeNull();
  });

  it('cumulative result-bytes cap', () => {
    const big = 'y'.repeat(64 * 1024);
    const steps = Array.from({ length: 4 }, () => toolStep('t', big));
    expect(checkToolCaps(steps, 't', DEFAULT_TOOL_CAPS)?.capExceeded).toBe('result-bytes');
  });

  it('attributed run-spend cap rides the caller-supplied GRANT-scoped figure', () => {
    const caps = { ...DEFAULT_TOOL_CAPS, maxAttributedEstUsd: 0.05 };
    // per-tool `steps` are irrelevant to the dollar cap now — the grant
    // figure is the 5th arg; $0.06 grant-scoped ≥ $0.05 → refused.
    const refusal = checkToolCaps([], 'github.get_me', caps, 0, 0.06);
    expect(refusal?.capExceeded).toBe('spend');
    expect(refusal?.detail).toContain('grant scope');
    expect(refusal?.detail).toContain('PROVISIONAL');
    expect(checkToolCaps([], 'github.get_me', caps, 0, 0.04)).toBeNull();
  });

  it('the dollar cap is ONE ceiling for the whole grant, not one-per-tool (the review fix)', () => {
    // Two tools of the same connector, each spent $0.03 → grant total $0.06.
    // With a $0.05 cap, the connector is over even though NEITHER tool alone
    // is — metering per-tool (the bug) would let both through.
    const caps = { ...DEFAULT_TOOL_CAPS, maxAttributedEstUsd: 0.05 };
    const twoTools: StepLike[] = [
      modelStep(['github.get_me'], 0.03),
      modelStep(['github.search_code'], 0.03),
    ];
    const grantUsd = attributedEstUsdForConnector(twoTools, 'github');
    expect(grantUsd).toBeCloseTo(0.06);
    expect(checkToolCaps(twoTools, 'github.get_me', caps, 0, grantUsd)?.capExceeded).toBe('spend');
    // the OLD per-tool figure ($0.03) would NOT have tripped — proving the fix
    expect(attributedEstUsd(twoTools, 'github.get_me')).toBeCloseTo(0.03);
  });

  it('daily grant-scope cap rides the caller-supplied rollup', () => {
    const caps = { ...DEFAULT_TOOL_CAPS, maxAttributedEstUsdPerDay: 1 };
    expect(checkToolCaps([], 't', caps, 1.2)?.capExceeded).toBe('spend-day');
    expect(checkToolCaps([], 't', caps, 0.5)).toBeNull();
  });
});

describe('truncateResult — typed marker, never silent', () => {
  it('small results pass through as plain strings', () => {
    expect(truncateResult('hello', 1024)).toBe('hello');
  });

  it('oversized results carry {truncated: true, bytes, originalBytes}', () => {
    const out = truncateResult('z'.repeat(200_000), 64 * 1024);
    expect(out).toMatchObject({ truncated: true, originalBytes: 200_000 });
    expect((out as { bytes: number }).bytes).toBeLessThanOrEqual(64 * 1024);
  });

  it('never splits a multi-byte character', () => {
    const out = truncateResult('é'.repeat(40_000), 64 * 1024) as { text: string };
    expect(out.text).not.toContain('�');
  });
});
