// exec-pick fusion (R4, 2026-08-24): execution decides, judge only on ties,
// confidence when no judge, honest degrade when the tests are unusable.
import { describe, expect, it } from 'vitest';
import type { ChatMessage, FusionConfig, PriceTable, StrategyConfig } from '@potion/core';
import { createProviders } from '@potion/providers';
import { execute, type ExecContext } from './index.js';
import { buildTestWriterMessages } from './ensemble.js';

const MESSAGES: ChatMessage[] = [
  { role: 'user', content: 'Write add(a, b) returning the sum. Return only code.' },
];

const GOOD = 'function add(a, b) { return a + b; }';
const BAD = 'function add(a, b) { return a - b; }';
const TESTS =
  "test('adds', () => assertDeepEqual(add(2, 3), 5));\n" +
  "test('adds negatives', () => assertDeepEqual(add(-1, -2), -3));";

/** Every call below is routed by the scripted `resolve`, so the table is
 *  legitimately empty and the provider map is never consulted. */
const PRICES: PriceTable = { version: 't', updatedAt: '2026-01-01T00:00:00Z', entries: [] };

/** Scripted context: each model name maps to a fixed answer. */
function scriptedCtx(byModel: Record<string, string>, extra?: Partial<ExecContext>): ExecContext {
  return {
    providers: createProviders({ prices: PRICES }),
    prices: PRICES,
    resolve: (model: string) => ({
      provider: {
        id: 'mock',
        complete: (req: { model: string }) =>
          Promise.resolve({
            text: byModel[req.model] ?? `no script for ${req.model}`,
            usage: { inputTokens: 10, outputTokens: 20 },
            latencyMs: 5,
            modelVersion: `${req.model}-v1`,
          }),
      },
      entry: { alias: model, provider: 'mock', model, inputPer1M: 0, outputPer1M: 0 },
    }),
    ...extra,
  };
}

function ensemble(models: string[], fusion: FusionConfig): StrategyConfig {
  return { type: 'ensemble', models, fusion };
}

describe("ensemble fusion: 'exec-pick'", () => {
  it('execution decides: the passing candidate wins regardless of order', async () => {
    const ctx = scriptedCtx({ 'bad-m': BAD, 'good-m': GOOD, writer: TESTS });
    const r = await execute(
      ensemble(['bad-m', 'good-m'], { method: 'exec-pick', testWriter: { model: 'writer' }, judge: { model: 'judge' } }),
      MESSAGES,
      ctx,
    );
    expect(r.text).toBe(GOOD);
    const fusion = r.trace.find((t) => t.stage === 'fusion-exec')!;
    expect(fusion.decision).toContain('exec-pick:1');
    expect(fusion.decision).toContain('0/2'); // bad candidate's verdict
    expect(fusion.decision).toContain('2/2'); // good candidate's verdict
    // the test-writer rode the parallel fan-out and is on the trace
    expect(r.trace.some((t) => t.stage === 'test-writer')).toBe(true);
  });

  it('fence-wrapped candidates and tests still execute', async () => {
    const ctx = scriptedCtx({
      'bad-m': '```javascript\n' + BAD + '\n```',
      'good-m': '```js\n' + GOOD + '\n```',
      writer: '```javascript\n' + TESTS + '\n```',
    });
    const r = await execute(
      ensemble(['bad-m', 'good-m'], { method: 'exec-pick', testWriter: { model: 'writer' } }),
      MESSAGES,
      ctx,
    );
    expect(r.text).toContain('return a + b');
  });

  it('a tie goes to the judge, over the tied candidates only', async () => {
    const ctx = scriptedCtx({ 'good-a': GOOD, 'good-b': GOOD.replace('a + b', 'b + a'), writer: TESTS, judge: 'PICK: 1' });
    const r = await execute(
      ensemble(['good-a', 'good-b'], { method: 'exec-pick', testWriter: { model: 'writer' }, judge: { model: 'judge' } }),
      MESSAGES,
      ctx,
    );
    expect(r.text).toContain('b + a'); // judge picked the second of the tied pair
    expect(r.trace.some((t) => t.stage === 'tie-judge')).toBe(true);
  });

  it('unusable tests degrade honestly: every candidate -1, judge breaks the tie', async () => {
    const ctx = scriptedCtx({ 'bad-m': BAD, 'good-m': GOOD, writer: 'I refuse to write tests, here is prose.', judge: 'PICK: 0' });
    const r = await execute(
      ensemble(['bad-m', 'good-m'], { method: 'exec-pick', testWriter: { model: 'writer' }, judge: { model: 'judge' } }),
      MESSAGES,
      ctx,
    );
    expect(r.text).toBe(BAD); // judge said 0; execution could not attest
    const fusion = r.trace.find((t) => t.stage === 'fusion-exec')!;
    expect(fusion.decision).toContain('error(');
  });

  it('a tie with no judge falls back to confidence rank (first candidate here)', async () => {
    const ctx = scriptedCtx({ 'good-a': GOOD, 'good-b': GOOD.replace('a + b', 'b + a'), writer: TESTS });
    const r = await execute(
      ensemble(['good-a', 'good-b'], { method: 'exec-pick', testWriter: { model: 'writer' } }),
      MESSAGES,
      ctx,
    );
    expect(r.text).toBe(GOOD);
    expect(r.trace.find((t) => t.stage === 'fusion-exec')!.decision).toContain('tie-confidence');
  });

  it('exec-pick without a testWriter refuses loudly', async () => {
    const ctx = scriptedCtx({ a: GOOD, b: BAD });
    await expect(execute(ensemble(['a', 'b'], { method: 'exec-pick' }), MESSAGES, ctx)).rejects.toThrow(
      /requires fusion.testWriter/,
    );
  });

  it('the test-writer wire forbids an implementation and names the dialect', () => {
    const msgs = buildTestWriterMessages(MESSAGES);
    const last = msgs[msgs.length - 1]!.content;
    expect(last).toContain('Do NOT answer');
    expect(last).toContain('assertDeepEqual');
    expect(last).toContain('Do not define or include the implementation');
  });
});

// ---- majority-by-execution (selector stabilization, 2026-08-25) ----------
//
// One wrong test suite used to BE the verdict. With testWriters, the score
// is the mean pass rate across suites: a wrong suite is half the vote.
describe("ensemble fusion: 'exec-pick' with multiple test-writers", () => {
  const WRONG_TESTS =
    // A wrong belief about the spec: asserts subtraction. GOOD fails it, BAD passes.
    "test('adds', () => assertDeepEqual(add(2, 3), -1));\n" +
    "test('adds negatives', () => assertDeepEqual(add(-1, -2), 1));";
  const BROKEN_TESTS = 'this is not javascript at all {{{';

  it('a wrong suite is outvoted: good wins 2/2+0/2 over bad 0/2+2/2 on the tie-break judge? no — means tie, judge decides', async () => {
    // Symmetric disagreement IS a mean tie (good: (1 + 0)/2, bad: (0 + 1)/2)
    // → the judge breaks it, exactly the old tie path.
    const ctx = scriptedCtx({ 'bad-m': BAD, 'good-m': GOOD, w1: TESTS, w2: WRONG_TESTS, judge: 'PICK: 1' });
    const r = await execute(
      ensemble(['bad-m', 'good-m'], {
        method: 'exec-pick',
        testWriters: [{ model: 'w1' }, { model: 'w2' }],
        judge: { model: 'judge' },
      }),
      MESSAGES,
      ctx,
    );
    const fusion = r.trace.find((t) => t.stage === 'fusion-exec')!;
    expect(fusion.decision).toContain('tie-judge');
    expect(r.trace.some((t) => t.stage === 'test-writer-0')).toBe(true);
    expect(r.trace.some((t) => t.stage === 'test-writer-1')).toBe(true);
  });

  it('a BROKEN suite is outvoted, not decisive: the usable suite picks good', async () => {
    const ctx = scriptedCtx({ 'bad-m': BAD, 'good-m': GOOD, w1: BROKEN_TESTS, w2: TESTS, judge: 'PICK: 0' });
    const r = await execute(
      ensemble(['bad-m', 'good-m'], {
        method: 'exec-pick',
        testWriters: [{ model: 'w1' }, { model: 'w2' }],
        judge: { model: 'judge' },
      }),
      MESSAGES,
      ctx,
    );
    // bad: (-1 + 0)/2 = -0.5 · good: (-1 + 1)/2 = 0 → good wins WITHOUT the judge.
    expect(r.text).toBe(GOOD);
    const fusion = r.trace.find((t) => t.stage === 'fusion-exec')!;
    expect(fusion.decision).toContain('exec-pick:1');
    expect(fusion.decision).not.toContain('tie-judge');
  });

  it('a partially-wrong suite is outvoted by a correct one', async () => {
    // w2 gets one case right and one wrong: good scores (2/2 + 1/2)/2 = 0.75,
    // bad scores (0/2 + 1/2)/2 = 0.25 → good wins outright.
    const HALF_WRONG =
      "test('adds', () => assertDeepEqual(add(2, 3), 5));\n" +
      "test('adds negatives', () => assertDeepEqual(add(-1, -2), 1));";
    const ctx = scriptedCtx({ 'bad-m': BAD, 'good-m': GOOD, w1: TESTS, w2: HALF_WRONG, judge: 'PICK: 0' });
    const r = await execute(
      ensemble(['bad-m', 'good-m'], {
        method: 'exec-pick',
        testWriters: [{ model: 'w1' }, { model: 'w2' }],
        judge: { model: 'judge' },
      }),
      MESSAGES,
      ctx,
    );
    expect(r.text).toBe(GOOD);
    expect(r.trace.find((t) => t.stage === 'fusion-exec')!.decision).not.toContain('tie-judge');
  });

  it('single-writer shapes behave exactly as before (stage name, verdicts, seed path)', async () => {
    const ctx = scriptedCtx({ 'bad-m': BAD, 'good-m': GOOD, writer: TESTS });
    const r = await execute(
      ensemble(['bad-m', 'good-m'], { method: 'exec-pick', testWriter: { model: 'writer' } }),
      MESSAGES,
      ctx,
    );
    expect(r.text).toBe(GOOD);
    expect(r.trace.some((t) => t.stage === 'test-writer')).toBe(true);
    expect(r.trace.some((t) => t.stage === 'test-writer-0')).toBe(false);
  });

  it('all suites broken degrades honestly: every score -1, tie across all, judge decides', async () => {
    const ctx = scriptedCtx({ 'bad-m': BAD, 'good-m': GOOD, w1: BROKEN_TESTS, w2: BROKEN_TESTS, judge: 'PICK: 1' });
    const r = await execute(
      ensemble(['bad-m', 'good-m'], {
        method: 'exec-pick',
        testWriters: [{ model: 'w1' }, { model: 'w2' }],
        judge: { model: 'judge' },
      }),
      MESSAGES,
      ctx,
    );
    expect(r.trace.find((t) => t.stage === 'fusion-exec')!.decision).toContain('tie-judge');
    expect(r.text).toBe(GOOD); // judge PICKed 1 among tied [0,1]
  });
});
