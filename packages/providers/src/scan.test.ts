// Scan tests (M4b #37, SPEC §15.2): OpenRouter /models parsing (per-token
// string pricing × 1e6), registry diffing, alias minting, mock fixture.
import { describe, expect, it } from 'vitest';
import type { PriceTable } from '@potion/core';
import {
  aliasForOpenRouterId,
  diffModelListings,
  fetchOpenRouterModels,
  mockModels,
  MOCK_MODEL_LISTINGS,
} from './scan.js';

const REGISTRY: PriceTable = {
  version: 'test',
  updatedAt: '2026-08-06',
  entries: [
    { alias: 'or-sonnet', provider: 'openrouter', model: 'anthropic/claude-sonnet-4.5', inputPer1M: 3, outputPer1M: 15 },
    { alias: 'mock-cheap', provider: 'mock', model: 'mock-cheap-v1', inputPer1M: 0, outputPer1M: 0 },
  ],
};

describe('aliasForOpenRouterId', () => {
  it('mints deterministic or- slugs from the id tail', () => {
    expect(aliasForOpenRouterId('anthropic/claude-fable-5', new Set())).toBe('or-claude-fable-5');
    expect(aliasForOpenRouterId('openai/gpt-5.1', new Set())).toBe('or-gpt-5-1');
    expect(aliasForOpenRouterId('bare-id', new Set())).toBe('or-bare-id');
  });

  it('suffixes collisions', () => {
    const existing = new Set(['or-claude-fable-5']);
    expect(aliasForOpenRouterId('anthropic/claude-fable-5', existing)).toBe('or-claude-fable-5-2');
  });
});

describe('fetchOpenRouterModels', () => {
  it('parses the OpenRouter shape; per-token strings → numbers', async () => {
    const payload = {
      data: [
        {
          id: 'anthropic/claude-fable-5',
          canonical_slug: 'anthropic/claude-fable-5',
          created: 1_780_000_000,
          pricing: { prompt: '0.00001', completion: '0.00005' },
          supported_parameters: ['tools', 'structured_outputs'],
        },
        { id: 'broken/no-pricing' },
        'garbage',
        { noId: true },
      ],
    };
    const fetchImpl = async () =>
      new Response(JSON.stringify(payload), { status: 200 }) as ReturnType<typeof fetch>;
    const listings = await fetchOpenRouterModels({ apiKey: 'sk-or-test', fetchImpl: fetchImpl as never });
    expect(listings.length).toBe(2);
    expect(listings[0]).toMatchObject({
      id: 'anthropic/claude-fable-5',
      promptPerToken: 0.00001,
      completionPerToken: 0.00005,
      created: 1_780_000_000,
      supportedParameters: ['tools', 'structured_outputs'],
    });
    expect(listings[1]).toEqual({ id: 'broken/no-pricing' });
  });

  it('throws on non-200', async () => {
    const fetchImpl = async () => new Response('nope', { status: 503 });
    await expect(
      fetchOpenRouterModels({ apiKey: 'k', fetchImpl: fetchImpl as never }),
    ).rejects.toThrow('HTTP 503');
  });
});

describe('diffModelListings', () => {
  it('splits added / already-known / no-pricing; converts ×1e6', () => {
    const diff = diffModelListings(
      [
        { id: 'anthropic/claude-sonnet-4.5' }, // known by model id
        { id: 'anthropic/claude-fable-5', promptPerToken: 1e-5, completionPerToken: 5e-5 },
        { id: 'openai/gpt-5.1' }, // no pricing
      ],
      REGISTRY,
    );
    expect(diff.alreadyKnown).toEqual(['anthropic/claude-sonnet-4.5']);
    expect(diff.skippedNoPricing).toEqual(['openai/gpt-5.1']);
    expect(diff.added.length).toBe(1);
    expect(diff.added[0]).toEqual({
      alias: 'or-claude-fable-5',
      provider: 'openrouter',
      model: 'anthropic/claude-fable-5',
      inputPer1M: 10, // 1e-5 × 1e6, a NUMBER
      outputPer1M: 50,
    });
  });

  it('canonical_slug matches count as known', () => {
    const diff = diffModelListings(
      [{ id: 'anthropic/claude-sonnet-4.5-20250929', canonicalSlug: 'anthropic/claude-sonnet-4.5' }],
      REGISTRY,
    );
    expect(diff.alreadyKnown.length).toBe(1);
    expect(diff.added.length).toBe(0);
  });
});

describe('mockModels fixture (SPEC §15.2)', () => {
  it('contains known + new + no-pricing listings', () => {
    const listings = mockModels();
    expect(listings.length).toBe(MOCK_MODEL_LISTINGS.length);
    const diff = diffModelListings(listings, REGISTRY);
    expect(diff.alreadyKnown).toEqual(['mock-cheap-v1']);
    expect(diff.added.map((a) => a.alias)).toEqual(['or-mock-nova-1', 'or-mock-apex-1']);
    expect(diff.added[0]!.inputPer1M).toBeCloseTo(0.2, 12);
    expect(diff.added[1]!.inputPer1M).toBeCloseTo(12, 12);
    expect(diff.skippedNoPricing).toEqual(['mock/mock-free-0']);
    // defensive copy: mutating the result does not touch the fixture
    listings[0]!.id = 'mutated';
    expect(MOCK_MODEL_LISTINGS[0]!.id).toBe('mock-cheap-v1');
  });
});

describe('what the catalogue parser REFUSES to call a model', () => {
  // Measured against the live OpenRouter catalogue, not imagined: 415 rows
  // contained 5 negative-priced router pseudo-models and 61 :batch variants.
  // Both would have entered the registry as routing candidates.
  const body = (models: unknown[]): Response =>
    new Response(JSON.stringify({ data: models }), { status: 200 });

  it('drops NEGATIVE pricing — a router sentinel that would sort cheapest', async () => {
    const out = await fetchOpenRouterModels({
      apiKey: 'k',
      fetchImpl: async () =>
        body([
          { id: 'openrouter/auto', pricing: { prompt: '-1', completion: '-1' } },
          { id: 'vendor/real', pricing: { prompt: '0.0000005', completion: '0.0000015' } },
        ]),
    });
    expect(out.map((m) => m.id)).toEqual(['vendor/real']);
  });

  it('drops :batch variants — a sync request cannot be served by an async endpoint', async () => {
    const out = await fetchOpenRouterModels({
      apiKey: 'k',
      fetchImpl: async () =>
        body([
          { id: 'anthropic/claude-opus-5:batch', pricing: { prompt: '0.0000025', completion: '0.00001' } },
          { id: 'anthropic/claude-opus-5', pricing: { prompt: '0.000005', completion: '0.000025' } },
        ]),
    });
    expect(out.map((m) => m.id)).toEqual(['anthropic/claude-opus-5']);
  });

  it('KEEPS :free variants — real models, and unmeasured ones are never auto-selected anyway', async () => {
    const out = await fetchOpenRouterModels({
      apiKey: 'k',
      fetchImpl: async () => body([{ id: 'vendor/small:free', pricing: { prompt: '0', completion: '0' } }]),
    });
    expect(out.map((m) => m.id)).toEqual(['vendor/small:free']);
  });
});
