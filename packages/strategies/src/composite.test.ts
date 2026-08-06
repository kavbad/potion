// M3 #23 composite interpreter tests (SPEC §12.6): kept/upgraded paths,
// threshold boundary, calibrated-self-report fallback, streaming (kept =
// single coherent stream; upgraded = buffered prefix + seamless switch), and
// hand-computed per-stage cost totals to the cent.
//
// Determinism: the `[[mock-confidence:x]]` prompt marker (TEST/CI SIMULATION
// ONLY fixture knob, packages/providers/src/mock/eval-corpus.ts) pins the
// mock's logprobConfidence so the keep/upgrade decision is exact.
import { describe, expect, it } from 'vitest';
import { costUsd, roundCost, wrapUntrustedData } from '@potion/core';
import type { ChatMessage, PriceTable, Usage } from '@potion/core';
import { createMockProvider, type CompleteRequest, type Provider } from '@potion/providers';
import {
  COMPOSITE_STREAM_BUFFER_TOKENS,
  COMPOSITE_UPGRADE_NOTE,
  buildCompositeUpgradeMessages,
  createResolver,
  execute,
  streamChunks,
  type ExecContext,
} from './index.js';
import { buildSelfReportMessages, calibrateSelfReport } from './cascade.js';

// Priced mock table so cost totals are hand-computable to the cent.
const PRICES: PriceTable = {
  version: 'composite-test-v1',
  updatedAt: '2026-08-04',
  entries: [
    { alias: 'comp-cheap', provider: 'mock', model: 'comp-cheap-v1', inputPer1M: 2.0, outputPer1M: 10.0 },
    { alias: 'comp-frontier', provider: 'mock', model: 'comp-frontier-v1', inputPer1M: 4.0, outputPer1M: 20.0 },
  ],
};

const STRATEGY = {
  type: 'composite',
  startModel: 'comp-cheap',
  upgradeModel: 'comp-frontier',
  upgradeIf: { confidenceBelow: 0.6 },
} as const;

function messagesWithConfidence(c: number): ChatMessage[] {
  return [{ role: 'user', content: `Explain the result. [[mock-confidence:${c.toFixed(2)}]]` }];
}

/** The mock's token estimate (chars/4, ceil) — the hand-computation rule. */
const estTokens = (chars: number): number => Math.ceil(chars / 4);
const promptTextOf = (messages: ChatMessage[]): string =>
  messages.map((m) => `${m.role}:${m.content}`).join('\n');

function entryOf(alias: string) {
  return PRICES.entries.find((e) => e.alias === alias)!;
}

/** Hand-computed cost of one mock call: tokens from chars/4, priced via table. */
function handCost(alias: string, reqMessages: ChatMessage[], answerText: string): Usage {
  const entry = entryOf(alias);
  const inputTokens = estTokens(promptTextOf(reqMessages).length);
  const outputTokens = estTokens(answerText.length);
  return {
    inputTokens,
    outputTokens,
    costUsd: roundCost(costUsd({ inputTokens, outputTokens }, entry)),
    latencyMs: alias === 'comp-cheap' ? 300 : 1800,
  };
}

interface RecordedCall {
  model: string;
  messages: ChatMessage[];
}

function makeCtx(opts?: {
  stream?: (t: string) => void;
  stripLogprob?: boolean;
  record?: RecordedCall[];
}): ExecContext {
  const mock = createMockProvider(PRICES);
  const provider: Provider = {
    id: 'mock',
    complete: async (req: CompleteRequest) => {
      opts?.record?.push({ model: req.model, messages: req.messages });
      const res = await mock.complete(req);
      if (opts?.stripLogprob) {
        const { logprobConfidence: _drop, ...rest } = res;
        return rest;
      }
      return res;
    },
  };
  const providers = { anthropic: provider, openai: provider, google: provider, openrouter: provider, mock: provider };
  return {
    providers,
    prices: PRICES,
    resolve: createResolver(providers, PRICES),
    seed: 7,
    ...(opts?.stream ? { stream: opts.stream } : {}),
  };
}

describe('composite — non-stream (SPEC §12.6)', () => {
  it('kept path: high confidence → single stage, no upgrade cost', async () => {
    const msgs = messagesWithConfidence(0.95);
    const record: RecordedCall[] = [];
    const r = await execute(STRATEGY, msgs, makeCtx({ record }));

    expect(record).toHaveLength(1); // start only
    expect(r.text).toContain('[mock:comp-cheap]');
    expect(r.trace).toHaveLength(1);
    expect(r.trace[0]).toMatchObject({
      stage: 'composite-start',
      model: 'comp-cheap',
      confidence: 0.95,
      decision: 'kept',
    });

    // Cost = start call only, hand-computed to the cent.
    const start = handCost('comp-cheap', msgs, r.text);
    expect(r.usage.inputTokens).toBe(start.inputTokens);
    expect(r.usage.outputTokens).toBe(start.outputTokens);
    expect(r.usage.costUsd).toBe(start.costUsd);
    expect(r.usage.latencyMs).toBe(300);
  });

  it('upgraded path: low confidence → 2 stages, prefix in upgrade prompt, cost = both', async () => {
    const msgs = messagesWithConfidence(0.2);
    const record: RecordedCall[] = [];
    const r = await execute(STRATEGY, msgs, makeCtx({ record }));

    expect(record).toHaveLength(2);
    expect(r.trace).toHaveLength(2);
    expect(r.trace[0]).toMatchObject({
      stage: 'composite-start',
      model: 'comp-cheap',
      confidence: 0.2,
      decision: 'upgraded',
    });
    expect(r.trace[1]).toMatchObject({
      stage: 'composite-upgrade',
      model: 'comp-frontier',
      decision: 'upgraded',
    });
    // final = upgraded text
    expect(r.text).toContain('[mock:comp-frontier]');
    expect(r.text).toBe(r.trace[1]!.text);

    // Upgrade prompt: original messages + trailing system note with the FULL
    // start answer as context prefix (untrusted-data wrapped).
    const startText = r.trace[0]!.text;
    const upMsgs = record[1]!.messages;
    expect(upMsgs.slice(0, msgs.length)).toEqual(msgs);
    const note = upMsgs[upMsgs.length - 1]!;
    expect(note.role).toBe('system');
    expect(note.content.startsWith(COMPOSITE_UPGRADE_NOTE)).toBe(true);
    expect(note.content).toContain(wrapUntrustedData(startText));
    expect(upMsgs).toEqual(buildCompositeUpgradeMessages(msgs, startText));

    // Cost = start + upgrade, hand-computed to the cent.
    const start = handCost('comp-cheap', msgs, startText);
    const upgrade = handCost('comp-frontier', upMsgs, r.text);
    expect(r.usage.inputTokens).toBe(start.inputTokens + upgrade.inputTokens);
    expect(r.usage.outputTokens).toBe(start.outputTokens + upgrade.outputTokens);
    expect(r.usage.costUsd).toBe(roundCost(start.costUsd + upgrade.costUsd));
    expect(r.usage.latencyMs).toBe(300 + 1800);
  });

  it('threshold boundary: confidence == threshold → KEPT (strictly-below upgrades)', async () => {
    const msgs = messagesWithConfidence(0.6); // threshold is 0.6
    const record: RecordedCall[] = [];
    const r = await execute(STRATEGY, msgs, makeCtx({ record }));
    expect(record).toHaveLength(1);
    expect(r.trace).toHaveLength(1);
    expect(r.trace[0]).toMatchObject({ confidence: 0.6, decision: 'kept' });
  });

  it('self-report fallback: no logprob from provider → calibrated probe, recorded + costed', async () => {
    // Strip logprobConfidence → composite runs the SAME calibrated self-report
    // probe as cascade. Threshold 0.99: calibrated self-report max is
    // 0.85*0.99+0.07 = 0.9115 < 0.99 → always upgrades.
    const msgs: ChatMessage[] = [{ role: 'user', content: 'Explain the result.' }];
    const record: RecordedCall[] = [];
    const r = await execute(
      { ...STRATEGY, upgradeIf: { confidenceBelow: 0.99 } },
      msgs,
      makeCtx({ record, stripLogprob: true }),
    );

    expect(record).toHaveLength(3); // start + probe + upgrade
    expect(record[1]!.messages).toEqual(buildSelfReportMessages(msgs, r.trace[0]!.text));
    const probe = r.trace.find((t) => t.stage === 'composite-start-self-report');
    expect(probe).toBeDefined();
    expect(probe!.model).toBe('comp-cheap');
    expect(probe!.decision).toBe('self-report');
    const raw = probe!.confidence!;
    expect(r.trace[0]!.confidence).toBe(calibrateSelfReport(raw));
    expect(r.trace[0]!.decision).toBe('upgraded');

    // Cost includes the probe call, hand-computed.
    const start = handCost('comp-cheap', msgs, r.trace[0]!.text);
    const probeCost = handCost('comp-cheap', record[1]!.messages, probe!.text);
    const upgrade = handCost('comp-frontier', record[2]!.messages, r.text);
    expect(r.usage.costUsd).toBe(roundCost(start.costUsd + probeCost.costUsd + upgrade.costUsd));
    expect(r.usage.outputTokens).toBe(
      start.outputTokens + probeCost.outputTokens + upgrade.outputTokens,
    );
  });

  it('self-report fallback kept: calibrated confidence ≥ threshold → single stage + probe', async () => {
    // Threshold 0.4: calibrated self-report min is 0.85*0.5+0.07 = 0.495 > 0.4
    // → always kept (but the probe is still real spend).
    const msgs: ChatMessage[] = [{ role: 'user', content: 'Explain the result.' }];
    const record: RecordedCall[] = [];
    const r = await execute(
      { ...STRATEGY, upgradeIf: { confidenceBelow: 0.4 } },
      msgs,
      makeCtx({ record, stripLogprob: true }),
    );
    expect(record).toHaveLength(2); // start + probe, NO upgrade
    expect(r.trace.map((t) => t.stage)).toEqual(['composite-start', 'composite-start-self-report']);
    expect(r.trace[0]!.decision).toBe('kept');
    expect(r.text).toBe(r.trace[0]!.text);
  });
});

describe('composite — streaming (SPEC §12.6)', () => {
  it('stream kept: one coherent token stream, no restart, == final text', async () => {
    const msgs = messagesWithConfidence(0.95);
    const chunks: string[] = [];
    const r = await execute(STRATEGY, msgs, makeCtx({ stream: (t) => chunks.push(t) }));

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join('')).toBe(r.text);
    expect(r.text).toContain('[mock:comp-cheap]');
    expect(r.trace).toHaveLength(1);
    expect(r.trace[0]!.decision).toBe('kept');
    // Identical to the 'single' chunking of the start answer.
    expect(chunks).toEqual(streamChunks(r.trace[0]!.text));
  });

  it('stream upgraded: buffered prefix flushed, then seamless switch — coherent single stream', async () => {
    const msgs = messagesWithConfidence(0.2);
    const chunks: string[] = [];
    const record: RecordedCall[] = [];
    const r = await execute(STRATEGY, msgs, makeCtx({ stream: (t) => chunks.push(t), record }));

    expect(record).toHaveLength(2);
    expect(r.trace.map((t) => t.decision)).toEqual(['upgraded', 'upgraded']);

    const startText = r.trace[0]!.text;
    const startChunks = streamChunks(startText);
    const prefixChunks = startChunks.slice(0, COMPOSITE_STREAM_BUFFER_TOKENS);
    const prefix = prefixChunks.join('');

    // Client stream = buffered start prefix + upgrade continuation, coherent.
    expect(chunks.slice(0, prefixChunks.length)).toEqual(prefixChunks);
    expect(chunks.slice(prefixChunks.length)).toEqual(streamChunks(r.trace[1]!.text));
    expect(chunks.join('')).toBe(r.text);
    expect(r.text).toBe(prefix + r.trace[1]!.text);
    expect(r.text.startsWith(prefix)).toBe(true);

    // No meta-commentary leaks into the client stream.
    expect(chunks.join('')).not.toContain('cheaper model produced');
    expect(chunks.join('')).not.toContain(COMPOSITE_UPGRADE_NOTE);

    // Upgrade prompt carries the STREAMED prefix (not the full answer).
    const upMsgs = record[1]!.messages;
    expect(upMsgs).toEqual(buildCompositeUpgradeMessages(msgs, prefix));
    expect(upMsgs[upMsgs.length - 1]!.content).toContain(wrapUntrustedData(prefix));

    // Cost = start + upgrade (both fire), hand-computed to the cent.
    const start = handCost('comp-cheap', msgs, startText);
    const upgrade = handCost('comp-frontier', upMsgs, r.trace[1]!.text);
    expect(r.usage.costUsd).toBe(roundCost(start.costUsd + upgrade.costUsd));
    expect(r.usage.inputTokens).toBe(start.inputTokens + upgrade.inputTokens);
    expect(r.usage.outputTokens).toBe(start.outputTokens + upgrade.outputTokens);
  });
});
