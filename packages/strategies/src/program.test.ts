import { describe, expect, it } from 'vitest';
import type { ChatMessage, PriceTable, ProgramNode, StrategyConfig } from '@potion/core';
import { programCallCount, programModels, PROMPT_VARIANT_TEXT, strategyHash, StrategyConfigSchema } from '@potion/core';
import type { CompleteRequest, Provider } from '@potion/providers';
import { createProviders } from '@potion/providers';
import { createResolver } from './resolve.js';
import { strategyCapabilities } from './capabilities.js';
import { execute } from './execute.js';
import { confidenceGatedCascade, consensusOrEscalate, normalizeAnswer, verifiedCascade, MAX_PROGRAM_CALLS } from './program.js';
import type { ExecContext } from './types.js';

const PRICES: PriceTable = {
  version: 'p-test', updatedAt: '2026-08-22',
  entries: ['cheap-a', 'cheap-b', 'strong', 'judge', ...Array.from({ length: 9 }, (_, i) => `v${i}`)].map((alias) => ({ alias, provider: 'mock' as const, model: `${alias}-v1`, inputPer1M: 0, outputPer1M: 0 })),
};
const MESSAGES: ChatMessage[] = [{ role: 'user', content: 'What is the capital of France?' }];

/** A provider whose answer and confidence are scripted per model; counts calls. */
function scripted(
  script: Record<string, { text: string; confidence?: number }>,
  spy?: (req: CompleteRequest) => void,
) {
  const calls: string[] = [];
  const base = createProviders({ prices: PRICES }).mock;
  const provider: Provider = {
    id: 'mock',
    complete: async (req: CompleteRequest) => {
      calls.push(req.model);
      spy?.(req);
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
    // The judge speaks the repo's judge protocol: a LAST line-anchored
    // `PICK: <index>`, zero-based, parsed by parsePick (M2-security). Prose
    // around it is ignored, and an unparseable reply falls to index 0.
    const judged = scripted({ 'cheap-a': { text: 'Paris' }, 'cheap-b': { text: 'Lyon' }, judge: { text: 'Reasoning about both.\nPICK: 1' } });
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


// A vote or an agree that compares WHOLE answers is decided by prose style, not
// by the answer: three models reasoning step by step never produce identical
// text, so every bucket holds one vote and the majority rule never fires.
// Agreement is judged on the answer the reply LANDS ON when it declares one.
describe('consensus is judged on the answer, not the prose around it', () => {
  const REASONED_540 = 'Step 1: 3 sprints x 3 days = 9.\nStep 2: 9 x 60 = 540 meters.\n\nFinal answer: 540';
  const TERSE_540 = 'He runs 9 sprints a week.\nFinal answer: 540';
  const WRONG_180 = 'Three sprints of 60 metres is 180.\n\nFinal answer: 180';

  it('agree: two models that reason differently and land on the same number DO agree', async () => {
    const { ctx, calls } = scripted({
      'cheap-a': { text: REASONED_540, confidence: 0.6 },
      'cheap-b': { text: TERSE_540, confidence: 0.8 },
      strong: { text: 'Final answer: 540' },
    });
    const cfg: StrategyConfig = { type: 'program', name: 'coe', body: consensusOrEscalate('coe', 'cheap-a', 'cheap-b', 'strong') };
    const r = await execute(cfg, MESSAGES, ctx);
    expect(calls.sort()).toEqual(['cheap-a', 'cheap-b']); // the strong model is never reached
    expect(r.text).toBe(TERSE_540); // cheap-b, the more confident of the two that agreed
  });

  it('agree: landing on different numbers still escalates', async () => {
    const { ctx, calls } = scripted({
      'cheap-a': { text: REASONED_540, confidence: 0.6 },
      'cheap-b': { text: WRONG_180, confidence: 0.8 },
      strong: { text: 'Final answer: 540' },
    });
    const cfg: StrategyConfig = { type: 'program', name: 'coe', body: consensusOrEscalate('coe', 'cheap-a', 'cheap-b', 'strong') };
    const r = await execute(cfg, MESSAGES, ctx);
    expect(calls.sort()).toEqual(['cheap-a', 'cheap-b', 'strong']);
    expect(r.text).toBe('Final answer: 540');
  });

  it('agree: the same number written differently is the same answer', async () => {
    const { ctx } = scripted({
      'cheap-a': { text: 'Adding it up.\nFinal answer: 1,234', confidence: 0.6 },
      'cheap-b': { text: 'The total.\n**Final answer: 1234**', confidence: 0.8 },
      strong: { text: 'escalated' },
    });
    const cfg: StrategyConfig = { type: 'program', name: 'coe', body: consensusOrEscalate('coe', 'cheap-a', 'cheap-b', 'strong') };
    expect((await execute(cfg, MESSAGES, ctx)).text).not.toBe('escalated');
  });

  it('vote: the majority answer wins even though all three replies read differently', async () => {
    const { ctx } = scripted({
      'cheap-a': { text: REASONED_540 },
      'cheap-b': { text: WRONG_180 },
      strong: { text: TERSE_540 },
    });
    const vote: StrategyConfig = { type: 'program', name: 'v', body: { op: 'vote', of: [{ op: 'call', model: 'cheap-b' }, { op: 'call', model: 'cheap-a' }, { op: 'call', model: 'strong' }] } };
    expect((await execute(vote, MESSAGES, ctx)).text).toBe(REASONED_540); // first reply of the winning bucket, not the first branch
  });

  it('answers that declare no final answer keep comparing on the whole text', async () => {
    const { ctx, calls } = scripted({
      'cheap-a': { text: 'function add(a, b) { return a + b; } // 2 args', confidence: 0.6 },
      'cheap-b': { text: 'const add = (a, b) => a - b; // 2 args', confidence: 0.8 },
      strong: { text: 'escalated' },
    });
    const cfg: StrategyConfig = { type: 'program', name: 'coe', body: consensusOrEscalate('coe', 'cheap-a', 'cheap-b', 'strong') };
    const r = await execute(cfg, MESSAGES, ctx);
    expect(calls.sort()).toEqual(['cheap-a', 'cheap-b', 'strong']); // different code is not agreement
    expect(r.text).toBe('escalated');
  });
});
});

// ---- THE SERIALIZATION LAW (compiler IR rung 1) ----
//
// A program is DATA. The moment it can be persisted and parsed — which is
// what putting `program` in StrategyConfigSchema buys — every program that
// serves has been through JSON. Memoizing on object IDENTITY made the
// in-process tree and its own round-trip two different mechanisms: the
// shared node in `verifiedCascade` (the check's subject IS the `then`
// branch) is one object when built and two after a parse, so the cheap
// model got called twice, the receipt showed a stage that never happened,
// and the static bound over-counted what the run would pay.
describe('program serialization — a parsed program is the same mechanism', () => {
  const roundTrip = (n: ProgramNode): ProgramNode => JSON.parse(JSON.stringify(n)) as ProgramNode;

  it('a round-tripped consensus-or-escalate still pays exactly two calls', async () => {
    const { ctx, calls } = scripted({ 'cheap-a': { text: 'Paris.', confidence: 0.7 }, 'cheap-b': { text: 'paris', confidence: 0.9 }, strong: { text: 'Paris' } });
    const cfg: StrategyConfig = { type: 'program', name: 'coe', body: roundTrip(consensusOrEscalate('coe', 'cheap-a', 'cheap-b', 'strong')) };
    const r = await execute(cfg, MESSAGES, ctx);
    expect(r.text).toBe('paris');
    expect(calls.sort()).toEqual(['cheap-a', 'cheap-b']);
    expect(r.trace).toHaveLength(2);
  });

  it('a round-tripped verified cascade calls the cheap model once, not once per reference', async () => {
    const { ctx, calls } = scripted({ 'cheap-a': { text: '{"order":"A1","issue":"late","urgency":"high"}' }, strong: { text: 'strong' } });
    const cfg: StrategyConfig = { type: 'program', name: 'vc', body: roundTrip(verifiedCascade('cheap-a', 'strong', { kind: 'json', requiredKeys: ['order'] })) };
    const r = await execute(cfg, MESSAGES, ctx);
    expect(calls).toEqual(['cheap-a']); // the check passed; `then` is the SAME call
    expect(r.trace).toHaveLength(1);
  });

  it('a program arrives from the WIRE and runs — schema, then interpreter', async () => {
    // The whole point of rung 1: this JSON could have come from /v1/jobs, a
    // synthesizer, or a strategy_configs row. Before the schema member it was
    // refused at the door and the interpreter was reachable only from tests.
    const wire = JSON.parse(
      JSON.stringify({
        type: 'program',
        name: 'verified-cascade',
        body: {
          op: 'if',
          check: { kind: 'json', of: { op: 'call', model: 'cheap-a' }, requiredKeys: ['order'] },
          then: { op: 'call', model: 'cheap-a' },
          else: { op: 'call', model: 'strong' },
        },
      }),
    ) as unknown;
    const cfg = StrategyConfigSchema.parse(wire) as StrategyConfig;
    expect(cfg.type).toBe('program');
    const { ctx, calls } = scripted({ 'cheap-a': { text: '{"order":"A1"}' }, strong: { text: 'strong' } });
    const r = await execute(cfg, MESSAGES, ctx);
    expect(r.text).toBe('{"order":"A1"}');
    expect(calls).toEqual(['cheap-a']);
    expect(strategyHash(cfg)).toBe(strategyHash(wire)); // the receipt names it
  });

  it('the static call bound survives serialization', () => {
    const vc = verifiedCascade('cheap-a', 'strong', { kind: 'json' });
    expect(programCallCount(vc)).toBe(2);
    expect(programCallCount(roundTrip(vc))).toBe(2);
    const coe = consensusOrEscalate('coe', 'cheap-a', 'cheap-b', 'strong');
    expect(programCallCount(coe)).toBe(3);
    expect(programCallCount(roundTrip(coe))).toBe(3);
  });
});

// ---- C4: reasoning effort as an IR instruction ----
//
// The point of putting effort on the call node rather than beside it: the
// memo keys on node STRUCTURE, so `call(m, low)` and `call(m, high)` are two
// different calls of one model — which is exactly the mechanism the template
// shelf cannot express. `CascadeStage` is `{model, escalateIf}`, so a cascade
// can escalate from one model to another and never from one effort to another.
describe('reasoning effort in the compiler IR', () => {
  const EFFORT_CASCADE: ProgramNode = {
    op: 'if',
    check: { kind: 'confidence', of: { op: 'call', model: 'cheap-a', reasoningEffort: 'low' }, min: 0.95 },
    then: { op: 'call', model: 'cheap-a', reasoningEffort: 'low' },
    else: { op: 'call', model: 'cheap-a', reasoningEffort: 'high' },
  };

  it('two efforts of ONE model are two calls, and the bound says so', () => {
    expect(programCallCount(EFFORT_CASCADE)).toBe(2);
    // …while the same tree without efforts collapses to one, as it should.
    const flat: ProgramNode = {
      op: 'if',
      check: { kind: 'confidence', of: { op: 'call', model: 'cheap-a' }, min: 0.95 },
      then: { op: 'call', model: 'cheap-a' },
      else: { op: 'call', model: 'cheap-a' },
    };
    expect(programCallCount(flat)).toBe(1);
    expect(programModels(EFFORT_CASCADE)).toEqual(['cheap-a']); // one model, two operating points
  });

  it('escalates from low effort to high on the SAME model, and the receipt names both', async () => {
    const { ctx, calls } = scripted({ 'cheap-a': { text: 'an answer', confidence: 0.6 } });
    const cfg: StrategyConfig = { type: 'program', name: 'effort-gate', body: EFFORT_CASCADE };
    const r = await execute(cfg, MESSAGES, ctx);
    expect(calls).toEqual(['cheap-a', 'cheap-a']); // the same model, twice, deliberately
    expect(r.trace.map((t) => t.stage)).toEqual([
      'program:effort-gate:call:low',
      'program:effort-gate:call:high',
    ]);
  });

  it('the schema carries effort, and rejects one it does not know', () => {
    const ok: StrategyConfig = { type: 'program', name: 'e', body: EFFORT_CASCADE };
    expect(StrategyConfigSchema.parse(JSON.parse(JSON.stringify(ok)))).toBeTruthy();
    expect(() =>
      StrategyConfigSchema.parse({ type: 'program', name: 'e', body: { op: 'call', model: 'm', reasoningEffort: 'maximum' } }),
    ).toThrow();
  });

  it('a call that names no effort sends none — existing programs are untouched', async () => {
    const seen: (string | undefined)[] = [];
    const { ctx } = scripted({}, (req) => seen.push(req.params?.reasoningEffort));
    await execute({ type: 'program', name: 'plain', body: { op: 'call', model: 'cheap-a' } }, MESSAGES, ctx);
    expect(seen).toEqual([undefined]);
  });
});

// ---- C4 rung 2: prompt variants reach the wire ----
describe('prompt variants in the compiler IR', () => {
  it('the instruction is sent as an extra system turn, and the caller turns are untouched', async () => {
    const seen: ChatMessage[][] = [];
    const { ctx } = scripted({}, (req) => seen.push(req.messages));
    const cfg: StrategyConfig = {
      type: 'program', name: 'v',
      body: { op: 'call', model: 'cheap-a', promptVariant: 'json-only' },
    };
    await execute(cfg, MESSAGES, ctx);
    expect(seen[0]!.slice(0, MESSAGES.length)).toEqual(MESSAGES);
    expect(seen[0]!.at(-1)).toEqual({ role: 'system', content: PROMPT_VARIANT_TEXT['json-only'] });
  });

  it('instruct-and-verify: ask for JSON, check it, escalate — one model, two ways', async () => {
    const { ctx, calls } = scripted({ 'cheap-a': { text: 'sorry, no JSON here' }, strong: { text: '{"order":"A1"}' } });
    const asked: ProgramNode = { op: 'call', model: 'cheap-a', promptVariant: 'json-only' };
    const cfg: StrategyConfig = {
      type: 'program', name: 'instruct-and-verify',
      body: { op: 'if', check: { kind: 'json', of: asked }, then: asked, else: { op: 'call', model: 'strong' } },
    };
    const r = await execute(cfg, MESSAGES, ctx);
    expect(calls).toEqual(['cheap-a', 'strong']); // the instruction did not save it; the gate caught that
    expect(r.trace.map((t) => t.stage)).toEqual([
      'program:instruct-and-verify:call:json-only',
      'program:instruct-and-verify:call',
    ]);
  });

  it('a call naming no variant sends no instruction — existing programs untouched', async () => {
    const seen: ChatMessage[][] = [];
    const { ctx } = scripted({}, (req) => seen.push(req.messages));
    await execute({ type: 'program', name: 'plain', body: { op: 'call', model: 'cheap-a' } }, MESSAGES, ctx);
    expect(seen[0]).toEqual(MESSAGES);
  });
});

// ---- C4b: tools as program operations ----
//
// WHAT POTION CANNOT DO, stated first. The review's chain is
// `model A → tool X → validator → model B → tool Y → verifier`, and the tool
// steps are not buildable here: over chat-completions a tool call ENDS the
// turn and goes back to the caller, who runs the tool. Potion never executes
// one. The validator steps already exist — a json/regex check IS the
// deterministic validator, and `verified-cascade` IS `A → validate → B`.
//
// What was actually wrong: the interpreter had no idea tools existed. It never
// forwarded ctx.params.tools, so a program evaluated on a tool-bearing item
// (runner.ts sets exactly that for `item.tools`) was never offered the tools,
// answered in prose, and scored zero under `tool-call` scoring — a systematic
// mis-measurement that says nothing about the mechanism. And a tool call that
// did come back would have been gated on as if it were an answer.
describe('tools in the compiler IR (C4b)', () => {
  const TOOLS = [
    { type: 'function' as const, function: { name: 'get_weather', description: 'w', parameters: { type: 'object', properties: {} } } },
  ];
  /** A provider that returns a tool call for `cheap-a`, prose for everything else. */
  function toolWorld() {
    const calls: string[] = [];
    const seen: unknown[] = [];
    const base = createProviders({ prices: PRICES }).mock;
    const provider: Provider = {
      id: 'mock',
      complete: async (req: CompleteRequest) => {
        calls.push(req.model);
        seen.push(req.params?.tools);
        const r = await base.complete(req);
        const { toolCalls: _echo, ...rest } = r;
        if (req.model === 'cheap-a') {
          return { ...rest, text: '', toolCalls: [{ id: 't1', type: 'function' as const, function: { name: 'get_weather', arguments: '{}' } }] };
        }
        return { ...rest, text: 'prose answer' };
      },
    };
    const providers = { ...createProviders({ prices: PRICES }), mock: provider };
    const ctx: ExecContext = {
      providers, prices: PRICES, resolve: createResolver(providers, PRICES), seed: 1,
      captureConfidence: true, params: { tools: TOOLS },
    };
    return { ctx, calls, seen };
  }

  it('forwards the tools it was given — a program that hides them measures nothing', async () => {
    const { ctx, seen } = toolWorld();
    await execute({ type: 'program', name: 'p', body: { op: 'call', model: 'strong' } }, MESSAGES, ctx);
    expect(seen[0]).toEqual(TOOLS);
  });

  it('a tool call is TERMINAL — it is a decision, not an answer to judge', async () => {
    const { ctx, calls } = toolWorld();
    const cfg: StrategyConfig = {
      type: 'program', name: 'vc',
      body: {
        op: 'if',
        check: { kind: 'json', of: { op: 'call', model: 'cheap-a' } },
        then: { op: 'call', model: 'cheap-a' },
        else: { op: 'call', model: 'strong' },
      },
    };
    const r = await execute(cfg, MESSAGES, ctx);
    // The gate never runs: empty text would have failed the json check and
    // escalated, burning a second call and returning prose where the caller
    // asked for a tool.
    expect(calls).toEqual(['cheap-a']);
    expect(r.toolCalls).toHaveLength(1);
    expect(r.toolCalls![0]!.function.name).toBe('get_weather');
    expect(r.text).toBe('');
  });

  it('a tool call inside a vote wins outright — there is nothing to take a majority of', async () => {
    const { ctx } = toolWorld();
    const cfg: StrategyConfig = {
      type: 'program', name: 'v',
      body: { op: 'vote', of: [{ op: 'call', model: 'strong' }, { op: 'call', model: 'cheap-a' }, { op: 'call', model: 'cheap-b' }] },
    };
    const r = await execute(cfg, MESSAGES, ctx);
    expect(r.toolCalls).toHaveLength(1);
  });

  it('a bare call CAN carry tools; anything that reads the answer cannot', () => {
    expect(strategyCapabilities({ type: 'program', name: 'p', body: { op: 'call', model: 'm' } }).canServeTools).toBe(true);
    // …including one that carries C4 parameters — that is the point: agent
    // traffic gets the effort and variant axes without giving up tools.
    expect(
      strategyCapabilities({ type: 'program', name: 'p', body: { op: 'call', model: 'm', reasoningEffort: 'high' } }).canServeTools,
    ).toBe(true);
    for (const body of [
      { op: 'if' as const, check: { kind: 'json' as const, of: { op: 'call' as const, model: 'm' } }, then: { op: 'call' as const, model: 'm' }, else: { op: 'call' as const, model: 'n' } },
      { op: 'vote' as const, of: [{ op: 'call' as const, model: 'a' }, { op: 'call' as const, model: 'b' }, { op: 'call' as const, model: 'c' }] },
      { op: 'pick' as const, of: [{ op: 'call' as const, model: 'a' }, { op: 'call' as const, model: 'b' }], by: { kind: 'confidence' as const } },
    ]) {
      expect(strategyCapabilities({ type: 'program', name: 'p', body }).canServeTools).toBe(false);
    }
  });
});

// ---- C4 rung 4: tool selection ----
describe('tool selection in the compiler IR', () => {
  const tool = (name: string, description: string) => ({
    type: 'function' as const,
    function: { name, description, parameters: { type: 'object', properties: {} } },
  });
  // The relevant tools are deliberately LAST. Keeping the first k by index
  // would pass a laxer assertion by accident, so the fixture makes relevance
  // the only way through — a lesson from watching the ranking mutation
  // survive an earlier ordering of this list.
  const CATALOGUE = [
    tool('get_weather', 'Look up the forecast for a city'),
    tool('book_table', 'Reserve a table at a restaurant'),
    tool('list_menu', 'Show todays menu items'),
    tool('track_parcel', 'Find where a delivery has got to'),
    tool('cancel_order', 'Cancel an order that has not shipped'),
    tool('refund_order', 'Issue a refund against an order id'),
  ];

  function toolWorld(answerWithTool: boolean) {
    const offered: number[] = [];
    const names: string[][] = [];
    const base = createProviders({ prices: PRICES }).mock;
    const provider: Provider = {
      id: 'mock',
      complete: async (req: CompleteRequest) => {
        offered.push(req.params?.tools?.length ?? 0);
        names.push((req.params?.tools ?? []).map((t) => t.function.name));
        const r = await base.complete(req);
        // cheap-a answers in prose (its trimmed catalogue lacked the tool);
        // strong makes the call when it sees the full catalogue.
        const makesCall = answerWithTool ? req.model === 'strong' : true;
        // The mock has its own tool-echo fixture for tool-bearing requests, so
        // a prose answer must CLEAR toolCalls rather than merely set text —
        // spreading over it leaves the echo behind and the gate sees a call
        // that this fixture never meant to make.
        const { toolCalls: _echo, ...rest } = r;
        return makesCall
          ? { ...rest, text: '', toolCalls: [{ id: 't1', type: 'function' as const, function: { name: 'refund_order', arguments: '{}' } }] }
          : { ...rest, text: 'I cannot do that with the tools I have.' };
      },
    };
    const providers = { ...createProviders({ prices: PRICES }), mock: provider };
    const ctx: ExecContext = {
      providers, prices: PRICES, resolve: createResolver(providers, PRICES), seed: 1,
      captureConfidence: true, params: { tools: CATALOGUE },
    };
    return { ctx, offered, names };
  }

  const REFUND: ChatMessage[] = [{ role: 'user', content: 'Please refund order A-119, it never shipped.' }];

  it('offers the k most relevant tools, in the caller order', async () => {
    const { ctx, offered, names } = toolWorld(false);
    await execute(
      { type: 'program', name: 't', body: { op: 'call', model: 'cheap-a', toolSelect: { keepTools: 2 } } },
      REFUND, ctx,
    );
    expect(offered[0]).toBe(2);
    // refund_order is the LAST tool in the catalogue: only ranking finds it.
    expect(names[0]).toContain('refund_order');
    expect(names[0]).not.toContain('get_weather');
    expect(names[0]).not.toContain('list_menu');
    // caller order preserved among the survivors
    expect(names[0]).toEqual([...names[0]!].sort((a, b) =>
      CATALOGUE.findIndex((t) => t.function.name === a) - CATALOGUE.findIndex((t) => t.function.name === b)));
  });

  it('select-tools-or-retry: no tool call on the trimmed set falls back to the whole catalogue', async () => {
    const { ctx, offered } = toolWorld(true);
    const trimmed: ProgramNode = { op: 'call', model: 'cheap-a', toolSelect: { keepTools: 2 } };
    const cfg: StrategyConfig = {
      type: 'program', name: 'select-tools-or-retry',
      body: { op: 'if', check: { kind: 'tool-called', of: trimmed }, then: trimmed, else: { op: 'call', model: 'strong' } },
    };
    const r = await execute(cfg, REFUND, ctx);
    expect(offered).toEqual([2, 6]); // trimmed first, then everything
    expect(r.toolCalls).toHaveLength(1); // the retry got there
  });

  it('a tool call on the trimmed set is kept — no second call, and it is not judged', async () => {
    const { ctx, offered } = toolWorld(false);
    const trimmed: ProgramNode = { op: 'call', model: 'cheap-a', toolSelect: { keepTools: 2 } };
    const cfg: StrategyConfig = {
      type: 'program', name: 'select-tools-or-retry',
      body: { op: 'if', check: { kind: 'tool-called', of: trimmed }, then: trimmed, else: { op: 'call', model: 'strong' } },
    };
    const r = await execute(cfg, REFUND, ctx);
    expect(offered).toEqual([2]); // memoized: the checked node IS the branch
    expect(r.toolCalls).toHaveLength(1);
  });

  it('that shape CAN serve tools; a text-gated one still cannot', () => {
    const trimmed: ProgramNode = { op: 'call', model: 'm', toolSelect: { keepTools: 2 } };
    expect(strategyCapabilities({
      type: 'program', name: 'p',
      body: { op: 'if', check: { kind: 'tool-called', of: trimmed }, then: trimmed, else: { op: 'call', model: 'n' } },
    }).canServeTools).toBe(true);
    expect(strategyCapabilities({
      type: 'program', name: 'p',
      body: { op: 'if', check: { kind: 'json', of: trimmed }, then: trimmed, else: { op: 'call', model: 'n' } },
    }).canServeTools).toBe(false);
  });
});
