import { describe, expect, it } from 'vitest';
import type { ChatMessage, PriceTable, StrategyConfig } from '@potion/core';
import { programCallCount, programModels, strategyHash } from '@potion/core';
import type { CompleteRequest, Provider } from '@potion/providers';
import { createProviders } from '@potion/providers';
import { createResolver } from './resolve.js';
import { execute } from './execute.js';
import { confidenceGatedCascade, consensusOrEscalate, normalizeAnswer, verifiedCascade, MAX_PROGRAM_CALLS } from './program.js';
import type { ExecContext } from './types.js';

const PRICES: PriceTable = {
  version: 'p-test', updatedAt: '2026-08-22',
  entries: ['cheap-a', 'cheap-b', 'strong', 'judge', ...Array.from({ length: 9 }, (_, i) => `v${i}`)].map((alias) => ({ alias, provider: 'mock' as const, model: `${alias}-v1`, inputPer1M: 0, outputPer1M: 0 })),
};
const MESSAGES: ChatMessage[] = [{ role: 'user', content: 'What is the capital of France?' }];

/** A provider whose answer and confidence are scripted per model; counts calls. */
function scripted(script: Record<string, { text: string; confidence?: number }>) {
  const calls: string[] = [];
  const base = createProviders({ prices: PRICES }).mock;
  const provider: Provider = {
    id: 'mock',
    complete: async (req: CompleteRequest) => {
      calls.push(req.model);
      const r = await base.complete(req);
      const s = script[req.model] ?? { text: `answer from ${req.model}` };
      const { logprobConfidence: _drop, ...rest } = r;
      return { ...rest, text: s.text, ...(s.confidence !== undefined ? { logprobConfidence: s.confidence } : {}) };
    },
  };
  const providers = { ...createProviders({ prices: PRICES }), mock: provider };
  const ctx: ExecContext = { providers, prices: PRICES, resolve: createResolver(providers, PRICES), seed: 1, captureConfidence: true };
  return { ctx, calls };
}

describe('program interpreter — mechanisms as data', () => {
  it('consensus-or-escalate: agreement → the more confident cheap answer, two calls, no strong', async () => {
    const { ctx, calls } = scripted({ 'cheap-a': { text: 'Paris.', confidence: 0.7 }, 'cheap-b': { text: 'paris', confidence: 0.9 }, strong: { text: 'Paris' } });
    const cfg: StrategyConfig = { type: 'program', name: 'coe', body: consensusOrEscalate('coe', 'cheap-a', 'cheap-b', 'strong') };
    const r = await execute(cfg, MESSAGES, ctx);
    expect(r.text).toBe('paris'); // cheap-b, the more confident
    expect(calls.sort()).toEqual(['cheap-a', 'cheap-b']);
    expect(r.trace).toHaveLength(2); // memoized: the nodes checked are the nodes picked
  });

  it('consensus-or-escalate: disagreement → the strong model decides, three calls', async () => {
    const { ctx, calls } = scripted({ 'cheap-a': { text: 'Paris', confidence: 0.7 }, 'cheap-b': { text: 'Lyon', confidence: 0.9 }, strong: { text: 'Paris, France' } });
    const cfg: StrategyConfig = { type: 'program', name: 'coe', body: consensusOrEscalate('coe', 'cheap-a', 'cheap-b', 'strong') };
    const r = await execute(cfg, MESSAGES, ctx);
    expect(r.text).toBe('Paris, France');
    expect(calls.sort()).toEqual(['cheap-a', 'cheap-b', 'strong']);
    expect(r.usage.inputTokens).toBeGreaterThan(0);
  });

  it('verified cascade: the fact-check decides; a failing JSON shape escalates', async () => {
    const okCtx = scripted({ 'cheap-a': { text: '{"order": "A1", "issue": "late"}' }, strong: { text: '{"order":"A1","issue":"late","urgency":"high"}' } });
    const cfg: StrategyConfig = { type: 'program', name: 'vc', body: verifiedCascade('cheap-a', 'strong', { kind: 'json', requiredKeys: ['order', 'issue', 'urgency'] }) };
    const r = await execute(cfg, MESSAGES, okCtx.ctx);
    expect(r.text).toContain('urgency'); // cheap lacked a required key → strong
    expect(okCtx.calls).toEqual(['cheap-a', 'strong']);
    const passCtx = scripted({ 'cheap-a': { text: 'Sure! {"order": "A1", "issue": "late", "urgency": "low"}' } });
    const r2 = await execute(cfg, MESSAGES, passCtx.ctx);
    expect(passCtx.calls).toEqual(['cheap-a']);
    expect(r2.text).toContain('A1');
  });

  it('confidence-gated cascade: low confidence escalates; missing confidence escalates too', async () => {
    const cfg: StrategyConfig = { type: 'program', name: 'cg', body: confidenceGatedCascade('cheap-a', 'strong', 0.8) };
    const low = scripted({ 'cheap-a': { text: 'Rome', confidence: 0.4 }, strong: { text: 'Paris' } });
    expect((await execute(cfg, MESSAGES, low.ctx)).text).toBe('Paris');
    const high = scripted({ 'cheap-a': { text: 'Paris', confidence: 0.95 } });
    expect((await execute(cfg, MESSAGES, high.ctx)).text).toBe('Paris');
    expect(high.calls).toEqual(['cheap-a']);
    const blind = scripted({ 'cheap-a': { text: 'Paris' }, strong: { text: 'Paris (strong)' } });
    expect((await execute(cfg, MESSAGES, blind.ctx)).text).toBe('Paris (strong)');
  });

  it('vote: majority of normalized answers wins; pick by judge uses the judge model', async () => {
    const { ctx, calls } = scripted({ 'cheap-a': { text: 'Paris' }, 'cheap-b': { text: 'PARIS.' }, strong: { text: 'Lyon' } });
    const vote: StrategyConfig = { type: 'program', name: 'v', body: { op: 'vote', of: [{ op: 'call', model: 'cheap-a' }, { op: 'call', model: 'cheap-b' }, { op: 'call', model: 'strong' }] } };
    expect((await execute(vote, MESSAGES, ctx)).text).toBe('Paris');
    expect(calls).toHaveLength(3);
    const judged = scripted({ 'cheap-a': { text: 'Paris' }, 'cheap-b': { text: 'Lyon' }, judge: { text: 'Candidate 2 is best: 2' } });
    const pick: StrategyConfig = { type: 'program', name: 'j', body: { op: 'pick', of: [{ op: 'call', model: 'cheap-a' }, { op: 'call', model: 'cheap-b' }], by: { kind: 'judge', model: 'judge' } } };
    expect((await execute(pick, MESSAGES, judged.ctx)).text).toBe('Lyon');
    expect(judged.calls).toEqual(['cheap-a', 'cheap-b', 'judge']);
  });

  it('static bounds: models and call count are computable before a run; the interpreter refuses past MAX', async () => {
    const body = consensusOrEscalate('coe', 'cheap-a', 'cheap-b', 'strong');
    expect(programModels(body)).toEqual(['cheap-a', 'cheap-b', 'strong']);
    expect(programCallCount(body)).toBe(3);
    const tooMany: StrategyConfig = { type: 'program', name: 'big', body: { op: 'vote', of: Array.from({ length: 9 }, (_, i) => ({ op: 'call' as const, model: `v${i}` })) } };
    expect(programCallCount(tooMany.body)).toBe(9);
    const { ctx } = scripted({});
    await expect(execute(tooMany, MESSAGES, ctx)).rejects.toThrow(new RegExp(`exceeded ${MAX_PROGRAM_CALLS} calls`));
  });

  it('a program hashes deterministically, so a receipt can name it', () => {
    const a: StrategyConfig = { type: 'program', name: 'coe', body: consensusOrEscalate('coe', 'cheap-a', 'cheap-b', 'strong') };
    const b: StrategyConfig = { type: 'program', name: 'coe', body: consensusOrEscalate('coe', 'cheap-a', 'cheap-b', 'strong') };
    expect(strategyHash(a)).toBe(strategyHash(b));
    expect(strategyHash(a)).not.toBe(strategyHash({ type: 'single', model: 'cheap-a' }));
    expect(normalizeAnswer('  Paris. ')).toBe('paris');
  });
});
