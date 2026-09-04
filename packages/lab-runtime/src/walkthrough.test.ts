// The Step 3 definition-of-done, proven walkthrough-style against the REAL
// serving surface: buildServer() on an ephemeral port, mock providers behind
// the actual route — actual metering, actual budget hard stop, actual rate
// limiter. No in-process shortcut exists in this file; the runtime speaks
// HTTP like any customer.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
let app: Awaited<ReturnType<typeof buildServer>>;
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
    // X2: tool steps (e.g. the ledger's update_plan) emit tool.* spans —
    // the llm.call count still matches model steps exactly.
    const llmSpans = spans.filter((sp) => sp.name === 'llm.call');
    expect(llmSpans).toHaveLength(modelSteps.length);
    expect(spans.every((sp) => sp.orgId === ORG)).toBe(true);
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
      // latencyMs is required by Usage — the row is persisted under that
      // type, and cost rollups read the blob, so an incomplete one is a row
      // production queries cannot fully account for.
      usage: { inputTokens: 100, outputTokens: 100, costUsd: 5, latencyMs: 100 },
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
    // X2: the mock may spend its first response on update_plan (a model
    // step + a tool step) before the fuel law bites — the invariant is a
    // durable, metered checkpoint, not an exact count.
    const killModelSteps = steps.filter((x) => x.kind === 'model');
    expect(killModelSteps.length).toBeGreaterThanOrEqual(1);
    expect((killModelSteps[0]!.payload as StepPayload).completionId).toMatch(/^chatcmpl-/);

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
    // 2026-08-27: standing legs now COMPLETE on a no-tool natural stop, so a
    // real mock response would end this run terminally and the resume would
    // refuse as 'terminal' before drift is ever checked. The drift check
    // needs a genuinely NON-terminal run — a truncated ('length') response
    // parks the leg at its cap without completing it.
    // A REAL ServingClient with its outbound methods scripted, so the stub's
    // replies are type-checked against ServingResult.
    const lengthClient = new ServingClient({ baseUrl: 'http://serving.invalid', apiKey: 'test-key' });
    lengthClient.complete = async () => ({
      kind: 'ok' as const,
      completionId: 'c-drift',
      text: 'working…',
      toolCalls: [],
      finishReason: 'length',
      usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 },
      frontierTrace: 'cluster=summarization;strategy=x;frontier=v1;policy=compound;fallback=0;provenance=mock',
    });
    lengthClient.emitSpans = async () => true;
    const { runId } = await startRun({
      db: h.db, client: lengthClient, orgId: ORG, specText: JSON.stringify(s), maxStepsPerLeg: 1,
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

// ─────────────────────────────────────────────────────────────────────────────
// Step 8 — THE TOOLPOLICY ACTIVATION LEG (carried DoD item 1, Step 7's exit
// criterion, verbatim): one walkthrough run with a test-local executable
// tool whose step payloads carry BOTH slot values, each call's
// x-frontier-trace showing `policy_override=` of ITS slot's materialized
// row. Served through the REAL route — the pins are HTTP headers, the
// traces are serving's own answers.
// ─────────────────────────────────────────────────────────────────────────────

describe('Step 8 — the toolPolicy activation leg', () => {
  it('tool-bearing run: tools steps under the tools row, the wrap-up under brain — trace-proven', async () => {
    const { strategyHash } = await import('@potion/core');
    const { saveFrontier } = await import('@potion/pareto');
    const { materializeDialPolicy } = await import('@potion/lab-dial');
    const { clusters } = await import('@potion/db');

    // A singles-only cluster world (live-labeled, self-consistent hashes)
    // so BOTH pinned policies select executable singles — the activation
    // proof is about slot custody, not the partition gap (Step 7 pinned
    // that separately).
    await h.db.insert(clusters).values({
      id: 'activation-cluster', name: 'activation', description: 'Step 8 activation leg',
    }).onConflictDoNothing();
    const cfgCheap = { type: 'single' as const, model: 'mock-cheap' };
    const cfgMid = { type: 'single' as const, model: 'mock-mid' };
    await saveFrontier(h.db, 'activation-cluster', [
      {
        clusterId: 'activation-cluster', strategyHash: strategyHash(cfgCheap), strategyConfig: cfgCheap,
        quality: 0.6, costPer1K: 0.004, latencyP95: 300, providerMode: 'live',
        evidence: { cacheKeys: ['ck-act'], runIds: ['run-act'], n: 12, qualityCi95: 0.02 },
      },
      {
        clusterId: 'activation-cluster', strategyHash: strategyHash(cfgMid), strategyConfig: cfgMid,
        quality: 0.9, costPer1K: 0.02, latencyP95: 600, providerMode: 'live',
        evidence: { cacheKeys: ['ck-act2'], runIds: ['run-act2'], n: 12, qualityCi95: 0.02 },
      },
    ], 'recompute', 'pv-activation');

    // DISTINCT policies per slot → distinct materialized rows → distinct
    // policy_override values in the traces (the proof discriminator).
    const s = taskSpec({
      name: 'activation harness',
      brain: {
        policy: { type: 'min_cost', qualityFloor: 0 },
        toolPolicy: { type: 'min_cost', qualityFloor: 0.8 },
      },
      superpowers: [{ id: 'notes', scopes: ['write'] }],
    });
    const hash = harnessSpecHash(s);
    const brainRow = await materializeDialPolicy(h.db, {
      orgId: ORG, harnessHash: hash, slot: 'brain', policy: s.brain.policy,
    });
    const toolsRow = await materializeDialPolicy(h.db, {
      orgId: ORG, harnessHash: hash, slot: 'tools', policy: s.brain.toolPolicy!,
    });
    expect(brainRow.name).not.toBe(toolsRow.name);

    const noteTool = {
      name: 'record_note', description: 'record a note', parameters: { type: 'object' as const },
      external: false,
      run: async (input: unknown) => ({ noted: input }),
    };
    const actClient = new ServingClient({ baseUrl, apiKey: RAW_KEY, clusterHint: 'activation-cluster' });
    const { runId, outcome } = await startRun({
      db: h.db,
      client: actClient,
      orgId: ORG,
      specText: JSON.stringify(s),
      tools: [noteTool],
      policyRefs: { brain: brainRow.name, tools: toolsRow.name },
    });
    expect(outcome.status).toBe('completed');

    const steps = await listLabSteps(h.db, runId, ORG);
    const modelSteps = steps.filter((x) => x.kind === 'model').map((x) => x.payload as StepPayload);
    // BOTH slot values present in one run — the activation.
    const slots = new Set(modelSteps.map((p) => p.slot));
    expect(slots).toEqual(new Set(['tools', 'brain']));
    // Every call's trace carries the POLICY OVERRIDE of its slot's row —
    // serving's own answer, not a runtime annotation.
    for (const p of modelSteps) {
      const trace = p.frontierTrace ?? '';
      const expected = p.slot === 'tools' ? toolsRow.name : brainRow.name;
      expect(trace, `slot ${p.slot} trace: ${trace}`).toContain(`policy_override=${expected}`);
    }
    // The wrap-up (the deliberate tool-free brain call) is the LAST model
    // step and its request carried no tools.
    const last = modelSteps[modelSteps.length - 1]!;
    expect(last.slot).toBe('brain');
    expect((last.requestPayload as { tools?: unknown }).tools).toBeUndefined();
    // And the two slots really rode DIFFERENT strategies (0.8 floor vs 0):
    // the discriminator that makes the custody visible in the serving data.
    const strat = (p: StepPayload) => /(?:^|;)strategy=([0-9a-f]+)/.exec(p.frontierTrace ?? '')?.[1];
    const toolsStrats = new Set(modelSteps.filter((p) => p.slot === 'tools').map(strat));
    const brainStrats = new Set(modelSteps.filter((p) => p.slot === 'brain').map(strat));
    expect([...toolsStrats][0]).toBeDefined();
    expect([...brainStrats][0]).toBeDefined();
    expect([...toolsStrats][0]).not.toBe([...brainStrats][0]);
  }, 120_000);
});

describe('Step 10 — MCP connect leg ($0): severed → healed → gated call → caps → revoked', () => {
  it('a real fixture grant + mock MCP server drives a GATED external tool call end-to-end, all at $0, with the filament states visible', async () => {
    const { sealEnvelope } = await import('@potion/custody');
    const sealFor = (m: Buffer, v: string): string => sealEnvelope(m, v);
    const { MockMcpServer } = await import('@potion/lab-mcp/mock-server');
    const { buildMcpLabTools } = await import('./mcp-tools.js');
    const { upsertLabGrant, getLabGrant, grantConnectionStatus, markLabGrantStatus, answerLabRun } =
      await import('@potion/db');

    const MASTER = '11'.repeat(32);
    const master = Buffer.from(MASTER, 'hex');
    const GRANT_TOKEN = 'gho_walkthroughMCP4X9mQ2vL7pK8rT3sW6zE1';

    // A mock HOSTED MCP server — plays the remote wire the client speaks to.
    const mcp = await MockMcpServer.start({
      tools: [
        { name: 'get_me', description: 'who am I', handler: () => ({ login: 'kavon', echo: GRANT_TOKEN }) },
        { name: 'publish_note', description: 'publish', handler: () => ({ published: true }) },
      ],
      requireBearer: GRANT_TOKEN,
    });
    try {
      const connector = {
        connectorId: 'github', displayName: 'GitHub (mock)', transport: 'streamable-http' as const,
        baseUrl: mcp.mcpUrl,
        oauth: { authorizationUrl: `${mcp.url}/a`, tokenUrl: mcp.tokenUrl, clientIdEnv: 'X_ID', clientSecretEnv: 'X_SECRET', scopesOffered: [] },
        tools: {
          // Step 11: authored strings + action classification. get_me is a
          // READ (no pore); publish_note is an ACT (the pore fires).
          get_me: {
            scopes: [], action: 'read' as const,
            description: 'Identity of the granted account.',
            parameters: { type: 'object', properties: {}, additionalProperties: false },
          },
          publish_note: {
            scopes: [], action: 'act' as const,
            description: 'Publish a note. Others will see it.',
            parameters: { type: 'object', properties: {}, additionalProperties: false },
          },
        },
      };
      const s = taskSpec({
        name: 'mcp connect harness',
        superpowers: [{ id: 'github', scopes: [] }],
        checkIns: [{ trigger: 'before-external-action' }],
      });
      const hash = harnessSpecHash(s);

      // SEVERED: no grant yet — the DTO-derived form reads not-connected.
      expect(grantConnectionStatus(await getLabGrant(h.db, ORG, 'github'))).toBe('not-connected');

      // HEALED: the grant lands (as the OAuth callback would seal it).
      await upsertLabGrant(h.db, {
        id: 'grant-wt', orgId: ORG, connectorId: 'github', superpowerId: 'github',
        scopesGranted: [], tokenEnvelope: sealFor(master, GRANT_TOKEN), grantedBy: 'usr_wt',
      });
      expect(grantConnectionStatus(await getLabGrant(h.db, ORG, 'github'))).toBe('connected');

      // The run: MCP tools built from the grant; the model (real route, mock
      // provider) emits the tool call → the pore SUSPENDS before it fires.
      const leg1 = await buildMcpLabTools({
        db: h.db, orgId: ORG, runId: 'run-mcp-wt', masterKey: master, spec: s, connectors: [connector],
      });
      expect(leg1.tools.map((t) => t.name).sort()).toEqual(['github.get_me', 'github.publish_note']);
      // Step 11: the classification drives the pore, per tool.
      expect(leg1.tools.find((t) => t.name === 'github.get_me')!.external).toBe(false);
      expect(leg1.tools.find((t) => t.name === 'github.publish_note')!.external).toBe(true);
      // Authored descriptions rode; the server's ('who am I') did not.
      expect(leg1.tools.find((t) => t.name === 'github.get_me')!.description).toBe(
        'Identity of the granted account.',
      );
      const { createLabRun } = await import('@potion/db');

      // ── Part A: a READ runs WITHOUT a permission prompt (Step 11 §2). The
      // mock provider calls the first declared tool; with only the read tool
      // offered, that is github.get_me — and the run completes, unblocked.
      await createLabRun(h.db, { id: 'run-mcp-read', orgId: ORG, harnessHash: hash, harnessName: s.name, spec: s });
      const readOnly = leg1.tools.filter((t) => !t.external);
      const readRun = await resumeRun({
        db: h.db, client, orgId: ORG, specText: JSON.stringify(s), runId: 'run-mcp-read',
        tools: readOnly, legNotes: leg1.legNotes,
      });
      expect(readRun.status).toBe('completed'); // no pore for a read
      const readSteps = await listLabSteps(h.db, 'run-mcp-read', ORG);
      expect(readSteps.some((x) => x.kind === 'check-in')).toBe(false);
      expect(mcp.requests.filter((r) => r.method === 'tools/call')).toHaveLength(1);

      // ── Part B: an ACT SUSPENDS at the before-external-action pore.
      await createLabRun(h.db, { id: 'run-mcp-wt', orgId: ORG, harnessHash: hash, harnessName: s.name, spec: s });
      const actOnly = leg1.tools.filter((t) => t.external);
      expect(actOnly.map((t) => t.name)).toEqual(['github.publish_note']);
      const first = await resumeRun({
        db: h.db, client, orgId: ORG, specText: JSON.stringify(s), runId: 'run-mcp-wt',
        tools: actOnly, legNotes: leg1.legNotes,
      });
      await leg1.close();
      expect(first.status).toBe('awaiting-human'); // the pore fired on the ACT
      expect(mcp.requests.filter((r) => r.method === 'tools/call')).toHaveLength(1); // still just the read

      // Approve → the GATED act runs exactly once; the result is REDACTED
      // (the server echoed the bearer) before it reaches any checkpoint.
      await answerLabRun(h.db, 'run-mcp-wt', ORG, 'yes');
      const leg2 = await buildMcpLabTools({
        db: h.db, orgId: ORG, runId: 'run-mcp-wt', masterKey: master, spec: s, connectors: [connector],
      });
      const second = await resumeRun({
        db: h.db, client, orgId: ORG, specText: JSON.stringify(s), runId: 'run-mcp-wt',
        tools: leg2.tools.filter((t) => t.external), legNotes: leg2.legNotes,
      });
      await leg2.close();
      // Step 12 (L2): the approved call is replayed from the record, byte
      // for byte — the model is never asked to re-propose it. That matters
      // here because this run uses the REAL serving route with the mock
      // provider, whose arguments carry an echo of the last message and a
      // fresh seed: the re-proposed call would NEVER have matched what the
      // operator read. What ran is exactly what was approved.
      expect(mcp.requests.filter((r) => r.method === 'tools/call')).toHaveLength(2); // read + one approved act
      expect(second.status).toBe('completed');

      const steps = await listLabSteps(h.db, 'run-mcp-wt', ORG);
      // The bearer echo rides the READ tool's result (get_me returns it), so
      // the redaction proof lives with that run; token absence is asserted
      // across BOTH runs — no surface of either carries it.
      const readDump = JSON.stringify(await listLabSteps(h.db, 'run-mcp-read', ORG));
      const dump = JSON.stringify(steps);
      expect(readDump).not.toContain(GRANT_TOKEN); // died before the checkpoint
      expect(readDump).toContain('[REDACTED:grant]');
      expect(dump).not.toContain(GRANT_TOKEN);

      // The MCP call itself is NOT model spend: no request_logs row carries
      // an MCP completion id (connector-side cost is the operator's own).
      // The model steps DID meter (the real route), proving $0-here ≠ unmetered.
      const modelIds = steps.filter((x) => x.kind === 'model').map((x) => (x.payload as StepPayload).completionId!);
      const logs = await h.db.select().from(requestLogs).where(inArray(requestLogs.completionId, modelIds));
      expect(logs.length).toBe(modelIds.length);

      // REVOKED: the operator cuts the grant; the derivation the form reads
      // (grantConnectionStatus, the ONE derivation) returns 'revoked', and a
      // fresh leg offers no tools (the filament is severed with a cut bar —
      // the draw path proven separately in lab-form form.test.ts).
      await markLabGrantStatus(h.db, ORG, 'github', 'revoked');
      expect(grantConnectionStatus(await getLabGrant(h.db, ORG, 'github'))).toBe('revoked');
      const leg3 = await buildMcpLabTools({
        db: h.db, orgId: ORG, runId: 'run-mcp-wt', masterKey: master, spec: s, connectors: [connector],
      });
      expect(leg3.tools).toEqual([]);
      expect(leg3.legNotes[0]!.note.superpowerUnavailable.status).toBe('revoked');
      await leg3.close();
    } finally {
      await mcp.close();
    }
  }, 120_000);
});
