// 2026-08-31 — the honest-run laws (the "feels like nothing" prod finding):
//   · a worker BORN TOOLLESS (declared superpowers, none connected) fails
//     fast with an actionable reason — it never flails in prose and never
//     fake-completes;
//   · a schema-valid but EMPTY brief is not a completion — one repair round,
//     then an honest failure.
// Both replay divergence-free (the record verifies).
import { describe, expect, it } from 'vitest';
import { createDb, createLabRun, listLabSteps, migrate, seedIsolationOrgs, ORG_A } from '@potion/db';
import { harnessSpecHash, type HarnessSpec } from '@potion/lab-spec';
import { runLeg } from './loop.js';
import { replayRun } from './replay.js';
import type { StepPayload } from './checkpoint.js';
import type { ServingClientLike, ServingRequest, ServingResult } from './serving-client.js';

const ORG = ORG_A;

function standingContract(over: Partial<HarnessSpec> = {}): HarnessSpec {
  return {
    specVersion: 1,
    name: 'honest test harness',
    brain: { policy: { type: 'min_cost', qualityFloor: 0 } },
    mission: { kind: 'standing', goal: 'watch the market' },
    superpowers: [],
    memory: { enabled: false },
    rules: [],
    fuel: { maxUsdPerRun: 1, hardStop: true },
    checkIns: [],
    contract: { type: 'brief' },
    ...over,
  };
}

function scripted(results: ServingResult[]): ServingClientLike & { calls: ServingRequest[] } {
  const queue = [...results];
  const calls: ServingRequest[] = [];
  // A plain object, checked against the real signatures: the runtime takes
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
    kind: 'ok', completionId: `c-${Math.random().toString(36).slice(2, 8)}`, text: 'done.',
    toolCalls: [], finishReason: 'stop', usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    frontierTrace: 'cluster=x;strategy=t;frontier=v1;policy=min_cost;fallback=0;provenance=mock', ...over,
  };
}

async function seed(runId: string, s: HarnessSpec): Promise<string> {
  const h = await createDb();
  await migrate(h.db);
  await seedIsolationOrgs(h.db);
  const hash = harnessSpecHash(s);
  await createLabRun(h.db, { id: runId, orgId: ORG, harnessHash: hash, harnessName: s.name, spec: s });
  return hash;
}

describe('the honest-start fail-fast', () => {
  it('a worker declaring web with web UNCONNECTED fails fast — no model call, actionable reason, clean replay', async () => {
    const s = standingContract({ superpowers: [{ id: 'web', scopes: ['fetch:read'] }] });
    const h = await createDb();
    await migrate(h.db);
    await seedIsolationOrgs(h.db);
    const hash = harnessSpecHash(s);
    await createLabRun(h.db, { id: 'run-toolless', orgId: ORG, harnessHash: hash, harnessName: s.name, spec: s });
    const client = scripted([]); // must NEVER be called
    const out = await runLeg({
      db: h.db, client, runId: 'run-toolless', orgId: ORG, spec: s, harnessHash: hash,
      // the handler's typed note for an unconnected builtin:
      legNotes: [{ toolName: 'web', note: { superpowerUnavailable: { connectorId: 'web', status: 'not-connected', detail: 'enable it on the worker page' } } }],
      tools: [], // nothing loaded
    });
    expect(out.status).toBe('failed');
    expect((out as { reason: string }).reason).toBe('superpowers-unconnected');
    expect(client.calls).toHaveLength(0); // it never burned a model call
    const steps = await listLabSteps(h.db, 'run-toolless', ORG);
    expect(steps.every((x) => x.kind !== 'model')).toBe(true);
    const run = await import('@potion/db').then((m) => m.getLabRun(h.db, 'run-toolless', ORG));
    expect(run!.stateReason).toContain('web');
    expect(run!.stateReason).toContain('not ready');
    expect(run!.stateReason).toContain('not spend a cent');
    // clean replay: zero model steps = nothing to derive, terminal stands.
    // jsonb payloads arrive as `unknown`; narrow only that field.
    const v = replayRun(s, steps.map((x) => ({ seq: x.seq, kind: x.kind, payload: x.payload as StepPayload })), { state: 'failed', reason: run!.stateReason });
    expect(v.ok).toBe(true);
    await h.close();
  }, 60_000);

  it('TWO powers with the SAME remedy say it once — the sentence is read, not skipped', async () => {
    // Production, 2026-09-05, verbatim: "this worker needs code (enable it
    // on the worker page — one click, no account needed); web (enable it on
    // the worker page — one click, no account needed)". The same clause
    // twice is noise, and noise is what a reader's eye skips — which
    // defeats a message whose whole job is to be acted on.
    const s2 = standingContract({ superpowers: [{ id: 'code', scopes: [] }, { id: 'web', scopes: [] }] });
    const h = await createDb();
    await migrate(h.db);
    await seedIsolationOrgs(h.db);
    const hash = harnessSpecHash(s2);
    await createLabRun(h.db, { id: 'run-two', orgId: ORG, harnessHash: hash, harnessName: s2.name, spec: s2 });
    const detail = 'enable it on the worker page — one click, no account needed';
    const out = await runLeg({
      db: h.db, client: scripted([]), runId: 'run-two', orgId: ORG, spec: s2, harnessHash: hash,
      legNotes: [
        { toolName: 'code', note: { superpowerUnavailable: { connectorId: 'code', status: 'not-connected', detail } } },
        { toolName: 'web', note: { superpowerUnavailable: { connectorId: 'web', status: 'not-connected', detail } } },
      ],
      tools: [],
    });
    expect(out.status).toBe('failed');
    const run = await import('@potion/db').then((m) => m.getLabRun(h.db, 'run-two', ORG));
    const reason = run!.stateReason!;
    // Both powers are named…
    expect(reason).toContain('code');
    expect(reason).toContain('web');
    expect(reason).toContain('code and web');
    // …and the remedy they share appears exactly once.
    expect(reason.split(detail).length - 1).toBe(1);
    await h.close();
  }, 60_000);

  it('a worker with even ONE connected power is not failed — it does partial work', async () => {
    const s = standingContract({ superpowers: [{ id: 'web', scopes: [] }, { id: 'code', scopes: [] }] });
    const h = await createDb();
    await migrate(h.db);
    await seedIsolationOrgs(h.db);
    const hash = harnessSpecHash(s);
    await createLabRun(h.db, { id: 'run-partial', orgId: ORG, harnessHash: hash, harnessName: s.name, spec: s });
    const BRIEF = JSON.stringify({ headline: [{ claim: 'x', sourceUrl: 'https://e.com' }], byEntity: [], quiet: [], coverage: { checked: 1 } });
    const client = scripted([ok({ text: BRIEF })]);
    const realTool = { name: 'web_fetch', description: 'fetch', parameters: { type: 'object' }, external: false, run: async () => ({ ok: true }) };
    const out = await runLeg({
      db: h.db, client, runId: 'run-partial', orgId: ORG, spec: s, harnessHash: hash,
      legNotes: [{ toolName: 'code', note: { superpowerUnavailable: { connectorId: 'code', status: 'unreachable', detail: 'sandbox off' } } }],
      tools: [realTool],
    });
    expect(out.status).toBe('completed'); // web loaded, code note only — not failed
    await h.close();
  }, 60_000);
});

describe('the empty-brief rejection', () => {
  it('a hollow brief is repaired once, then fails — never a false completion', async () => {
    const s = standingContract();
    const hash = await seed('run-hollow', s);
    const h = await createDb();
    await migrate(h.db);
    await seedIsolationOrgs(h.db);
    await createLabRun(h.db, { id: 'run-hollow2', orgId: ORG, harnessHash: hash, harnessName: s.name, spec: s });
    const EMPTY = JSON.stringify({ headline: [], byEntity: [], quiet: [], coverage: { checked: 0 } });
    const EMPTY2 = JSON.stringify({ headline: [], byEntity: [], quiet: [], coverage: { checked: 0, note: 'still nothing' } });
    const client = scripted([ok({ text: EMPTY }), ok({ text: EMPTY2 })]); // repair, then STILL hollow (different text, dodges the stall breaker)
    const out = await runLeg({ db: h.db, client, runId: 'run-hollow2', orgId: ORG, spec: s, harnessHash: hash });
    expect(out.status).toBe('failed');
    expect((out as { reason: string }).reason).toBe('contract-violation');
    const run = await import('@potion/db').then((m) => m.getLabRun(h.db, 'run-hollow2', ORG));
    expect(run!.stateReason).toContain('empty deliverable');
    const steps = await listLabSteps(h.db, 'run-hollow2', ORG);
    // jsonb payloads arrive as `unknown`; narrow only that field.
    const v = replayRun(s, steps.map((x) => ({ seq: x.seq, kind: x.kind, payload: x.payload as StepPayload })), { state: 'failed', reason: run!.stateReason });
    expect(v.ok).toBe(true);
    await h.close();
  }, 60_000);
});
