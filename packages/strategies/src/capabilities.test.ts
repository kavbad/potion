import { describe, expect, it } from 'vitest';
import { createProviders } from '@potion/providers';
import type { PriceTable } from '@potion/core';
import { strategyCapabilities } from './capabilities.js';
import { execute } from './execute.js';
import { createResolver } from './resolve.js';

describe('strategyCapabilities', () => {
  it('declares what each shape can honestly carry', () => {
    expect(strategyCapabilities({ type: 'single', model: 'm' })).toEqual({ canServeTools: true, canStream: true });
    expect(strategyCapabilities({ type: 'cascade', stages: [{ model: 'a', escalateIf: { confidenceBelow: 0.9 } }, { model: 'b' }], confidenceMethod: 'self-report-calibrated' })).toEqual({ canServeTools: true, canStream: false });
    expect(strategyCapabilities({ type: 'composite', startModel: 'a', upgradeModel: 'b', upgradeIf: { confidenceBelow: 0.9 } })).toEqual({ canServeTools: false, canStream: true });
  });
});

const PRICES: PriceTable = { version: 't', updatedAt: '2026-01-01T00:00:00Z', entries: [
  { alias: 'mock-cheap', provider: 'mock', model: 'mock-cheap-v1', inputPer1M: 0, outputPer1M: 0 },
  { alias: 'mock-frontier', provider: 'mock', model: 'mock-frontier-v1', inputPer1M: 0, outputPer1M: 0 },
] };

describe('cascade with tools', () => {
  it('forwards the tools to the stage and stops at the stage that calls one', async () => {
    const base = createProviders({ prices: PRICES });
    const seen: unknown[] = [];
    const mock = {
      ...base.mock,
      complete: async (req: Parameters<typeof base.mock.complete>[0]) => {
        seen.push(req.params?.tools);
        return { text: '', usage: { inputTokens: 1, outputTokens: 1 }, latencyMs: 1, modelVersion: 'm', toolCalls: [{ id: 'c1', type: 'function' as const, function: { name: 'get_weather', arguments: '{"city":"Paris"}' } }] };
      },
    };
    const providers = { ...base, mock };
    const tools = [{ type: 'function' as const, function: { name: 'get_weather', parameters: {} } }];
    const r = await execute(
      { type: 'cascade', stages: [{ model: 'mock-cheap', escalateIf: { confidenceBelow: 0.99 } }, { model: 'mock-frontier' }], confidenceMethod: 'self-report-calibrated' },
      [{ role: 'user', content: 'Weather in Paris? Use the tool.' }],
      { providers, prices: PRICES, resolve: createResolver(providers, PRICES), params: { tools } },
    );
    expect(seen).toEqual([tools]); // one stage call, tools attached, no escalation probe
    expect(r.toolCalls?.[0]?.function.name).toBe('get_weather');
    expect(r.trace.map((t) => t.decision)).toEqual(['tool_call']);
  });
});
