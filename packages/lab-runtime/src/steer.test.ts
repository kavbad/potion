// X8 — the session shape's laws at the loop layer:
//   · pending steers fold into the conversation at the NEXT model step,
//     stamped ON that step, and are consumed durably (with the seq);
//   · consumed steers never re-inject;
//   · the steered record replays divergence-free (the mirror);
//   · steering is guidance, never authorization — the steer message says
//     so in its own text, and no pore state is touched by it.
import { describe, expect, it } from 'vitest';
import { createDb, createLabRun, listLabSteps, migrate, seedIsolationOrgs, ORG_A } from '@potion/db';
import { harnessSpecHash, type HarnessSpec } from '@potion/lab-spec';
import { runLeg, steerMessage } from './loop.js';
import { replayRun } from './replay.js';
import type { StepPayload } from './checkpoint.js';
import { ServingClient, type ServingRequest, type ServingResult } from './serving-client.js';

const ORG = ORG_A;

function spec(): HarnessSpec {
  return {
    specVersion: 1,
    name: 'steer test harness',
    brain: { policy: { type: 'min_cost', qualityFloor: 0 } },
    mission: { kind: 'task', goal: 'do the thing', doneDefinition: 'the thing is done' },
    superpowers: [],
    memory: { enabled: false },
    rules: [],
    fuel: { maxUsdPerRun: 1, hardStop: true },
    checkIns: [],
  };
}

function scripted(results: ServingResult[]): ServingClient & { calls: ServingRequest[] } {
  const queue = [...results];
  const calls: ServingRequest[] = [];
  // A REAL ServingClient with its outbound methods scripted, so the stub's
  // replies are type-checked against ServingResult.
  const client = Object.assign(
    new ServingClient({ baseUrl: 'http://serving.invalid', apiKey: 'test-key' }),
    { calls },
  );
  client.complete = async (req: ServingRequest) => {
    calls.push(req);
    const next = queue.shift();
    if (!next) throw new Error('scripted client exhausted');
    return next;
  };
  client.emitSpans = async () => true;
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

describe('the steer law', () => {
  it('folds in at the next step, stamps the record, consumes once, and the record replays clean', async () => {
    const h = await createDb();
    await migrate(h.db);
    await seedIsolationOrgs(h.db);
    const s = spec();
    const hash = harnessSpecHash(s);
    await createLabRun(h.db, { id: 'run-steer', orgId: ORG, harnessHash: hash, harnessName: s.name, spec: s });

    // A queue that delivers one steer on the FIRST read, then goes quiet.
    let delivered = false;
    const consumed: Array<{ ids: string[]; seq: number }> = [];
    const planCall = {
      id: 'p1', type: 'function' as const,
      function: { name: 'update_plan', arguments: JSON.stringify({ tasks: [{ id: '1', title: 'work', status: 'doing' }] }) },
    };
    const client = scripted([
      ok({ text: '', finishReason: 'tool_calls', toolCalls: [planCall] }),
      ok({ text: 'the thing is done' }),
      ok({ text: 'Wrap-up: done.' }),
    ]);
    const out = await runLeg({
      db: h.db, client, runId: 'run-steer', orgId: ORG, spec: s, harnessHash: hash,
      readSteers: async () => {
        if (delivered) return [];
        delivered = true;
        return [{ id: 'steer-1', text: 'focus on the changelog only' }];
      },
      markSteersConsumed: async (ids, seq) => { consumed.push({ ids, seq }); },
    });
    expect(out.status).toBe('completed');

    // The FIRST model call carried the steer message, verbatim via the
    // shared builder; later calls did not (consumed).
    const first = client.calls[0]!.messages as Array<{ role: string; content: string }>;
    const expected = steerMessage('focus on the changelog only');
    expect(first.some((m) => m.role === 'user' && m.content === expected.content)).toBe(true);
    const second = client.calls[1]!.messages as Array<{ role: string; content: string }>;
    expect(second.filter((m) => m.content === expected.content)).toHaveLength(1); // history keeps ONE copy, no re-injection

    // The stamp + the durable consumption receipt.
    const steps = await listLabSteps(h.db, 'run-steer', ORG);
    const stamped = steps.find((x) => (x.payload as { steers?: string[] }).steers !== undefined);
    expect(stamped, 'a model step must carry the steers stamp').toBeDefined();
    expect((stamped!.payload as { steers: string[] }).steers).toEqual(['focus on the changelog only']);
    expect(consumed).toEqual([{ ids: ['steer-1'], seq: stamped!.seq }]);

    // THE MIRROR: the steered record replays divergence-free.
    const verdict = replayRun(
      s,
      // jsonb payloads arrive as `unknown`; narrow only that field.
      steps.map((x) => ({ seq: x.seq, kind: x.kind, payload: x.payload as StepPayload })),
      { state: 'completed', reason: null },
    );
    expect(verdict.ok).toBe(true);
    await h.close();
  }, 60_000);

  it('the steer message names itself guidance, not approval', () => {
    const m = steerMessage('yes, go ahead with everything');
    expect(m.content).toContain('not a new mission');
    expect(m.content).toContain('not an approval');
  });
});
