// Loop semantics with a SCRIPTED ServingClient (a test double of the CLIENT,
// not of serving — the serving contract itself is proven against the real
// route in walkthrough.test.ts; this file drives the paths the mock provider
// cannot, because it never emits tool_calls).
//
// Double divergence (driver-semantics lesson): the scripted client answers
// instantly and deterministically; the real route meters, rate-limits and
// budget-checks. Every branch that depends on those behaviors is tested in
// walkthrough.test.ts against buildServer, not here.
import { describe, expect, it } from 'vitest';
import {
  createDb,
  createLabRun,
  getLabMemory,
  getLabRun,
  listLabSteps,
  migrate,
  type DbHandle,
} from '@potion/db';
import { harnessSpecHash, type HarnessSpec } from '@potion/lab-spec';
import { seedIsolationOrgs, ORG_A } from '@potion/db';
import { runLeg, type LabTool } from './loop.js';
import type { ServingClient, ServingRequest, ServingResult } from './serving-client.js';
import { SecretInCheckpointError, buildStepPayload } from './checkpoint.js';

function spec(over: Partial<HarnessSpec> = {}): HarnessSpec {
  return {
    specVersion: 1,
    name: 'loop test harness',
    brain: { policy: { type: 'min_cost', qualityFloor: 0 } },
    mission: { kind: 'task', goal: 'do the thing', doneDefinition: 'the thing is done' },
    superpowers: [],
    memory: { enabled: true },
    rules: ['be terse'],
    fuel: { maxUsdPerRun: 1, hardStop: true },
    checkIns: [],
    ...over,
  };
}

/** Scripted client: pops one result per complete() call. */
function scripted(results: ServingResult[]): ServingClient {
  const queue = [...results];
  const calls: ServingRequest[] = [];
  const client = {
    calls,
    complete: async (req: ServingRequest) => {
      calls.push(req);
      const next = queue.shift();
      if (!next) throw new Error('scripted client exhausted');
      return next;
    },
    emitSpans: async () => true,
  };
  return client as unknown as ServingClient;
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

async function freshRun(s: HarnessSpec): Promise<{ h: DbHandle; hash: string }> {
  const h = await createDb();
  await migrate(h.db);
  await seedIsolationOrgs(h.db);
  const hash = harnessSpecHash(s);
  await createLabRun(h.db, {
    id: 'run-loop', orgId: ORG_A, harnessHash: hash, harnessName: s.name, spec: s,
  });
  return { h, hash };
}

const ORG = ORG_A;

describe('tool execution + memory projection', () => {
  it('executes a tool call, checkpoints both steps, projects memory writes', async () => {
    const s = spec();
    const { h, hash } = await freshRun(s);
    const noteTool: LabTool = {
      name: 'record_note', description: 'record a note', parameters: { type: 'object' },
      external: false,
      run: async (input) => ({ noted: input, _memoryWrites: { lastNote: input } }),
    };
    const client = scripted([
      ok({
        text: '',
        finishReason: 'tool_calls',
        toolCalls: [{ id: 't1', type: 'function', function: { name: 'record_note', arguments: '{"text":"hello"}' } }],
      }),
      ok({ text: 'noted and done.' }),
      ok({ text: 'Wrap-up: tool ran, memory noted; done.' }),
    ]);
    const outcome = await runLeg({
      db: h.db, client, runId: 'run-loop', orgId: ORG, spec: s, harnessHash: hash, tools: [noteTool],
    });
    expect(outcome.status).toBe('completed');

    const steps = await listLabSteps(h.db, 'run-loop', ORG);
    expect(steps.map((x) => x.kind)).toEqual(['model', 'tool', 'model', 'model']); // + the Step 8 wrap-up
    // Memory is the projection of the step history.
    expect(await getLabMemory(h.db, ORG, hash)).toEqual({ lastNote: { text: 'hello' } });
    await h.close();
  }, 60_000);
});

describe('pause-for-human (first-class, across invocations)', () => {
  it('external tool + before-external-action → suspend BEFORE executing; answer resumes; tool then runs', async () => {
    const s = spec({ checkIns: [{ trigger: 'before-external-action' }] });
    const { h, hash } = await freshRun(s);
    let sent = 0;
    const emailTool: LabTool = {
      name: 'send_email', description: 'send an email', parameters: { type: 'object' },
      external: true,
      run: async () => { sent += 1; return { sent: true }; },
    };
    const firstClient = scripted([
      ok({ text: '', finishReason: 'tool_calls', toolCalls: [{ id: 't1', type: 'function', function: { name: 'send_email', arguments: '{}' } }] }),
    ]);
    const leg1 = await runLeg({
      db: h.db, client: firstClient, runId: 'run-loop', orgId: ORG, spec: s, harnessHash: hash, tools: [emailTool],
    });
    expect(leg1.status).toBe('awaiting-human');
    expect(sent, 'the external tool must NOT run before the answer').toBe(0);
    expect((await getLabRun(h.db, 'run-loop', ORG))!.state).toBe('awaiting-human');

    // The answer arrives (CLI channel), a NEW invocation adopts the run.
    const { answerLabRun } = await import('@potion/db');
    expect(await answerLabRun(h.db, 'run-loop', ORG, 'yes, send it')).toBe(true);
    const secondClient = scripted([
      // Resumed conversation carries the answer; model calls the tool again.
      ok({ text: '', finishReason: 'tool_calls', toolCalls: [{ id: 't2', type: 'function', function: { name: 'send_email', arguments: '{}' } }] }),
      ok({ text: 'sent. done.' }),
      ok({ text: 'Wrap-up: email sent after approval; done.' }),
    ]);
    // NOTE: the gate fires per tool call; the resumed leg re-asks unless the
    // answer covers it. v1 semantics: the gate consumes the pending answer —
    // one answer authorizes the NEXT external action.
    const leg2 = await runLeg({
      db: h.db, client: secondClient, runId: 'run-loop', orgId: ORG, spec: s, harnessHash: hash, tools: [emailTool],
    });
    // One answer, one action: t2 is authorized by the recorded answer.
    expect(leg2.status).toBe('completed');
    expect(sent).toBe(1);
    const steps = await listLabSteps(h.db, 'run-loop', ORG);
    expect(steps.find((x) => x.kind === 'check-in')).toBeDefined();
    await h.close();
  }, 60_000);
});

describe('fuel hard stop (harness-level)', () => {
  it('kills the run once the estimate crosses maxUsdPerRun; terminal thereafter', async () => {
    // Fuel so small the first step's estimate exceeds it.
    const s = spec({ fuel: { maxUsdPerRun: 0.0000001, hardStop: true } });
    const { h, hash } = await freshRun(s);
    const client = scripted([
      ok({ text: 'step one', finishReason: 'stop' }),
      ok({ text: 'never reached' }),
    ]);
    // Task would complete at step 1 — use standing so the loop iterates.
    const standing = { ...s, mission: { kind: 'standing' as const, goal: 'watch' } };
    const out1 = await runLeg({
      db: h.db, client, runId: 'run-loop', orgId: ORG, spec: standing, harnessHash: hash,
    });
    expect(out1.status).toBe('killed-budget');
    if (out1.status === 'killed-budget') expect(out1.reason).toBe('fuel');
    // Checkpoint survived the kill; resume is refused with the fork remedy.
    expect(await listLabSteps(h.db, 'run-loop', ORG)).toHaveLength(1);
    const out2 = await runLeg({
      db: h.db, client, runId: 'run-loop', orgId: ORG, spec: standing, harnessHash: hash,
    });
    expect(out2.status).toBe('refused');
    if (out2.status === 'refused') expect(out2.reason).toBe('terminal');
    await h.close();
  }, 60_000);
});

describe('the secret gate (review addition 2)', () => {
  it('a tool output carrying key-shaped material refuses the checkpoint and fails the run typed', async () => {
    const s = spec();
    const { h, hash } = await freshRun(s);
    const leakyTool: LabTool = {
      name: 'fetch_config', description: 'fetch config', parameters: { type: 'object' },
      external: false,
      run: async () => ({ config: 'OPENROUTER_API_KEY=sk-or-v1-0000FAKELEAK00000000000' }),
    };
    const client = scripted([
      ok({ text: '', finishReason: 'tool_calls', toolCalls: [{ id: 't1', type: 'function', function: { name: 'fetch_config', arguments: '{}' } }] }),
    ]);
    const outcome = await runLeg({
      db: h.db, client, runId: 'run-loop', orgId: ORG, spec: s, harnessHash: hash, tools: [leakyTool],
    });
    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') expect(outcome.reason).toBe('secret-in-checkpoint');
    // The model step checkpointed; the LEAKY tool step did not.
    const steps = await listLabSteps(h.db, 'run-loop', ORG);
    expect(steps.map((x) => x.kind)).toEqual(['model']);
    expect((await getLabRun(h.db, 'run-loop', ORG))!.stateReason).toContain('secret-in-checkpoint');
    await h.close();
  }, 60_000);

  it('buildStepPayload refuses model responses carrying secrets too', () => {
    expect(() =>
      buildStepPayload({
        kind: 'model',
        responseText: 'your key is sk-ant-0000FAKELEAK0000000000',
        clockMs: 0,
        rngSample: 0,
      }),
    ).toThrow(SecretInCheckpointError);
  });
});

describe('structural: no provider-call paths (touchpoint 1)', () => {
  it('the runtime depends on neither @potion/providers nor @potion/harness, and no source file imports them', async () => {
    const { readFileSync, readdirSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const pkg = JSON.parse(
      readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
    ) as { dependencies: Record<string, string>; devDependencies: Record<string, string> };
    expect(Object.keys(pkg.dependencies)).not.toContain('@potion/providers');
    expect(Object.keys(pkg.dependencies)).not.toContain('@potion/harness');
    const srcDir = fileURLToPath(new URL('.', import.meta.url));
    for (const f of readdirSync(srcDir).filter((f) => f.endsWith('.ts'))) {
      const src = readFileSync(`${srcDir}/${f}`, 'utf8');
      expect(src, `${f} must not import provider machinery`).not.toMatch(
        /from '@potion\/(providers|harness)/,
      );
    }
  });
});

describe('Step 8 review pins — answer scope and wrap-up fuel', () => {
  it('a FUEL check-in answer never authorizes an external action (the gate re-fires)', async () => {
    const s = spec({
      fuel: { maxUsdPerRun: 0.0002, hardStop: true },
      checkIns: [
        { trigger: 'on-budget-fraction', fraction: 0.5 },
        { trigger: 'before-external-action' },
      ],
    });
    const { h, hash } = await freshRun(s);
    let sent = 0;
    const emailTool: LabTool = {
      name: 'send_email', description: 'send an email', parameters: { type: 'object' },
      external: true,
      run: async () => { sent += 1; return { sent: true }; },
    };
    // Leg 1: one non-done call crosses the budget fraction → FUEL check-in.
    const leg1 = await runLeg({
      db: h.db, client: scripted([ok({ text: 'still working', finishReason: 'length' })]),
      runId: 'run-loop', orgId: ORG, spec: s, harnessHash: hash, tools: [emailTool],
    });
    expect(leg1.status).toBe('awaiting-human');
    if (leg1.status === 'awaiting-human') expect(leg1.question).toContain('Fuel');

    // The human answers THE FUEL QUESTION — that answer must not double as
    // external-action authorization (review pin).
    const { answerLabRun } = await import('@potion/db');
    expect(await answerLabRun(h.db, 'run-loop', ORG, 'yes, keep going')).toBe(true);
    const leg2 = await runLeg({
      db: h.db,
      client: scripted([
        ok({ text: '', finishReason: 'tool_calls', toolCalls: [{ id: 't1', type: 'function', function: { name: 'send_email', arguments: '{}' } }] }),
      ]),
      runId: 'run-loop', orgId: ORG, spec: s, harnessHash: hash, tools: [emailTool],
    });
    // The resumed leg's external call must PAUSE at its own gate — the tool
    // never ran on the strength of the fuel answer.
    expect(leg2.status).toBe('awaiting-human');
    expect(sent).toBe(0);
    await h.close();
  }, 60_000);

  it('the wrap-up is skipped when fuel is exhausted — no paid call after the cap', async () => {
    // Two model calls of 15 tokens est $0.00015 each; cap $0.0002 → after
    // the done-shaped second call the cap is crossed, so the deliberate
    // tool-free wrap-up must NOT be issued (scripted client has no third
    // response — an attempted wrap-up would throw 'exhausted').
    const s = spec({ fuel: { maxUsdPerRun: 0.0002, hardStop: true } });
    const { h, hash } = await freshRun(s);
    const noteTool: LabTool = {
      name: 'record_note', description: 'record a note', parameters: { type: 'object' },
      external: false,
      run: async (input) => ({ noted: input }),
    };
    const outcome = await runLeg({
      db: h.db,
      client: scripted([
        ok({ text: '', finishReason: 'tool_calls', toolCalls: [{ id: 't1', type: 'function', function: { name: 'record_note', arguments: '{}' } }] }),
        ok({ text: 'noted and done.' }),
      ]),
      runId: 'run-loop', orgId: ORG, spec: s, harnessHash: hash, tools: [noteTool],
    });
    expect(outcome.status).toBe('completed');
    const steps = await listLabSteps(h.db, 'run-loop', ORG);
    expect(steps.map((x) => x.kind)).toEqual(['model', 'tool', 'model']); // NO wrap-up step
    await h.close();
  }, 60_000);
});
