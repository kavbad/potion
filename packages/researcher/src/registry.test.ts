// Registry tests (M4b #37, SPEC §15.1): class hints, price bands,
// representatives, cross-provider peers.
import { describe, expect, it } from 'vitest';
import type { PriceEntry } from '@potion/core';
import {
  buildRegistry,
  classifyModel,
  classMembers,
  classRepresentative,
  crossProviderPeers,
  type ModelRegistryEntry,
} from './registry.js';

function entry(alias: string, provider: PriceEntry['provider'], input: number, output = input * 5): PriceEntry {
  return { alias, provider, model: alias, inputPer1M: input, outputPer1M: output };
}

describe('classifyModel', () => {
  it('alias hints win over price', () => {
    // $1 input would price-band to mid, but the haiku hint says cheap.
    expect(classifyModel(entry('or-haiku', 'openrouter', 1.0))).toBe('cheap');
    // $1.25 would band to mid, but the frontier hint says strong.
    expect(classifyModel(entry('gpt-frontier-class', 'openai', 1.25))).toBe('strong');
    expect(classifyModel(entry('or-judge', 'openrouter', 3.0))).toBe('judge');
    expect(classifyModel(entry('cheap-class', 'anthropic', 1.0))).toBe('cheap');
  });

  it('falls back to price bands for machine aliases (scanned models)', () => {
    expect(classifyModel(entry('or-deepseek', 'openrouter', 0.25))).toBe('cheap');
    expect(classifyModel(entry('or-gpt-full', 'openrouter', 2.0))).toBe('mid');
    // A scanned frontier model at $10 input → strong.
    expect(classifyModel(entry('or-fable-5', 'openrouter', 10.0))).toBe('strong');
    expect(classifyModel(entry('gemini-pro-class', 'google', 1.25))).toBe('mid');
  });
});

describe('buildRegistry / classRepresentative / crossProviderPeers', () => {
  const registry = buildRegistry({
    version: 'test',
    updatedAt: '2026-08-06',
    entries: [
      entry('mock-cheap', 'mock', 0),
      entry('mock-frontier', 'mock', 0),
      entry('mock-judge', 'mock', 0),
      entry('or-sonnet', 'openrouter', 3.0),
      entry('or-fable-5', 'openrouter', 10.0),
      entry('opus-class', 'anthropic', 15.0),
      entry('gpt-frontier-class', 'openai', 1.25),
    ],
  });

  it('annotates every entry with a class', () => {
    expect(registry.map((r) => r.cls).sort()).toEqual(
      ['cheap', 'judge', 'mid', 'strong', 'strong', 'strong', 'strong'].sort(),
    );
  });

  it('representative = cheapest input, alias tie-break', () => {
    expect(classRepresentative(registry, 'strong')?.alias).toBe('mock-frontier'); // 0 < 1.25
    expect(classRepresentative(registry, 'strong', 'mock')?.alias).toBe('gpt-frontier-class');
    expect(classRepresentative(registry, 'mid')?.alias).toBe('or-sonnet'); // 3.0 → mid band
  });

  it('peers are cross-provider, provider-diverse first', () => {
    const peers = crossProviderPeers(registry, 'strong', 'openrouter', 2);
    expect(peers.map((p) => p.alias)).toEqual(['mock-frontier', 'gpt-frontier-class']);
    expect(peers.every((p) => p.provider !== 'openrouter')).toBe(true);
  });
});

// ---- 0094: selection cannot pick a model that fails out ----
//
// Found live. classRepresentative picks the CHEAPEST in class and price was
// the only thing it knew, so every cycle chose `or-ling-3.0-flash` — a model
// that could not complete three of four measured arms. Cheapest-in-class
// selects for junk: a model can be cheapest precisely because it is bad.
describe('unhealthy models are not selectable', () => {
  const e = (alias: string, inputPer1M: number, unhealthy = false): ModelRegistryEntry => ({
    alias, provider: 'openrouter', cls: 'cheap', inputPer1M, outputPer1M: inputPer1M * 3,
    ...(unhealthy ? { unhealthy: true } : {}),
  });

  it('the cheapest BROKEN model loses to a dearer working one', () => {
    const reg = [e('ling', 0.02, true), e('solar', 0.03)];
    expect(classRepresentative(reg, 'cheap')?.alias).toBe('solar');
    expect(classMembers(reg, 'cheap').map((m) => m.alias)).toEqual(['solar']);
  });

  it('FAILS CLOSED when the whole class is broken — never falls back to junk', () => {
    // Returning the cheapest broken model would be the bug: a cycle that
    // spends real money on something that cannot complete, then reports the
    // failure as the strategy's quality.
    expect(classRepresentative([e('ling', 0.02, true), e('other', 0.03, true)], 'cheap')).toBeNull();
  });

  it('a healthy model is still chosen on price, so nothing else changes', () => {
    expect(classRepresentative([e('ling', 0.02), e('solar', 0.03)], 'cheap')?.alias).toBe('ling');
  });

  it('cross-provider peers skip broken models too — a consensus gate needs two working answers', () => {
    const reg: ModelRegistryEntry[] = [
      { alias: 'a', provider: 'openai', cls: 'cheap', inputPer1M: 1, outputPer1M: 2 },
      { alias: 'broken', provider: 'anthropic', cls: 'cheap', inputPer1M: 0.1, outputPer1M: 0.2, unhealthy: true },
      { alias: 'ok', provider: 'google', cls: 'cheap', inputPer1M: 0.5, outputPer1M: 1 },
    ];
    expect(crossProviderPeers(reg, 'cheap', 'openai', 2).map((m) => m.alias)).toEqual(['ok']);
  });
});
