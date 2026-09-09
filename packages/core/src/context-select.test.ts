// C4 rung 3: context selection. The half of "retrieval" Potion can own — the
// context is already in the request; the question is how much of it to send.
import { describe, expect, it } from 'vitest';
import { selectContext, SELECT_MIN_PROMPT_CHARS } from './context-select.js';
import { StrategyConfigSchema } from './schemas.js';
import { programCallCount } from './coverage.js';
import type { ChatMessage, StrategyConfig } from './types.js';

const BLOB = [
  'The warranty covers manufacturing defects for 24 months.',
  'Our head office is in Leeds and opens at nine.',
  'Refunds are issued to the original payment method within 14 days.',
  'The staff canteen serves lunch between twelve and two.',
].join('\n\n');

const MESSAGES: ChatMessage[] = [
  { role: 'system', content: 'Answer only from the context.' },
  { role: 'user', content: BLOB },
  { role: 'user', content: 'How long is the refund window?' },
];

describe('selecting the context a request already carries', () => {
  it('keeps the paragraphs that overlap the question, in document order', () => {
    const out = selectContext(MESSAGES, { keepParagraphs: 2 });
    const kept = out[1]!.content.split('\n\n');
    expect(kept).toHaveLength(2);
    expect(kept.some((p) => p.includes('Refunds are issued'))).toBe(true);
    expect(kept.some((p) => p.includes('canteen'))).toBe(false);
    // order preserved: the context must still read as a document
    expect(out[1]!.content.indexOf(kept[0]!)).toBeLessThan(out[1]!.content.indexOf(kept[1]!));
  });

  it('never touches the question or any other message', () => {
    const out = selectContext(MESSAGES, { keepParagraphs: 1 });
    expect(out[0]).toEqual(MESSAGES[0]);
    expect(out[2]).toEqual(MESSAGES[2]);
  });

  it('no-ops rather than mangling: no selection, or fewer paragraphs than asked', () => {
    expect(selectContext(MESSAGES, undefined)).toBe(MESSAGES);
    expect(selectContext(MESSAGES, { keepParagraphs: 9 })).toBe(MESSAGES);
    expect(selectContext(MESSAGES, { keepParagraphs: 0 })).toBe(MESSAGES);
  });

  it('no-ops when there is no question to rank against — a blob alone is not a query', () => {
    const blobOnly: ChatMessage[] = [{ role: 'user', content: BLOB }];
    expect(selectContext(blobOnly, { keepParagraphs: 1 })).toBe(blobOnly);
  });

  it('scores by density, so a long irrelevant paragraph cannot win on word count alone', () => {
    const padded = [
      'Refunds are issued within 14 days.',
      `The canteen ${'serves lunch daily '.repeat(40)}refund refund`,
    ].join('\n\n');
    const out = selectContext(
      [{ role: 'user', content: padded }, { role: 'user', content: 'refund window?' }],
      { keepParagraphs: 1 },
    );
    expect(out[0]!.content).toContain('Refunds are issued');
    expect(out[0]!.content).not.toContain('canteen');
  });

  it('it is a real reduction — that is the point', () => {
    const before = MESSAGES.reduce((n, m) => n + m.content.length, 0);
    const after = selectContext(MESSAGES, { keepParagraphs: 1 }).reduce((n, m) => n + m.content.length, 0);
    expect(after).toBeLessThan(before);
    expect(SELECT_MIN_PROMPT_CHARS).toBeGreaterThan(0);
  });

  it('the schema bounds it — keeping everything is not a selection', () => {
    const ok: StrategyConfig = {
      type: 'program', name: 's',
      body: { op: 'call', model: 'm', contextSelect: { keepParagraphs: 3 } },
    };
    expect(StrategyConfigSchema.parse(JSON.parse(JSON.stringify(ok)))).toBeTruthy();
    const bad = (k: unknown) => ({ type: 'program', name: 's', body: { op: 'call', model: 'm', contextSelect: { keepParagraphs: k } } });
    expect(() => StrategyConfigSchema.parse(bad(0))).toThrow();
    expect(() => StrategyConfigSchema.parse(bad(500))).toThrow();
    expect(() => StrategyConfigSchema.parse(bad(2.5))).toThrow();
  });

  it('two selections of one model are two calls — selection is part of identity', () => {
    expect(
      programCallCount({
        op: 'if',
        check: { kind: 'confidence', of: { op: 'call', model: 'm', contextSelect: { keepParagraphs: 2 } }, min: 0.8 },
        then: { op: 'call', model: 'm', contextSelect: { keepParagraphs: 2 } },
        else: { op: 'call', model: 'm' },
      }),
    ).toBe(2);
  });
});
