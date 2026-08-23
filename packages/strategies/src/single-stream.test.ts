import { describe, expect, it } from 'vitest';
import { createProviders } from '@potion/providers';
import { createResolver } from './resolve.js';
import type { PriceTable } from '@potion/core';
import { execute } from './execute.js';
import type { ExecContext } from './types.js';

const PRICES: PriceTable = { version: 'test', entries: [{ alias: 'mock-cheap', provider: 'mock', model: 'mock-cheap-v1', inputPer1M: 0, outputPer1M: 0 }] } as never;

/** The deterministic mock transport, given a real token stream. */
function makeCtx(log: string[], tokens: string[], extra?: Partial<ExecContext>): ExecContext {
  const base = createProviders({ prices: PRICES });
  const mock = {
    ...base.mock,
    complete: async (req: never) => { log.push('complete'); return base.mock.complete(req); },
    completeStream: async (req: never, onToken: (t: string) => void) => {
      log.push('stream');
      const res = await base.mock.complete(req);
      for (const piece of res.text.split(' ')) onToken(piece + ' ');
      return res;
    },
  };
  const providers = { ...base, mock } as never;
  return { providers, prices: PRICES, resolve: createResolver(providers, PRICES), stream: (t: string) => tokens.push(t), ...extra };
}
const MESSAGES = [{ role: 'user' as const, content: 'Summarize the plot of Hamlet briefly.' }];

describe('single strategy streaming', () => {
  it('relays the provider’s own stream when the caller wants tokens', async () => {
    const log: string[] = []; const tokens: string[] = [];
    const r = await execute({ type: 'single', model: 'mock-cheap' }, MESSAGES, makeCtx(log, tokens));
    expect(log).toEqual(['stream']);
    expect(tokens.length).toBeGreaterThan(1);
    expect(tokens.join('').trim()).toBe(r.text.trim());
  });
  it('falls back to the complete call and a replayed stream when tools are in play', async () => {
    const log: string[] = []; const tokens: string[] = [];
    const r = await execute({ type: 'single', model: 'mock-cheap' }, MESSAGES, makeCtx(log, tokens, { params: { tools: [{ type: 'function', function: { name: 'f', parameters: {} } }] } } as never));
    expect(log).toEqual(['complete']);
    expect(tokens.join('')).toBe(r.text);
  });
});
