// Scorer unit tests (SPEC §5): exact / field-match / llm-judge (code-exec has
// its own file). llm-judge runs against the deterministic mock judge.
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import type { EvalItem, PriceTable, ProviderId } from '@potion/core';
import { PROTOCOL_MAX_TOKENS } from '@potion/core';
import {
  corruptAnswer,
  createMockProvider,
  evalTaskById,
  hashString,
  loadPrices,
  mulberry32,
  type Provider,
} from '@potion/providers';
import {
  buildJudgeScoreMessages,
  finalAnswer,
  finalNumber,
  normalizeText,
  parseJsonAnswer,
  scoreAnswer,
  scoreExact,
  scoreFieldMatch,
  scoreLlmJudge,
  type ScorerDeps,
} from './scorers.js';

const PRICES_PATH = fileURLToPath(new URL('../../../prices.json', import.meta.url));

function scorerDeps(): ScorerDeps {
  const prices: PriceTable = loadPrices(PRICES_PATH).table;
  const mock = createMockProvider(prices);
  const providers: Record<ProviderId, Provider> = {
    anthropic: mock,
    openai: mock,
    google: mock,
    openrouter: mock,
    mock,
  };
  return { providers, prices };
}

describe('exact scorer', () => {
  const scoring = { kind: 'exact' as const };
  it('normalizes case and whitespace', () => {
    expect(scoreExact('  Hello   World \n', 'hello world', scoring)).toBe(1);
    expect(scoreExact('hello world', 'hello there', scoring)).toBe(0);
  });
  it('supports the field option against object references', () => {
    const s = { kind: 'exact' as const, field: 'name' };
    expect(scoreExact('Ada', { name: 'ada' }, s)).toBe(1);
    expect(scoreExact('Grace', { name: 'ada' }, s)).toBe(0);
  });
  it('normalizeText collapses all whitespace runs', () => {
    expect(normalizeText(' a\t b\n\n c ')).toBe('a b c');
  });
});

// A reasoning suite scored on the WHOLE answer measures format obedience, not
// arithmetic: a model that shows its work scores 0 against the bare gold
// number while a model that prints "36" scores 1, on identical maths. The
// extract option scores the answer the workload is actually judged on.
describe('exact scorer, extract: final-number', () => {
  const scoring = { kind: 'exact' as const, extract: 'final-number' as const };
  it('credits a correct number reached with visible reasoning', () => {
    expect(scoreExact('Step 1: 40% of 60 = 24.\nSo 60 - 24 = 36', '36', scoring)).toBe(1);
    expect(scoreExact('36', '36', scoring)).toBe(1);
  });
  it('prefers a labelled final answer over a later stray number', () => {
    expect(scoreExact('...costs $3.00 each.\nFinal answer: 12', '12', scoring)).toBe(1);
    expect(scoreExact('Final answer: 12\n\n(checked against 99 cases)', '12', scoring)).toBe(1);
  });
  it('reads through thousands separators, currency and bold markers', () => {
    expect(scoreExact('The total is $1,234', '1234', scoring)).toBe(1);
    expect(scoreExact('**Final answer: 1,234**', '1234', scoring)).toBe(1);
  });
  it('scores 0 for a wrong number, and for no number at all', () => {
    expect(scoreExact('Step 1: ...\nSo the answer is 35', '36', scoring)).toBe(0);
    expect(scoreExact('I cannot solve this.', '36', scoring)).toBe(0);
  });
  it('leaves default exact scoring untouched', () => {
    expect(scoreExact('the answer is 36', '36', { kind: 'exact' })).toBe(0);
  });
});

// The same conflation for golds that are not numbers: a weekday, yes/no, a
// letter, a time, a fraction. 'final-answer' reads the labelled last line and
// falls back to whole-text compare when the model never labels one, so it can
// only ever turn a format-obedience 0 into a correctness 1.
describe('exact scorer, extract: final-answer', () => {
  const scoring = { kind: 'exact' as const, extract: 'final-answer' as const };
  it('credits a correct non-numeric answer reached with visible reasoning', () => {
    expect(scoreExact('Mon+10 days lands on a Saturday.\nFinal answer: Saturday', 'saturday', scoring)).toBe(1);
    expect(scoreExact('Working through it...\nFinal answer: 10:15 PM', '10:15 pm', scoring)).toBe(1);
    expect(scoreExact('3 red, 4 blue of 7.\nFinal answer: 3/7', '3/7', scoring)).toBe(1);
  });
  it('reads through markdown emphasis and a trailing period', () => {
    expect(scoreExact('**Final answer:** yes.', 'yes', scoring)).toBe(1);
    expect(scoreExact('`Final answer: B`', 'b', scoring)).toBe(1);
  });
  it('takes the LAST label when the model restates it', () => {
    expect(scoreExact('Final answer: Monday\nWait, recheck.\nFinal answer: Sunday', 'sunday', scoring)).toBe(1);
  });
  it('scores 0 for a wrong labelled answer', () => {
    expect(scoreExact('Final answer: Monday', 'sunday', scoring)).toBe(0);
  });
  it('falls back to whole-text compare when no label is present', () => {
    expect(scoreExact('sunday', 'sunday', scoring)).toBe(1);
    expect(scoreExact('It is Sunday, I think.', 'sunday', scoring)).toBe(0);
  });
  it('leaves default exact scoring untouched', () => {
    expect(scoreExact('Final answer: Saturday', 'saturday', { kind: 'exact' })).toBe(0);
  });
  it('finalAnswer returns null when there is no label, or the label is empty', () => {
    expect(finalAnswer('It is Sunday, I think.')).toBeNull();
    expect(finalAnswer('Final answer:')).toBeNull();
    expect(finalAnswer('Final answer: Sunday')).toBe('Sunday');
  });
});

describe('field-match scorer', () => {
  const scoring = {
    kind: 'field-match' as const,
    schema: { vendor: 'string' as const, total: 'number' as const, paid: 'boolean' as const, tags: 'array' as const },
  };
  const reference = { vendor: 'Acme Corp', total: 1250.75, paid: true, tags: ['a', 'b'] };

  it('scores matched/total fields', () => {
    expect(scoreFieldMatch(JSON.stringify(reference), reference, scoring)).toBe(1);
    const oneWrong = JSON.stringify({ ...reference, paid: false });
    expect(scoreFieldMatch(oneWrong, reference, scoring)).toBe(0.75);
    const oneMissing = JSON.stringify({ vendor: 'Acme Corp', total: 1250.75, paid: true });
    expect(scoreFieldMatch(oneMissing, reference, scoring)).toBe(0.75);
  });
  it('strips markdown fences tolerantly', () => {
    const fenced = '```json\n' + JSON.stringify(reference) + '\n```';
    expect(parseJsonAnswer(fenced)).toEqual(reference);
    expect(scoreFieldMatch(fenced, reference, scoring)).toBe(1);
  });
  it('coerces types per schema (numeric strings, boolean strings)', () => {
    const coerced = JSON.stringify({ vendor: 'Acme Corp', total: '$1,250.75', paid: 'true', tags: ['a', 'b'] });
    expect(scoreFieldMatch(coerced, reference, scoring)).toBe(1);
  });
  it('returns 0 for unparseable or non-object answers', () => {
    expect(scoreFieldMatch('not json at all', reference, scoring)).toBe(0);
    expect(scoreFieldMatch('[1,2,3]', reference, scoring)).toBe(0);
    expect(scoreFieldMatch('42', reference, scoring)).toBe(0);
  });
});

describe('llm-judge scorer (mock judge)', () => {
  const prose = evalTaskById('pr-01')!;
  const item: EvalItem = {
    id: prose.id,
    clusterId: 'creative',
    prompt: [{ role: 'user', content: `EVAL: ${prose.id}\n${prose.task}` }],
    reference: prose.reference,
    scoring: {
      kind: 'llm-judge',
      rubric: 'Score the answer for correctness against the task.',
      judgeModel: 'mock-judge',
      scale: [0, 4],
    },
  };

  it('scores the clean reference answer high and the corrupted answer low', async () => {
    const deps = scorerDeps();
    const clean = await scoreAnswer(item, prose.reference, deps);
    const corrupted = corruptAnswer(prose, mulberry32(42)); // off-topic sentence prepended
    const dirty = await scoreAnswer(item, corrupted, deps);
    expect(clean.scorer).toBe('llm-judge:mock-judge');
    expect(clean.quality).toBeGreaterThan(0.85); // base 1.0 ± 0.08 noise
    expect(dirty.quality).toBeLessThan(0.55); // base 0.35 ± 0.08 noise
    expect(clean.quality).toBeGreaterThan(dirty.quality);
  });

  it('is deterministic per (judgeModel, item, answer)', async () => {
    const deps = scorerDeps();
    const a = await scoreAnswer(item, prose.reference, deps);
    const b = await scoreAnswer(item, prose.reference, deps);
    expect(a.quality).toBe(b.quality);
  });
});

describe('reference-anchored judge prompt (G1.4)', () => {
  const scoring = {
    kind: 'llm-judge' as const,
    rubric: 'r',
    judgeModel: 'mock-judge',
    scale: [0, 1] as [number, number],
  };
  const baseItem: EvalItem = {
    id: 'ref-01',
    clusterId: 'agent-x',
    prompt: [{ role: 'user', content: 'do the thing' }],
    scoring,
  };

  it('REFERENCE block sits BETWEEN TASK and ANSWER, wrapped; absent without a reference', () => {
    const withRef = buildJudgeScoreMessages({ ...baseItem, reference: 'the original answer' }, 'candidate', scoring)[0]!.content;
    const refIdx = withRef.indexOf('REFERENCE:');
    expect(refIdx).toBeGreaterThan(withRef.indexOf('TASK:'));
    expect(refIdx).toBeLessThan(withRef.indexOf('ANSWER:'));
    expect(withRef).toContain('judge the ANSWER primarily by comparison');
    // the reference itself is untrusted-wrapped
    const refBlock = withRef.slice(refIdx, withRef.indexOf('ANSWER:'));
    expect(refBlock).toContain('<<<UNTRUSTED_DATA_BEGIN>>>');
    expect(refBlock).toContain('the original answer');
    // no reference → no block, header unchanged
    const withoutRef = buildJudgeScoreMessages(baseItem, 'candidate', scoring)[0]!.content;
    expect(withoutRef).not.toContain('REFERENCE:');
    expect(withoutRef).not.toContain('comparison against it');
  });

  it('non-string references are JSON-stringified; mock extractor still parses the ANSWER', async () => {
    const objRef = buildJudgeScoreMessages(
      { ...baseItem, reference: { field: 'value' } },
      'candidate',
      scoring,
    )[0]!.content;
    expect(objRef).toContain('{"field":"value"}');
    // mock judge extracts the answer correctly with a REFERENCE present
    // (the block sits BEFORE ANSWER — a trailing block would corrupt it)
    const deps = scorerDeps();
    const outcome = await scoreLlmJudge(
      { ...baseItem, reference: 'ref text' },
      'some candidate answer',
      scoring,
      deps,
    );
    expect(outcome.quality).toBeGreaterThanOrEqual(0);
    expect(outcome.quality).toBeLessThanOrEqual(1);
  });
});

describe('llm-judge scorerUsage (M1b: judge spend is counted)', () => {
  const prose = evalTaskById('pr-01')!;
  const scoring = {
    kind: 'llm-judge' as const,
    rubric: 'Score the answer for correctness against the task.',
    judgeModel: 'priced-judge',
    scale: [0, 4] as [number, number],
  };
  const item: EvalItem = {
    id: prose.id,
    clusterId: 'creative',
    prompt: [{ role: 'user', content: `EVAL: ${prose.id}\n${prose.task}` }],
    reference: prose.reference,
    scoring,
  };

  /** Deps with a PRICED judge entry ($3/$15 per 1M, mock transport). */
  function pricedJudgeDeps(): ScorerDeps {
    const base = loadPrices(PRICES_PATH).table;
    const prices: PriceTable = {
      ...base,
      entries: [
        ...base.entries,
        { alias: 'priced-judge', provider: 'mock', model: 'priced-judge-v1', inputPer1M: 3.0, outputPer1M: 15.0 },
      ],
    };
    const mock = createMockProvider(prices);
    return { providers: { anthropic: mock, openai: mock, google: mock, openrouter: mock, mock }, prices };
  }

  it('captures judge-call tokens + hand-computed cost + latency', async () => {
    const deps = pricedJudgeDeps();
    const outcome = await scoreAnswer(item, prose.reference, deps);
    expect(outcome.scorer).toBe('llm-judge:priced-judge');
    const u = outcome.scorerUsage;
    expect(u).toBeDefined();
    // Hand-computed tokens (mock contract, mock.ts: input = ceil(chars/4) of
    // `role:content` prompt text; the scorer's request is fully determined):
    const judgePromptText = `user:${buildJudgeScoreMessages(item, prose.reference, scoring)[0]!.content}`;
    expect(u!.inputTokens).toBe(Math.ceil(judgePromptText.length / 4));
    // Hand-computed cost: input×$3/1M + output×$15/1M. Output tokens come from
    // the deterministic judge fixture; assert via an identical reference call
    // (same seed formula as the scorer: hash(judgeModel|itemId|answer)).
    const seed = hashString(`priced-judge|${item.id}|${prose.reference}`);
    const ref = await deps.providers.mock.complete({
      model: 'priced-judge',
      messages: buildJudgeScoreMessages(item, prose.reference, scoring),
      params: { seed },
    });
    expect(u!.outputTokens).toBe(ref.usage.outputTokens);
    expect(u!.costUsd).toBeCloseTo((u!.inputTokens * 3 + u!.outputTokens * 15) / 1e6, 12);
    // 'priced-judge' → mid latency profile (900ms); latency IS captured here.
    expect(u!.latencyMs).toBe(900);
  });

  it('sends maxTokens: PROTOCOL_MAX_TOKENS on the judge call (estimator bound)', async () => {
    const deps = pricedJudgeDeps();
    const seen: Array<number | undefined> = [];
    const wrapped: Provider = {
      ...deps.providers.mock,
      complete: (req) => {
        seen.push(req.params?.maxTokens);
        return deps.providers.mock.complete(req);
      },
    };
    await scoreAnswer(item, prose.reference, {
      ...deps,
      providers: { anthropic: wrapped, openai: wrapped, google: wrapped, openrouter: wrapped, mock: wrapped },
    });
    expect(seen).toEqual([PROTOCOL_MAX_TOKENS]);
  });

  it('is undefined for deterministic scorers (exact / field-match / code-exec)', async () => {
    const exact = await scoreAnswer({ ...item, scoring: { kind: 'exact' } }, 'whatever');
    expect(exact.scorerUsage).toBeUndefined();
    const fm = await scoreAnswer(
      { ...item, scoring: { kind: 'field-match', schema: { a: 'string' } } },
      JSON.stringify({ a: 'b' }),
    );
    expect(fm.scorerUsage).toBeUndefined();
    const ce = await scoreAnswer(
      { ...item, scoring: { kind: 'code-exec', language: 'javascript', tests: '' } },
      'var x = 1;',
    );
    expect(ce.scorerUsage).toBeUndefined();
  });
});
