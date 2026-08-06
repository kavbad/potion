import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PriceTable } from '@potion/core';
import {
  createProviders,
  costOf,
  loadPrices,
  mockEmbedText,
  pricesStaleness,
  ProviderAuthError,
  type CompleteRequest,
} from './index.js';

const PRICES: PriceTable = {
  version: '2026-08-04',
  updatedAt: '2026-08-04',
  entries: [
    { alias: 'sonnet-class', provider: 'anthropic', model: 'claude-sonnet-4-5-20250929', inputPer1M: 3, outputPer1M: 15 },
    { alias: 'mock-cheap', provider: 'mock', model: 'mock-cheap-v1', inputPer1M: 0, outputPer1M: 0 },
    { alias: 'mock-frontier', provider: 'mock', model: 'mock-frontier-v1', inputPer1M: 0, outputPer1M: 0 },
  ],
};

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += (a[i] ?? 0) * (b[i] ?? 0);
    na += (a[i] ?? 0) ** 2;
    nb += (b[i] ?? 0) ** 2;
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

describe('mock provider', () => {
  const providers = createProviders({ prices: PRICES });
  const req: CompleteRequest = {
    model: 'mock-frontier',
    messages: [
      { role: 'system', content: 'You are terse.' },
      { role: 'user', content: 'Write a Python function that sorts a list.' },
    ],
    params: { seed: 1234 },
  };

  it('is deterministic: same seed → identical output', async () => {
    const a = await providers.mock.complete(req);
    const b = await providers.mock.complete(req);
    expect(a).toEqual(b);
    expect(a.text.startsWith('[mock:mock-frontier] ')).toBe(true);
    expect(a.modelVersion).toBe('mock-frontier-v1#mock-v1');
  });

  it('different seeds produce different text/confidence', async () => {
    const a = await providers.mock.complete(req);
    const b = await providers.mock.complete({ ...req, params: { seed: 987 } });
    expect(a.text === b.text && a.logprobConfidence === b.logprobConfidence).toBe(false);
  });

  it('derives seed from prompt hash when params.seed is absent', async () => {
    const noSeed: CompleteRequest = { model: req.model, messages: req.messages };
    const a = await providers.mock.complete(noSeed);
    const b = await providers.mock.complete(noSeed);
    expect(a).toEqual(b);
  });

  it('usage follows chars/4 and latency follows the model profile', async () => {
    const res = await providers.mock.complete(req);
    const promptChars = 'system:You are terse.\nuser:Write a Python function that sorts a list.'.length;
    expect(res.usage.inputTokens).toBe(Math.ceil(promptChars / 4));
    expect(res.usage.outputTokens).toBe(Math.ceil(res.text.length / 4));
    expect(res.latencyMs).toBe(1800); // frontier profile
    const cheap = await providers.mock.complete({ ...req, model: 'mock-cheap' });
    expect(cheap.latencyMs).toBe(300); // cheap profile
  });

  // M3 #25 (OpenAI parity): deterministic tool-call echo fixture — hash-derived
  // (no rng draws), text '' like OpenAI tool_call turns, and tool-less prompts
  // keep the bit-identical legacy behavior.
  it('tool-call echo: deterministic, echoes the first tool, leaves legacy output untouched', async () => {
    const tools = [
      {
        type: 'function' as const,
        function: { name: 'get_weather', parameters: { type: 'object' } },
      },
    ];
    const toolReq: CompleteRequest = { ...req, params: { seed: 1234, tools, tool_choice: 'auto' } };
    const a = await providers.mock.complete(toolReq);
    const b = await providers.mock.complete(toolReq);
    expect(a).toEqual(b); // deterministic
    expect(a.text).toBe('');
    expect(a.toolCalls).toHaveLength(1);
    const tc = a.toolCalls![0]!;
    expect(tc.id).toMatch(/^call_[0-9a-f]{8}$/);
    expect(tc.type).toBe('function');
    expect(tc.function.name).toBe('get_weather');
    const args = JSON.parse(tc.function.arguments) as { echo: string; seed: number };
    expect(args.echo).toContain('sorts a list');
    expect(args.seed).toBe(1234);
    // Legacy invariant: the tool-less twin of the same request is unchanged.
    const legacy = await providers.mock.complete(req);
    expect(legacy.toolCalls).toBeUndefined();
    expect(legacy.text.startsWith('[mock:mock-frontier] ')).toBe(true);
  });

  it('logprobConfidence is deterministic within [0.5, 0.99]', async () => {
    for (const seed of [1, 42, 777, 999999]) {
      const res = await providers.mock.complete({ ...req, params: { seed } });
      expect(res.logprobConfidence).toBeGreaterThanOrEqual(0.5);
      expect(res.logprobConfidence).toBeLessThanOrEqual(0.99);
    }
  });

  it('costOf matches hand-computed token math', async () => {
    const res = await providers.mock.complete({ ...req, model: 'sonnet-class' });
    const entry = PRICES.entries.find((e) => e.alias === 'sonnet-class')!;
    // hand-computed: (in * 3 + out * 15) / 1e6
    const expected =
      (res.usage.inputTokens * 3 + res.usage.outputTokens * 15) / 1_000_000;
    expect(costOf(res, entry)).toBeCloseTo(expected, 12);
    // mock entries are $0
    const mockRes = await providers.mock.complete(req);
    expect(costOf(mockRes, PRICES.entries.find((e) => e.alias === 'mock-frontier')!)).toBe(0);
  });
});

describe('mock embed', () => {
  it('is deterministic and 384-dim unit-norm', () => {
    const text = 'Write a Python function to reverse a string';
    const a = mockEmbedText(text);
    const b = mockEmbedText(text);
    expect(a).toEqual(b);
    expect(a).toHaveLength(384);
    const norm = Math.sqrt(a.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 6);
  });

  it('clusters semantically: same-cluster cosine > different-cluster cosine', () => {
    const code1 = mockEmbedText('Write a Python function that parses CSV');
    const code2 = mockEmbedText('Implement a function to fix the bug in this code');
    const extract = mockEmbedText('Extract all invoice fields as JSON');
    const sameCluster = cosine(code1, code2);
    const diffCluster = cosine(code1, extract);
    expect(sameCluster).toBeGreaterThan(diffCluster);
    expect(sameCluster).toBeGreaterThan(0.9); // noise ≤ 0.15 keeps pairs tight
    expect(Math.abs(diffCluster)).toBeLessThan(0.25); // near-orthogonal centroids
  });
});

describe('createProviders lazy live providers', () => {
  it('import + construction never throws; first call throws ProviderAuthError without a key', async () => {
    const providers = createProviders({ prices: PRICES });
    expect(Object.keys(providers).sort()).toEqual(
      ['anthropic', 'google', 'mock', 'openai', 'openrouter'].sort(),
    );
    await expect(
      providers.anthropic.complete({ model: 'x', messages: [] }),
    ).rejects.toThrow(ProviderAuthError);
    await expect(
      providers.anthropic.complete({ model: 'x', messages: [] }),
    ).rejects.toThrow(/no API key for 'anthropic'/);
    await expect(
      providers.openai.complete({ model: 'x', messages: [] }),
    ).rejects.toThrow(ProviderAuthError);
  });

  it('embed-capable providers without a key throw the same first-call auth error', async () => {
    const providers = createProviders({ prices: PRICES });
    expect(providers.openai.embed).toBeDefined();
    expect(providers.google.embed).toBeDefined();
    // Anthropic/OpenRouter embeds stay undefined (no embeddings API in v1).
    expect(providers.anthropic.embed).toBeUndefined();
    expect(providers.openrouter.embed).toBeUndefined();
    await expect(providers.openai.embed!(['hi'])).rejects.toThrow(ProviderAuthError);
    await expect(providers.google.embed!(['hi'])).rejects.toThrow(ProviderAuthError);
  });
});

describe('loadPrices', () => {
  it('loads + validates a price table from disk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'potion-prices-'));
    const path = join(dir, 'prices.json');
    writeFileSync(path, JSON.stringify(PRICES));
    const loaded = loadPrices(path);
    expect(loaded.table.version).toBe('2026-08-04');
    expect(loaded.table.entries).toHaveLength(3);
    expect(loaded.path).toBe(path);
  });

  it('flags staleness > 30 days (and not fresh tables)', () => {
    const fresh = pricesStaleness(PRICES, new Date('2026-08-10'));
    expect(fresh.stale).toBe(false);
    const old = pricesStaleness(PRICES, new Date('2026-10-01'));
    expect(old.stale).toBe(true);
    expect(old.ageDays).toBeGreaterThan(30);
  });

  it('rejects invalid tables', () => {
    const dir = mkdtempSync(join(tmpdir(), 'potion-prices-'));
    const path = join(dir, 'bad.json');
    writeFileSync(path, JSON.stringify({ version: 1 }));
    expect(() => loadPrices(path)).toThrow();
  });
});
