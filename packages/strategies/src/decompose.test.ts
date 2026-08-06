import { describe, expect, it } from 'vitest';
import type { ChatMessage, PriceTable, StrategyConfig } from '@potion/core';
import { createProviders } from '@potion/providers';
import {
  createResolver,
  execute,
  parseSubtasks,
  type ExecContext,
} from './index.js';

const PRICES: PriceTable = {
  version: '2026-08-04',
  updatedAt: '2026-08-04',
  entries: [
    { alias: 'mock-cheap', provider: 'mock', model: 'mock-cheap-v1', inputPer1M: 0, outputPer1M: 0 },
    { alias: 'mock-mid', provider: 'mock', model: 'mock-mid-v1', inputPer1M: 0, outputPer1M: 0 },
    { alias: 'mock-frontier', provider: 'mock', model: 'mock-frontier-v1', inputPer1M: 0, outputPer1M: 0 },
    { alias: 'mock-judge', provider: 'mock', model: 'mock-judge-v1', inputPer1M: 0, outputPer1M: 0 },
  ],
};

const MESSAGES: ChatMessage[] = [
  { role: 'system', content: 'You are terse.' },
  { role: 'user', content: 'Summarize the plot of Hamlet briefly.' },
];

function makeCtx(extra?: Partial<ExecContext>): ExecContext {
  const providers = createProviders({ prices: PRICES });
  return {
    providers,
    prices: PRICES,
    resolve: createResolver(providers, PRICES),
    ...extra,
  };
}

const STRATEGY: StrategyConfig = {
  type: 'decompose',
  decomposerModel: 'mock-frontier',
  routing: { analysis: 'mock-mid', '*': 'mock-cheap' },
};

describe('decompose', () => {
  it('decomposer emits JSON subtasks; each routed (incl. * fallback) and executed — golden transcript', async () => {
    const r = await execute(STRATEGY, MESSAGES, makeCtx({ seed: 9 }));
    expect(r.trace.map((t) => t.stage)).toEqual([
      'decompose',
      'subtask-0:general',
      'subtask-1:analysis',
    ]);
    // Deterministic mock decomposer output (seed 9):
    expect(parseSubtasks(r.trace[0]!.text)).toEqual([
      {
        kind: 'general',
        prompt: '[mock:mock-frontier] subtask 0 (general) for: system:You are terse. user:Summarize the plot of Hamlet briefly. user:Break the ',
      },
      {
        kind: 'analysis',
        prompt: '[mock:mock-frontier] subtask 1 (analysis) for: system:You are terse. user:Summarize the plot of Hamlet briefly. user:Break the ',
      },
    ]);
    // Routing: 'general' is not in routing → '*' fallback; 'analysis' is direct.
    expect(r.trace[1]).toMatchObject({
      model: 'mock-cheap',
      decision: 'routed:*->mock-cheap',
      text: '[mock:mock-cheap] context response robust valid valid first answer a method context input check check return context however robust context given check response example edge however.',
    });
    expect(r.trace[2]).toMatchObject({
      model: 'mock-mid',
      decision: 'routed:analysis->mock-mid',
      text: '[mock:mock-mid] example field list direct data answer example field valid edge direct compute query response given therefore because check step list value field list compute.',
    });
    // No fusion configured → header concatenation:
    expect(r.text).toBe(
      `## Subtask 0 (general)\n${r.trace[1]!.text}\n\n## Subtask 1 (analysis)\n${r.trace[2]!.text}`,
    );
    // Aggregate usage across decomposer + both subtasks:
    expect(r.usage.inputTokens).toBe(54 + 33 + 33);
    expect(r.usage.outputTokens).toBe(80 + 46 + 44);
    expect(r.usage.latencyMs).toBe(1800 + 300 + 900);
  });

  it('is deterministic for a fixed ctx.seed', async () => {
    const a = await execute(STRATEGY, MESSAGES, makeCtx({ seed: 9 }));
    const b = await execute(STRATEGY, MESSAGES, makeCtx({ seed: 9 }));
    expect(a).toEqual(b);
  });

  it('throws when a kind has no route and no * fallback exists', async () => {
    await expect(
      execute(
        { type: 'decompose', decomposerModel: 'mock-frontier', routing: { analysis: 'mock-mid' } },
        MESSAGES,
        makeCtx({ seed: 9 }), // seed 9 yields a 'general' subtask
      ),
    ).rejects.toThrow(/no routing for subtask kind 'general'/);
  });

  it('honors fusion: judge-pick over subtask results', async () => {
    const r = await execute(
      {
        type: 'decompose',
        decomposerModel: 'mock-frontier',
        routing: { analysis: 'mock-mid', '*': 'mock-cheap' },
        fusion: { method: 'judge-pick', judge: { model: 'mock-judge' } },
      },
      MESSAGES,
      makeCtx({ seed: 9 }),
    );
    const fusion = r.trace.at(-1)!;
    expect(fusion.stage).toBe('fusion-judge');
    expect(fusion.decision).toMatch(/^judge-pick:[01]$/);
    const pick = Number(fusion.decision!.slice('judge-pick:'.length));
    expect(r.text).toBe(r.trace[1 + pick]!.text);
  });

  it('parseSubtasks tolerates markdown fences and surrounding prose', () => {
    const json = '[{"kind":"a","prompt":"p1"},{"kind":"b","prompt":"p2"}]';
    expect(parseSubtasks(json)).toEqual([
      { kind: 'a', prompt: 'p1' },
      { kind: 'b', prompt: 'p2' },
    ]);
    expect(parseSubtasks(`Here you go:\n\`\`\`json\n${json}\n\`\`\`\nDone.`)).toEqual([
      { kind: 'a', prompt: 'p1' },
      { kind: 'b', prompt: 'p2' },
    ]);
    expect(parseSubtasks(`prefix ${json} suffix`)).toEqual([
      { kind: 'a', prompt: 'p1' },
      { kind: 'b', prompt: 'p2' },
    ]);
    expect(() => parseSubtasks('no array here')).toThrow(/JSON array/);
    expect(() => parseSubtasks('[{"kind":"a"}]')).toThrow(/kind\/prompt/);
  });
});
