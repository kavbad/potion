// P3 — the beat working set's laws:
//   · validation refuses garbage with reasons, never crashes;
//   · applyBeat is a pure, deterministic merge — dedup answered, history
//     kept, caps evicting oldest-first with a total order;
//   · the loop carries `remember` ONLY for beat-bearing standing specs
//     (non-beat prompts stay byte-identical — replay compatibility);
//   · across two checks the second run's context carries the ledger and
//     the dedup hit shows in the recorded trace (the demo that can't lie).
import { describe, expect, it } from 'vitest';
import { createDb, createLabRun, getLabMemory, listLabSteps, migrate, seedIsolationOrgs, ORG_A } from '@potion/db';
import { harnessSpecHash, type HarnessSpec } from '@potion/lab-spec';
import { runLeg, systemPrompt } from './loop.js';
import type { ServingClientLike, ServingRequest, ServingResult } from './serving-client.js';
import { applyBeat, beatFromMemory, emptyBeat, renderBeatLedger, validateBeat, BEAT_LIMITS } from './beat.js';

const ORG = ORG_A;

function spec(over: Partial<HarnessSpec> = {}): HarnessSpec {
  return {
    specVersion: 1,
    name: 'beat test harness',
    brain: { policy: { type: 'min_cost', qualityFloor: 0 } },
    mission: { kind: 'standing', goal: 'watch the feeds' },
    superpowers: [],
    memory: { enabled: true, beat: true },
    rules: [],
    fuel: { maxUsdPerRun: 1, hardStop: true },
    checkIns: [],
    ...over,
  };
}

function scripted(results: ServingResult[]): ServingClientLike & { calls: ServingRequest[] } {
  const queue = [...results];
  const calls: ServingRequest[] = [];
  // A plain object, checked against the real signatures: runLeg takes
  // ServingClientLike, so a double no longer has to be a real client
  // pointed at an unroutable host.
  const client: ServingClientLike & { calls: ServingRequest[] } = {
    calls,
    complete: async (req: ServingRequest) => {
      calls.push(req);
      const next = queue.shift();
      if (!next) throw new Error('scripted client exhausted');
      return next;
    },
    emitSpans: async () => true,
  };
  return client;
}

function ok(over: Partial<Extract<ServingResult, { kind: 'ok' }>> = {}): ServingResult {
  return {
    kind: 'ok',
    completionId: `chatcmpl-${Math.random().toString(36).slice(2, 10)}`,
    text: 'done.',
    toolCalls: [],
    finishReason: 'stop',
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    frontierTrace: 'cluster=code-gen;strategy=test;frontier=v1;policy=min_cost;fallback=0;provenance=mock',
    ...over,
  };
}

describe('validateBeat', () => {
  it('refuses an empty call and garbage shapes with reasons', () => {
    expect(validateBeat({})).toEqual({ ok: false, reason: expect.stringContaining('nothing to remember') });
    expect((validateBeat({ seen: 'x' }) as { ok: false; reason: string }).reason).toContain('array');
    expect((validateBeat({ sources: [{ name: 'hn', outcome: 'meh' }] }) as { ok: false; reason: string }).reason).toContain('items|dry|failed');
    expect((validateBeat({ entities: [{}] }) as { ok: false; reason: string }).reason).toContain('name');
  });
  it('cleans control characters and caps lengths', () => {
    const v = validateBeat({ entities: [{ name: 'North\u0000wind', claim: 'x'.repeat(1000) }] });
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.input.entities[0]!.name).toBe('North wind');
      expect(v.input.entities[0]!.claim!.length).toBe(BEAT_LIMITS.MAX_CLAIM_CHARS);
    }
  });
});

describe('applyBeat — pure, deterministic, history-keeping', () => {
  it('answers the dedup hit with the day each key was first seen', () => {
    const day1 = applyBeat(emptyBeat(), { entities: [], sources: [], seen: ['story-a', 'story-b'] }, '2026-08-27');
    expect(day1.duplicates).toEqual([]);
    const day2 = applyBeat(day1.next, { entities: [], sources: [], seen: ['story-b', 'story-c'] }, '2026-08-28');
    expect(day2.duplicates).toEqual([{ key: 'story-b', firstSeen: '2026-08-27' }]);
    expect(day2.newKeys).toEqual(['story-c']);
  });

  it('entities keep a claims HISTORY — first seen survives, last seen moves', () => {
    const a = applyBeat(emptyBeat(), { seen: [], sources: [], entities: [{ name: 'Northwind', claim: 'raised a round' }] }, '2026-08-01');
    const b = applyBeat(a.next, { seen: [], sources: [], entities: [{ name: 'Northwind', claim: 'shipped v2' }] }, '2026-08-28');
    const e = b.next.entities['Northwind']!;
    expect(e.first).toBe('2026-08-01');
    expect(e.last).toBe('2026-08-28');
    expect(e.claims.map((c) => c.text)).toEqual(['raised a round', 'shipped v2']);
  });

  it('sources track yield, dry streaks and failures', () => {
    let s = applyBeat(emptyBeat(), { seen: [], entities: [], sources: [{ name: 'hn', outcome: 'items', items: 3 }] }, '2026-08-26').next;
    s = applyBeat(s, { seen: [], entities: [], sources: [{ name: 'hn', outcome: 'dry' }] }, '2026-08-27').next;
    s = applyBeat(s, { seen: [], entities: [], sources: [{ name: 'hn', outcome: 'failed' }] }, '2026-08-28').next;
    expect(s.sources['hn']).toEqual({ checks: 3, items: 3, lastOn: '2026-08-28', dryStreak: 2, failures: 1 });
  });

  it('seen cap evicts oldest-first, deterministically', () => {
    let state = emptyBeat();
    for (let i = 0; i < BEAT_LIMITS.MAX_SEEN; i += BEAT_LIMITS.MAX_BATCH) {
      const keys = Array.from({ length: BEAT_LIMITS.MAX_BATCH }, (_, j) => `k${String(i + j).padStart(4, '0')}`);
      state = applyBeat(state, { seen: keys, entities: [], sources: [] }, `2026-07-${String((i % 28) + 1).padStart(2, '0')}`).next;
    }
    const over = applyBeat(state, { seen: ['brand-new'], entities: [], sources: [] }, '2026-08-28');
    expect(Object.keys(over.next.seen).length).toBe(BEAT_LIMITS.MAX_SEEN);
    expect(over.next.seen['brand-new']).toBe('2026-08-28');
  });

  it('reflections keep the last N', () => {
    let state = emptyBeat();
    for (let i = 0; i < BEAT_LIMITS.MAX_REFLECTIONS + 4; i++) {
      state = applyBeat(state, { seen: [], entities: [], sources: [], reflection: `note ${i}` }, '2026-08-28').next;
    }
    expect(state.reflections.length).toBe(BEAT_LIMITS.MAX_REFLECTIONS);
    expect(state.reflections[state.reflections.length - 1]!.note).toBe(`note ${BEAT_LIMITS.MAX_REFLECTIONS + 3}`);
  });
});

describe('the prompt', () => {
  it('a beat-less spec renders byte-identically to the pre-P3 prompt (replay law)', () => {
    const plain = spec({ memory: { enabled: true }, mission: { kind: 'task', goal: 'g', doneDefinition: 'd' } });
    const prompt = systemPrompt(plain, { note: 'x' }, []);
    expect(prompt).toContain('Memory:\n{"note":"x"}');
    expect(prompt).not.toContain('working set');
    expect(prompt).not.toContain('remember');
  });
  it('a beat-bearing spec renders the ledger readably and carries the law', () => {
    const applied = applyBeat(
      emptyBeat(),
      {
        seen: ['story-a'],
        entities: [{ name: 'Northwind', claim: 'raised a round' }],
        sources: [{ name: 'hn', outcome: 'items', items: 2 }],
        reflection: 'hn was rich today',
      },
      '2026-08-28',
    );
    const memory = {
      'beat:entities': applied.next.entities,
      'beat:seen': applied.next.seen,
      'beat:sources': applied.next.sources,
      'beat:reflections': applied.next.reflections,
      blobKey: 'still here',
    };
    const prompt = systemPrompt(spec(), memory, []);
    expect(prompt).toContain('Your working set (durable across checks):');
    expect(prompt).toContain('Northwind (first 2026-08-28, last 2026-08-28, 1 claim) — latest: raised a round');
    expect(prompt).toContain('hn: 2 items over 1 check');
    expect(prompt).toContain('Already reported: 1 item on file');
    expect(prompt).toContain('[2026-08-28] hn was rich today');
    expect(prompt).toContain('BEFORE reporting items');
    // Non-beat keys still ride as the classic blob.
    expect(prompt).toContain('Memory:\n{"blobKey":"still here"}');
  });
  it('mangled beat rows degrade to empty, never crash', () => {
    expect(renderBeatLedger({ 'beat:entities': 'garbage', 'beat:seen': [1, 2], 'beat:sources': null })).toBe('');
    expect(beatFromMemory({ 'beat:reflections': [{ on: 3, note: 'x' }] }).reflections).toEqual([]);
  });
});

describe('across two checks — the demo that cannot lie', () => {
  it('check 2 sees check 1\'s working set; the dedup hit is in the recorded trace', async () => {
    const h = await createDb();
    await migrate(h.db);
    await seedIsolationOrgs(h.db);
    const s = spec();
    const hash = harnessSpecHash(s);

    // ---- check 1: reports story-a, files the working set ----
    await createLabRun(h.db, { id: 'run-beat-1', orgId: ORG, harnessHash: hash, harnessName: s.name, spec: s });
    const c1 = scripted([
      ok({
        text: '',
        finishReason: 'tool_calls',
        toolCalls: [{ id: 'b1', type: 'function', function: { name: 'remember', arguments: JSON.stringify({ seen: ['story-a'], entities: [{ name: 'Northwind', claim: 'raised a round' }], sources: [{ name: 'hn', outcome: 'items', items: 1 }], reflection: 'one fresh story' }) } }],
      }),
      ok({ text: 'Reported story-a.' }),
      ok({ text: 'Wrap-up: check complete.' }),
    ]);
    const o1 = await runLeg({ db: h.db, client: c1, runId: 'run-beat-1', orgId: ORG, spec: s, harnessHash: hash });
    expect(o1.status).toBe('completed');
    const memory = await getLabMemory(h.db, ORG, hash);
    expect(beatFromMemory(memory).seen['story-a']).toBeDefined();

    // ---- check 2: same story appears again — the tool answers the dup ----
    await createLabRun(h.db, { id: 'run-beat-2', orgId: ORG, harnessHash: hash, harnessName: s.name, spec: s });
    const c2 = scripted([
      ok({
        text: '',
        finishReason: 'tool_calls',
        toolCalls: [{ id: 'b2', type: 'function', function: { name: 'remember', arguments: JSON.stringify({ seen: ['story-a', 'story-b'], sources: [{ name: 'hn', outcome: 'items', items: 1 }] }) } }],
      }),
      ok({ text: 'story-a already reported — only story-b is news.' }),
      ok({ text: 'Wrap-up: check complete.' }),
    ]);
    const o2 = await runLeg({ db: h.db, client: c2, runId: 'run-beat-2', orgId: ORG, spec: s, harnessHash: hash });
    expect(o2.status).toBe('completed');

    // Check 2's SYSTEM PROMPT carried check 1's working set.
    const sys = (c2.calls[0]!.messages[0] as { content: string }).content;
    expect(sys).toContain('Your working set (durable across checks)');
    expect(sys).toContain('Northwind');
    expect(sys).toContain('one fresh story');

    // The dedup hit is IN THE RECORD — the tool step's recorded output
    // names story-a and the day it was first seen.
    const steps = await listLabSteps(h.db, 'run-beat-2', ORG);
    const toolStep = steps.find((x) => x.kind === 'tool');
    const out = (toolStep!.payload as { toolOutput?: { duplicates?: Array<{ key: string }> } }).toolOutput;
    expect(out?.duplicates?.map((d) => d.key)).toEqual(['story-a']);

    // And the projected memory holds BOTH stories now.
    const after = beatFromMemory(await getLabMemory(h.db, ORG, hash));
    expect(Object.keys(after.seen).sort()).toEqual(['story-a', 'story-b']);
    expect(after.sources['hn']!.checks).toBe(2);
    await h.close();
  }, 60_000);

  it('a task run (beat-less) never carries the remember tool', async () => {
    const h = await createDb();
    await migrate(h.db);
    await seedIsolationOrgs(h.db);
    const s = spec({ memory: { enabled: true }, mission: { kind: 'task', goal: 'g', doneDefinition: 'd' } });
    const hash = harnessSpecHash(s);
    await createLabRun(h.db, { id: 'run-nobeat', orgId: ORG, harnessHash: hash, harnessName: s.name, spec: s });
    const c = scripted([ok({ text: 'd' }), ok({ text: 'Wrap-up: done.' })]);
    const o = await runLeg({ db: h.db, client: c, runId: 'run-nobeat', orgId: ORG, spec: s, harnessHash: hash });
    expect(o.status).toBe('completed');
    // ServingRequest.tools is a real field — the cast here was re-declaring
    // a weaker shape than the type already provides.
    const toolNames = c.calls[0]!.tools?.map((t) => t.function.name) ?? [];
    expect(toolNames).toContain('update_plan');
    expect(toolNames).not.toContain('remember');
    await h.close();
  }, 60_000);
});
