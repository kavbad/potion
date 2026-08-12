// The Step 3 definition-of-done, proven walkthrough-style against the REAL
// serving surface: buildServer() on an ephemeral port, mock providers behind
// the actual route — actual metering, actual budget hard stop, actual rate
// limiter. No in-process shortcut exists in this file; the runtime speaks
// HTTP like any customer.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sha256 } from '@potion/core';
import {
  createDb,
  insertRequestLog,
  getLabRun,
  insertApiKey,
  insertPolicy,
  listLabSteps,
  migrate,
  requestLogs,
  traceSpans,
  upsertBudget,
  createOrg,
  type DbHandle,
} from '@potion/db';
import { inArray, eq } from 'drizzle-orm';
import { harnessSpecHash, type HarnessSpec } from '@potion/lab-spec';
import { buildServer } from '@potion/server/server';
import { ServingClient } from './serving-client.js';
import { startRun, resumeRun } from './cli.js';
import type { StepPayload } from './checkpoint.js';

const ORG = 'org_lab_wt';
const RAW_KEY = 'pk_lab_walkthrough_key_0001';

let h: DbHandle;
let app: FastifyInstance;
let baseUrl: string;
let client: ServingClient;

beforeAll(async () => {
  h = await createDb();
  await migrate(h.db);
  await createOrg(h.db, { id: ORG, name: 'Lab Walkthrough Org' });
  await insertPolicy(h.db, {
    id: 'pol-lab-wt',
    orgId: ORG,
    name: 'lab-wt',
    config: { type: 'min_cost', qualityFloor: 0 },
  });
  await insertApiKey(h.db, {
    id: 'key-lab-wt',
    keyHash: sha256(RAW_KEY),
    name: 'lab walkthrough',
    orgId: ORG,
    policyId: 'pol-lab-wt',
    rateRps: 1000,
    dailyCap: 100_000,
  });
  // seed:true computes PLATFORM frontiers (mock evidence) for code-gen +
  // extraction — the serving fallback our org rides, exactly as a fresh org
  // would in the product.
  app = await buildServer({ db: h, seed: true });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  if (addr === null || typeof addr === 'string') throw new Error('no address');
  baseUrl = `http://127.0.0.1:${addr.port}`;
  client = new ServingClient({ baseUrl, apiKey: RAW_KEY });
}, 120_000);

afterAll(async () => {
  await app.close();
  await h.close();
});

function taskSpec(over: Partial<HarnessSpec> = {}): HarnessSpec {
  return {
    specVersion: 1,
    name: 'walkthrough harness',
    brain: { policy: { type: 'min_cost', qualityFloor: 0 } },
    mission: {
      kind: 'task',
      goal: 'Write a Python function that checks whether a string is a palindrome',
      doneDefinition: 'A working function is described',
    },
    superpowers: [],
    memory: { enabled: false },
    rules: [],
    fuel: { maxUsdPerRun: 1, hardStop: true },
    checkIns: [],
    ...over,
  };
}

describe('DoD leg 1: headless run from a file, fully metered', () => {
  it('runs to completion; every model call joins its own request_logs row 1:1', async () => {
    const s = taskSpec();
    const { runId, outcome } = await startRun({
      db: h.db,
      client,
      orgId: ORG,
      specText: JSON.stringify(s),
    });
    expect(outcome.status).toBe('completed');

    const run = await getLabRun(h.db, runId, ORG);
    expect(run!.state).toBe('completed');

    const steps = await listLabSteps(h.db, runId, ORG);
    const modelSteps = steps.filter((x) => x.kind === 'model');
    expect(modelSteps.length).toBeGreaterThanOrEqual(1);

    // THE METERING JOIN: each step's completionId has exactly one
    // request_logs row, in OUR org — serving metered every call.
    const ids = modelSteps.map((x) => (x.payload as StepPayload).completionId!);
    expect(ids.every((id) => id.startsWith('chatcmpl-'))).toBe(true);
    const logs = await h.db.select().from(requestLogs).where(inArray(requestLogs.completionId, ids));
    expect(logs).toHaveLength(ids.length);
    expect(logs.every((l) => l.orgId === ORG)).toBe(true);

    // Per-step provenance rode the header, verbatim.
    const trace = (modelSteps[0]!.payload as StepPayload).frontierTrace!;
    expect(trace).toContain('policy=min_cost');
    expect(trace).toContain('provenance=mock');

    // DoD leg 5: span emission — llm.call spans ingested through the real
    // route, one per model step, idempotent (startRun already emitted).
    const spans = await h.db.select().from(traceSpans).where(eq(traceSpans.traceId, runId));
    expect(spans).toHaveLength(modelSteps.length);
    expect(spans.every((sp) => sp.orgId === ORG && sp.name === 'llm.call')).toBe(true);
  }, 120_000);
});

describe('DoD leg 2: hard stops kill runs, through the real route', () => {
  // TWO layers, both real, proven separately because the mock stack meters
  // $0 for some serving paths (measured: a fallback-path call landed
  // usage.costUsd = 0, so month-to-date spend never crosses a cap and the
  // org gate CORRECTLY never fires — recorded in the ledger; live pricing
  // makes org-budget kills deterministic, mock pricing does not).
  //
  //   2a — the ORG budget hard stop (serving's 429 budget_exceeded), proven
  //        first-touch: pre-existing spend exceeds the cap, the run's FIRST
  //        call refuses, the run is killed at birth and terminal.
  //   2b — the HARNESS fuel hard stop mid-run through the real route: step 1
  //        executes and meters for real; the fuel accounting then kills the
  //        run; the checkpoint survives; resume is refused terminal.
  it('2a: org budget 429 → killed-budget at first touch; terminal; resume refused', async () => {
    const KILL_ORG = 'org_lab_kill';
    const KILL_KEY = 'pk_lab_kill_key_0001';
    await createOrg(h.db, { id: KILL_ORG, name: 'Lab Kill Org' });
    await insertPolicy(h.db, {
      id: 'pol-lab-kill', orgId: KILL_ORG, name: 'lab-kill',
      config: { type: 'min_cost', qualityFloor: 0 },
    });
    await insertApiKey(h.db, {
      id: 'key-lab-kill', keyHash: sha256(KILL_KEY), name: 'kill',
      orgId: KILL_ORG, policyId: 'pol-lab-kill', rateRps: 1000, dailyCap: 100_000,
    });
    // Spend exceeds the cap BEFORE the org's first serving call: the gate's
    // first consultation stops (the billing-test seeding pattern).
    await insertRequestLog(h.db, {
      orgId: KILL_ORG, model: 'gpt-mini-class', status: 'ok',
      usage: { inputTokens: 100, outputTokens: 100, costUsd: 5 },
    });
    await upsertBudget(h.db, { orgId: KILL_ORG, monthlyCapUsd: 1, hardStop: true, warnPct: 50 });
    const killClient = new ServingClient({ baseUrl, apiKey: KILL_KEY });

    const s = taskSpec({
      name: 'budget kill harness',
      mission: { kind: 'standing', goal: 'keep describing palindrome functions' },
    });
    const { runId, outcome } = await startRun({
      db: h.db, client: killClient, orgId: KILL_ORG,
      specText: JSON.stringify(s), maxStepsPerLeg: 5,
    });
    expect(outcome.status).toBe('killed-budget');
    if (outcome.status === 'killed-budget') expect(outcome.reason).toBe('org-budget');
    const run = await getLabRun(h.db, runId, KILL_ORG);
    expect(run!.state).toBe('killed-budget');
    expect(run!.stateReason).toContain('org budget hard stop');
    // No serving call succeeded — nothing was bought against a spent budget.
    expect(await listLabSteps(h.db, runId, KILL_ORG)).toHaveLength(0);

    const resumed = await resumeRun({
      db: h.db, client: killClient, orgId: KILL_ORG, specText: JSON.stringify(s), runId,
    });
    expect(resumed.status).toBe('refused');
    if (resumed.status === 'refused') expect(resumed.reason).toBe('terminal');
  }, 120_000);

  it('2b: harness fuel hard stop kills MID-RUN through the real route; checkpoint survives', async () => {
    // Fuel below any real step estimate: step 1 executes and meters through
    // serving; the fuel check then kills before step 2. Deterministic
    // because the estimate derives from response TOKENS, which the mock
    // always returns, unlike metered dollars.
    const s = taskSpec({
      name: 'fuel kill harness',
      mission: { kind: 'standing', goal: 'keep describing palindrome functions' },
      fuel: { maxUsdPerRun: 1e-9, hardStop: true },
    });
    const { runId, outcome } = await startRun({
      db: h.db, client, orgId: ORG, specText: JSON.stringify(s), maxStepsPerLeg: 5,
    });
    expect(outcome.status).toBe('killed-budget');
    if (outcome.status === 'killed-budget') expect(outcome.reason).toBe('fuel');

    const run = await getLabRun(h.db, runId, ORG);
    expect(run!.state).toBe('killed-budget');
    // The kill was MID-RUN: step 1's checkpoint exists, durable, with its
    // real completionId — and survives into a fresh read.
    const steps = await listLabSteps(h.db, runId, ORG);
    expect(steps).toHaveLength(1);
    expect((steps[0]!.payload as StepPayload).completionId).toMatch(/^chatcmpl-/);

    const resumed = await resumeRun({
      db: h.db, client, orgId: ORG, specText: JSON.stringify(s), runId,
    });
    expect(resumed.status).toBe('refused');
    if (resumed.status === 'refused') expect(resumed.reason).toBe('terminal');
  }, 120_000);
});

describe('DoD leg 3: spec drift refuses a resume (F7 applied to runs)', () => {
  it('an edited spec cannot adopt an existing run', async () => {
    const s = taskSpec({
      name: 'drift harness',
      mission: { kind: 'standing', goal: 'stand by' },
    });
    const { runId } = await startRun({
      db: h.db, client, orgId: ORG, specText: JSON.stringify(s), maxStepsPerLeg: 1,
    });
    const edited = { ...s, rules: ['a new rule that changes what this harness IS'] };
    expect(harnessSpecHash(edited)).not.toBe(harnessSpecHash(s));
    const resumed = await resumeRun({
      db: h.db, client, orgId: ORG, specText: JSON.stringify(edited), runId,
    });
    expect(resumed.status).toBe('refused');
    if (resumed.status === 'refused') {
      expect(resumed.reason).toBe('spec-drift');
      expect(resumed.detail).toContain('fork');
    }
  }, 120_000);
});
