import { describe, expect, it } from 'vitest';
import type { PriceTable } from '@potion/core';
import { incumbentRoster, resolveTypedModel } from '../src/incumbents/roster.js';

const PRICES: PriceTable = {
  version: 't',
  updatedAt: '2026-08-28T00:00:00Z',
  entries: [
    { alias: 'or-sonnet', provider: 'openrouter', model: 'anthropic/claude-sonnet-4', inputPer1M: 3, outputPer1M: 15 },
    { alias: 'or-sonnet-tranche-2026-08', provider: 'openrouter', model: 'anthropic/claude-sonnet-4', inputPer1M: 3, outputPer1M: 15 },
    { alias: 'or-gpt41', provider: 'openrouter', model: 'openai/gpt-4.1', inputPer1M: 2, outputPer1M: 8 },
    { alias: 'mock-cheap', provider: 'mock', model: 'mock/cheap', inputPer1M: 0, outputPer1M: 0 },
    { alias: 'cheap-class', provider: 'openrouter', model: 'x/y', inputPer1M: 0, outputPer1M: 0 },
  ],
};

describe('incumbent roster', () => {
  it('names models a person recognises and excludes what must not be offered', () => {
    const prices: PriceTable = {
      version: 't',
      updatedAt: '2026-08-28T00:00:00Z',
      entries: [
        { alias: 'or-gpt-full', provider: 'openrouter', model: 'openai/gpt-4.1', inputPer1M: 2, outputPer1M: 8 },
        { alias: 'or-sonnet', provider: 'openrouter', model: 'anthropic/claude-sonnet-4.5', inputPer1M: 3, outputPer1M: 15 },
        { alias: 'or-solar-pro4', provider: 'openrouter', model: 'upstage/solar-pro-4', inputPer1M: 0.1, outputPer1M: 0.1 },
        { alias: 'gpt-mini-class', provider: 'openrouter', model: 'openai/gpt-4.1-mini', inputPer1M: 0.4, outputPer1M: 1.6 },
        { alias: 'mock-cheap', provider: 'mock', model: 'mock', inputPer1M: 0, outputPer1M: 0 },
      ],
    };
    const r = incumbentRoster(prices);
    expect(r.map((x) => x.alias)).toEqual(['or-sonnet', 'or-gpt-full']);
    expect(r[1]).toMatchObject({ name: 'GPT 4.1', vendor: 'OpenAI', native: 'openai/gpt-4.1' });
    expect(r[0]?.name).toBe('Claude Sonnet 4.5');
    expect(JSON.stringify(r)).not.toMatch(/solar|upstage|mock|-class/);
  });
});

describe('incumbentRoster', () => {
  it('lists each native model once, canonical alias first, alternates kept', () => {
    const r = incumbentRoster(PRICES);
    expect(r.map((e) => e.alias)).toEqual(['or-sonnet', 'or-gpt41']);
    expect(r[0]!.alternates).toEqual(['or-sonnet-tranche-2026-08']);
  });
});

describe('resolveTypedModel', () => {
  const roster = incumbentRoster(PRICES);
  it('matches an alias, an alternate, a native id, or a display name', () => {
    expect(resolveTypedModel('or-sonnet', roster)?.alias).toBe('or-sonnet');
    expect(resolveTypedModel('or-sonnet-tranche-2026-08', roster)?.alias).toBe('or-sonnet');
    expect(resolveTypedModel('openai/gpt-4.1', roster)?.alias).toBe('or-gpt41');
    expect(resolveTypedModel('gpt-4.1', roster)?.alias).toBe('or-gpt41');
    expect(resolveTypedModel('GPT 4.1', roster)?.alias).toBe('or-gpt41');
  });
  it('returns null for a model the roster has not measured', () => {
    expect(resolveTypedModel('gemini-3-ultra', roster)).toBeNull();
    expect(resolveTypedModel('', roster)).toBeNull();
  });
});
