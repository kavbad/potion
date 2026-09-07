// C4 rung 2: prompt variants as a compiler parameter.
import { describe, expect, it } from 'vitest';
import {
  applyPromptVariant,
  promptVariantFitsScoring,
  toleratesDeliberation,
  PROMPT_VARIANT,
  PROMPT_VARIANT_TEXT,
  PROMPT_VARIANT_TOKENS,
} from './prompt-variant.js';
import { StrategyConfigSchema } from './schemas.js';
import { programCallCount, programModels } from './coverage.js';
import { strategyHash } from './hash.js';
import type { ChatMessage, ProgramNode, StrategyConfig } from './types.js';

const MESSAGES: ChatMessage[] = [
  { role: 'system', content: 'You are helpful.' },
  { role: 'user', content: 'Extract the order id.' },
];

describe('applying a variant', () => {
  it('ADDS an instruction and never rewrites the caller turns', () => {
    const out = applyPromptVariant(MESSAGES, 'terse');
    expect(out.slice(0, 2)).toEqual(MESSAGES); // byte-identical, in order
    expect(out).toHaveLength(3);
    expect(out[2]).toEqual({ role: 'system', content: PROMPT_VARIANT_TEXT.terse });
  });

  it('absent means untouched — the same array, not a copy with nothing added', () => {
    expect(applyPromptVariant(MESSAGES, undefined)).toBe(MESSAGES);
  });

  it('every variant has text and a positive input cost', () => {
    for (const v of PROMPT_VARIANT) {
      expect(PROMPT_VARIANT_TEXT[v].length).toBeGreaterThan(0);
      expect(PROMPT_VARIANT_TOKENS[v]).toBeGreaterThan(0);
    }
  });
});

describe('a variant is part of the node, so the memo sees two operating points', () => {
  const body: ProgramNode = {
    op: 'if',
    check: { kind: 'json', of: { op: 'call', model: 'm', promptVariant: 'json-only' } },
    then: { op: 'call', model: 'm', promptVariant: 'json-only' },
    else: { op: 'call', model: 'm' },
  };

  it('one model asked two ways is two calls', () => {
    expect(programModels(body)).toEqual(['m']);
    expect(programCallCount(body)).toBe(2);
  });

  it('the schema carries a name and refuses free text', () => {
    const cfg: StrategyConfig = { type: 'program', name: 'v', body };
    expect(StrategyConfigSchema.parse(JSON.parse(JSON.stringify(cfg)))).toBeTruthy();
    expect(() =>
      StrategyConfigSchema.parse({
        type: 'program', name: 'v',
        body: { op: 'call', model: 'm', promptVariant: 'You are a helpful assistant. Think hard.' },
      }),
    ).toThrow();
    // …and the variant is part of the identity, not decoration.
    expect(strategyHash({ type: 'program', name: 'v', body })).not.toBe(
      strategyHash({ type: 'program', name: 'v', body: { ...body, else: { op: 'call', model: 'm', promptVariant: 'terse' } } }),
    );
  });
});

// THE COUPLING. This is the part that is not obvious: an instruction that
// changes the SHAPE of an answer breaks the instrument that grades it and the
// gate that reads it. The compiler cannot treat its axes as independent.
describe('instructions and instruments have to agree about what an answer looks like', () => {
  it('step-by-step is refused wherever the answer must be canonical or structured', () => {
    expect(promptVariantFitsScoring('step-by-step', ['exact'])).toBe(false);
    expect(promptVariantFitsScoring('step-by-step', ['field-match'])).toBe(false);
    expect(promptVariantFitsScoring('step-by-step', ['field-contains'])).toBe(false);
    // Prose before the answer is only safe where prose is what is graded.
    expect(promptVariantFitsScoring('step-by-step', ['llm-judge'])).toBe(true);
  });

  it('json-only goes only where the answer is supposed to be an object', () => {
    expect(promptVariantFitsScoring('json-only', ['field-match'])).toBe(true);
    expect(promptVariantFitsScoring('json-only', ['field-contains'])).toBe(true);
    expect(promptVariantFitsScoring('json-only', ['exact'])).toBe(false);
    expect(promptVariantFitsScoring('json-only', ['llm-judge'])).toBe(false);
  });

  it('terse fits anywhere — shorter is never the wrong SHAPE', () => {
    for (const kinds of [['exact'], ['field-match'], ['llm-judge'], ['code-exec']]) {
      expect(promptVariantFitsScoring('terse', kinds)).toBe(true);
    }
  });
});

// ---- Measured 2026-09-05: effort is deliberation too ----
//
// The first live run put `effort-escalation` LAST of eleven strategies on the
// extraction suite: 0.862, against 0.962 for the same model answering plainly.
// Asking a flash model to think harder made structured extraction worse — the
// same failure `step-by-step` has, for the same reason. Deliberation before an
// answer breaks an instrument that reads the answer's SHAPE, and it does not
// matter whether the deliberation was asked for in English or bought with a
// thinking budget.
describe('deliberation and the instruments that cannot take it', () => {
  it('names the property once, for every axis that causes it', () => {
    expect(toleratesDeliberation(['llm-judge'])).toBe(true);
    expect(toleratesDeliberation(['code-exec'])).toBe(true);
    expect(toleratesDeliberation(['exact'])).toBe(false);
    expect(toleratesDeliberation(['field-match'])).toBe(false);
    expect(toleratesDeliberation(['field-contains'])).toBe(false);
    // one shape-reading item in the cluster is enough to rule it out
    expect(toleratesDeliberation(['llm-judge', 'field-match'])).toBe(false);
  });

  it('step-by-step is exactly this property, not a second list', () => {
    for (const kinds of [['llm-judge'], ['code-exec'], ['exact'], ['field-match'], ['field-contains'], []]) {
      expect(promptVariantFitsScoring('step-by-step', kinds)).toBe(toleratesDeliberation(kinds));
    }
  });
});
