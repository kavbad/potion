// W0 — the honest cap (2026-08-31). The flat $0.01/1k-token estimate
// neither upper- nor lower-bounds real prices (min_cost routes run ~30x
// cheaper; premium routes can exceed it). The cap now spends the METERED
// charge (serving's potion.cost_usd) where present, the estimate where
// not — so "hard cap" means billed dollars, and old records derive
// exactly as before. Mirrored in replay same commit.
import { describe, expect, it } from 'vitest';
import {
  createDb,
  createLabRun,
  getLabRun,
  listLabSteps,
  migrate,
  seedIsolationOrgs,
  ORG_A,
  type DbHandle,
} from '@potion/db';
import { harnessSpecHash, type HarnessSpec } from '@potion/lab-spec';
import { runLeg } from './loop.js';
import { replayRun, type RecordedStep, type RecordedTerminal } from './replay.js';
import type { ServingClientLike, ServingRequest, ServingResult } from './serving-client.js';

function spec(maxUsdPerRun: number): HarnessSpec {
  return {
    specVersion: 1,
    name: 'honest cap harness',
    brain: { policy: { type: 'min_cost', qualityFloor: 0 } },
    mission: { kind: 'task', goal: 'do the thing', doneDefinition: 'done' },
    superpowers: [],
    memory: { enabled: false },
    rules: [],
    fuel: { maxUsdPerRun, hardStop: true },
    checkIns: [],
  };
}

function scripted(results: ServingResult[]): ServingClientLike {
  const queue = [...results];
  // A plain object, checked against the real signatures: the runtime takes
  // ServingClientLike, so a double no longer has to be a real client
  // pointed at an unroutable host.
  const client: ServingClientLike = {
    complete: async (_req: ServingRequest) => {
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
    text: 'a perfectly reasonable answer of sufficient length for a report.',
    toolCalls: [],
    finishReason: 'stop',
    usage: { promptTokens: 100_000, completionTokens: 100_000, totalTokens: 200_000 },
    frontierTrace: 'cluster=code-gen;strategy=test;frontier=v1;policy=min_cost;fallback=0;provenance=mock',
    ...over,
  };
}

async function freshRun(s: HarnessSpec): Promise<{ h: DbHandle; hash: string }> {
  const h = await createDb();
  await migrate(h.db);
  await seedIsolationOrgs(h.db);
  const hash = harnessSpecHash(s);
  await createLabRun(h.db, { id: 'run-cap', orgId: ORG_A, harnessHash: hash, harnessName: s.name, spec: s });
  return { h, hash };
}

async function recordOf(h: DbHandle): Promise<{ steps: RecordedStep[]; terminal: RecordedTerminal }> {
  const rows = await listLabSteps(h.db, 'run-cap', ORG_A);
  const run = (await getLabRun(h.db, 'run-cap', ORG_A))!;
  return {
    steps: rows.map((r) => ({ seq: r.seq, kind: r.kind, payload: r.payload })) as RecordedStep[],
    terminal: { state: run.state } as RecordedTerminal,
  };
}

describe('the cap spends billed dollars, not the token guess', () => {
  it('a $0 metered step falls back to the token estimate — a free route must not unbound a runaway loop', async () => {
    const s = spec(1);
    const { h, hash } = await freshRun(s);
    // 200k tokens at cost_usd 0: the activity bound (est $2) governs.
    await runLeg({
      db: h.db,
      client: scripted([ok({ costUsd: 0, text: '', finishReason: 'tool_calls', toolCalls: [{ id: 't1', type: 'function', function: { name: 'update_plan', arguments: '{"items":[{"step":"work","status":"active"}]}' } }] })]),
      runId: 'run-cap', orgId: ORG_A, spec: s, harnessHash: hash, tools: [],
    });
    expect((await getLabRun(h.db, 'run-cap', ORG_A))!.state).toBe('killed-budget');
    const rec = await recordOf(h);
    const res = replayRun(s, rec.steps, rec.terminal);
    expect(res.ok, JSON.stringify(!res.ok ? res.divergences : [])).toBe(true);
    await h.close();
  }, 60_000);

  it('a cheap metered route survives a cap the estimate would have killed — and replays clean', async () => {
    // 200k tokens → est $2.00, over the $1 cap. Metered truth: $0.001.
    const s = spec(1);
    const { h, hash } = await freshRun(s);
    const out = await runLeg({
      db: h.db,
      client: scripted([ok({ costUsd: 0.001 }), ok({ costUsd: 0.001, text: 'Wrap-up: done.' })]),
      runId: 'run-cap', orgId: ORG_A, spec: s, harnessHash: hash, tools: [],
    });
    expect(out.status, 'metered $0.002 is under the $1 cap').toBe('completed');
    const steps = await listLabSteps(h.db, 'run-cap', ORG_A);
    expect((steps[0]!.payload as { costUsd?: number }).costUsd).toBe(0.001);
    const rec = await recordOf(h);
    const res = replayRun(s, rec.steps, rec.terminal);
    expect(res.ok, JSON.stringify(!res.ok ? res.divergences : [])).toBe(true);
    await h.close();
  }, 60_000);

  it('without a metered charge the estimate still governs (old-record behavior)', async () => {
    const s = spec(1);
    const { h, hash } = await freshRun(s);
    // No costUsd: est $2 ≥ $1 cap → the run is killed at the next gate.
    await runLeg({
      db: h.db,
      client: scripted([ok({ text: '', finishReason: 'tool_calls', toolCalls: [{ id: 't1', type: 'function', function: { name: 'update_plan', arguments: '{"items":[{"step":"work","status":"active"}]}' } }] })]),
      runId: 'run-cap', orgId: ORG_A, spec: s, harnessHash: hash, tools: [],
    });
    expect((await getLabRun(h.db, 'run-cap', ORG_A))!.state).toBe('killed-budget');
    await h.close();
  }, 60_000);

  it('metered charges DO kill when they truly cross the cap', async () => {
    const s = spec(0.005);
    const { h, hash } = await freshRun(s);
    await runLeg({
      db: h.db,
      client: scripted([
        ok({ costUsd: 0.006, text: '', finishReason: 'tool_calls', toolCalls: [{ id: 't1', type: 'function', function: { name: 'update_plan', arguments: '{"items":[{"step":"work","status":"active"}]}' } }] }),
      ]),
      runId: 'run-cap', orgId: ORG_A, spec: s, harnessHash: hash, tools: [],
    });
    const run = (await getLabRun(h.db, 'run-cap', ORG_A))!;
    expect(run.state).toBe('killed-budget');
    const rec = await recordOf(h);
    const res = replayRun(s, rec.steps, rec.terminal);
    expect(res.ok, JSON.stringify(!res.ok ? res.divergences : [])).toBe(true);
    await h.close();
  }, 60_000);
});
