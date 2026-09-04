// verify-pick fusion (2026-08-25): extraction's exec-pick. The field-writer
// derives the required fields from the request; the check is deterministic
// coverage of those fields — the omission class reference-free judges were
// measured blind to (G8), caught without a reference.
import { describe, expect, it } from 'vitest';
import type { ChatMessage, FusionConfig, PriceTable, StrategyConfig } from '@potion/core';
import { createProviders } from '@potion/providers';
import { execute, type ExecContext } from './index.js';
import { fieldCoverage, parseFieldList } from './ensemble.js';

const MESSAGES: ChatMessage[] = [
  { role: 'user', content: 'Extract the order_number, issue, and urgency from: "Order 4471 arrived broken, need it replaced before Friday." Respond with JSON.' },
];

const FULL = '{"order_number":"4471","issue":"arrived broken","urgency":"before Friday"}';
const MISSING = '{"order_number":"4471","issue":"arrived broken"}';
const BROKEN = 'order number is 4471, issue: broken';
const FIELDS = '["order_number","issue","urgency"]';

/** Every call below is routed by the scripted `resolve`, so the table is
 *  legitimately empty and the provider map is never consulted. */
const PRICES: PriceTable = { version: 't', updatedAt: '2026-01-01T00:00:00Z', entries: [] };

function scriptedCtx(byModel: Record<string, string>): ExecContext {
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
  };
}

function ensemble(models: string[], fusion: FusionConfig): StrategyConfig {
  return { type: 'ensemble', models, fusion };
}

describe('field helpers', () => {
  it('parseFieldList reads a fenced or bare JSON array, rejects junk', () => {
    expect(parseFieldList(FIELDS)).toEqual(['order_number', 'issue', 'urgency']);
    expect(parseFieldList('```json\n' + FIELDS + '\n```')).toEqual(['order_number', 'issue', 'urgency']);
    expect(parseFieldList('the fields are order_number')).toBeNull();
    expect(parseFieldList('[]')).toBeNull();
  });
  it('fieldCoverage: full 1.0, missing one 2/3, unparseable -1, name normalization', () => {
    expect(fieldCoverage(FULL, ['order_number', 'issue', 'urgency'])).toBe(1);
    expect(fieldCoverage(MISSING, ['order_number', 'issue', 'urgency'])).toBeCloseTo(2 / 3);
    expect(fieldCoverage(BROKEN, ['order_number'])).toBe(-1);
    expect(fieldCoverage('{"Order Number":"4471"}', ['order_number'])).toBe(1);
  });
});

describe("ensemble fusion: 'verify-pick'", () => {
  it('the complete candidate beats the one missing a field — no judge needed', async () => {
    const ctx = scriptedCtx({ 'miss-m': MISSING, 'full-m': FULL, writer: FIELDS });
    const r = await execute(
      ensemble(['miss-m', 'full-m'], { method: 'verify-pick', testWriter: { model: 'writer' }, judge: { model: 'judge' } }),
      MESSAGES,
      ctx,
    );
    expect(r.text).toBe(FULL);
    const fusion = r.trace.find((t) => t.stage === 'fusion-verify')!;
    expect(fusion.decision).toContain('verify-pick:1');
    expect(fusion.decision).not.toContain('tie-judge');
    expect(r.trace.some((t) => t.stage === 'field-writer')).toBe(true);
  });

  it('unparseable JSON loses to parseable-but-incomplete', async () => {
    const ctx = scriptedCtx({ 'broken-m': BROKEN, 'miss-m': MISSING, writer: FIELDS });
    const r = await execute(
      ensemble(['broken-m', 'miss-m'], { method: 'verify-pick', testWriter: { model: 'writer' } }),
      MESSAGES,
      ctx,
    );
    expect(r.text).toBe(MISSING);
  });

  it('majority: a junk field list is half the vote, the usable one decides', async () => {
    const ctx = scriptedCtx({ 'miss-m': MISSING, 'full-m': FULL, w1: 'not a list at all', w2: FIELDS });
    const r = await execute(
      ensemble(['miss-m', 'full-m'], { method: 'verify-pick', testWriters: [{ model: 'w1' }, { model: 'w2' }] }),
      MESSAGES,
      ctx,
    );
    expect(r.text).toBe(FULL);
    expect(r.trace.some((t) => t.stage === 'field-writer-0')).toBe(true);
  });

  it('a tie (both complete) falls to the judge', async () => {
    const ALT = '{"order_number":"4471","issue":"broken on arrival","urgency":"high"}';
    const ctx = scriptedCtx({ a: FULL, b: ALT, writer: FIELDS, judge: 'PICK: 1' });
    const r = await execute(
      ensemble(['a', 'b'], { method: 'verify-pick', testWriter: { model: 'writer' }, judge: { model: 'judge' } }),
      MESSAGES,
      ctx,
    );
    expect(r.text).toBe(ALT);
    expect(r.trace.find((t) => t.stage === 'fusion-verify')!.decision).toContain('tie-judge');
  });
});
