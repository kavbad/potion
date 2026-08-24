// exec-pick fusion (R4, 2026-08-24): execution decides, judge only on ties,
// confidence when no judge, honest degrade when the tests are unusable.
import { describe, expect, it } from 'vitest';
import type { ChatMessage, StrategyConfig } from '@potion/core';
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

/** Scripted context: each model name maps to a fixed answer. */
function scriptedCtx(byModel: Record<string, string>, extra?: Partial<ExecContext>): ExecContext {
  return {
    providers: {} as never,
    prices: { version: 't', updatedAt: 't', entries: [] } as never,
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
  } as never;
}

function ensemble(models: string[], fusion: Record<string, unknown>): StrategyConfig {
  return { type: 'ensemble', models, fusion } as never;
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
