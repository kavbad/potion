import { describe, expect, it } from 'vitest';
import { incumbentRoster } from '../src/incumbents/roster.js';

describe('incumbent roster', () => {
  it('names models a person recognises and excludes what must not be offered', () => {
    const prices = {
      version: 't',
      entries: [
        { alias: 'or-gpt-full', provider: 'openrouter', model: 'openai/gpt-4.1', inputPer1M: 2, outputPer1M: 8 },
        { alias: 'or-sonnet', provider: 'openrouter', model: 'anthropic/claude-sonnet-4.5', inputPer1M: 3, outputPer1M: 15 },
        { alias: 'or-solar-pro4', provider: 'openrouter', model: 'upstage/solar-pro-4', inputPer1M: 0.1, outputPer1M: 0.1 },
        { alias: 'gpt-mini-class', provider: 'openrouter', model: 'openai/gpt-4.1-mini', inputPer1M: 0.4, outputPer1M: 1.6 },
        { alias: 'mock-cheap', provider: 'mock', model: 'mock', inputPer1M: 0, outputPer1M: 0 },
      ],
    } as never;
    const r = incumbentRoster(prices);
    expect(r.map((x) => x.alias)).toEqual(['or-sonnet', 'or-gpt-full']);
    expect(r[1]).toMatchObject({ name: 'GPT 4.1', vendor: 'OpenAI', native: 'openai/gpt-4.1' });
    expect(r[0]?.name).toBe('Claude Sonnet 4.5');
    expect(JSON.stringify(r)).not.toMatch(/solar|upstage|mock|-class/);
  });
});
