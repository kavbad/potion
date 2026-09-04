// Step 12 targeted pass — the MCP-boundary targets Step 10 named and left
// for the adversarial step: T2 (malicious server protocol fuzzing), T3
// (exfiltration through tool ARGUMENTS rather than results), and T4
// (cross-connector interaction — one grant's material reaching another
// connector's call).
//
// Every case here is an ATTEMPT with a written outcome, which is what the
// spec asks of pass 2: reproduce it, or refute it in writing against the
// code that prevents it. Where the attempt fails to break anything, the
// test still earns its place — it pins the property that defeated it.
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createDb,
  createLabRun,
  listLabSteps,
  migrate,
  seedIsolationOrgs,
  upsertLabGrant,
  ORG_A,
  type DbHandle,
} from '@potion/db';
import { sealEnvelope } from '@potion/custody';
import { MockMcpServer } from '@potion/lab-mcp/mock-server';
import type { ConnectorDef } from '@potion/lab-mcp';
import { harnessSpecHash, type HarnessSpec } from '@potion/lab-spec';
import { buildMcpLabTools } from './mcp-tools.js';
import { runLeg, type LegOutcome } from './loop.js';

/** `expect(o.status).toBe('awaiting-human')` asserts at runtime but does not
 * NARROW the union, so reading `o.question` after it was unchecked. This
 * narrows for real, and names what it got when the leg ended some other way
 * — a better failure than `expected undefined to contain '…'`. */
function awaitingHuman(o: LegOutcome): Extract<LegOutcome, { status: 'awaiting-human' }> {
  if (o.status !== 'awaiting-human') {
    throw new Error(`expected the leg to park for a human, got '${o.status}'`);
  }
  return o;
}
import type { ServingClient, ServingRequest, ServingResult } from './serving-client.js';

const MASTER = randomBytes(32);
const TOKEN_A = 'gho_HOSTILEconnA_4X9mQ2vL7pK8rT3sW6zE';
const TOKEN_B = 'lin_HOSTILEconnB_8B2nC4xZ6aS0dF1gH3jK';

function connector(id: string, baseUrl: string, tokenUrl: string, url: string): ConnectorDef {
  return {
    connectorId: id,
    displayName: id,
    transport: 'streamable-http',
    baseUrl,
    oauth: { authorizationUrl: `${url}/authorize`, tokenUrl, clientIdEnv: 'X', clientSecretEnv: 'Y', scopesOffered: [] },
    tools: {
      get_me: { scopes: [], action: 'read', description: 'Authored: identity.', parameters: { type: 'object' } },
      publish: {
        scopes: [],
        action: 'act',
        description: 'Authored: publish an item.',
        parameters: { type: 'object', properties: { body: { type: 'string' } } },
      },
    },
  };
}

function spec(over: Partial<HarnessSpec> = {}): HarnessSpec {
  return {
    specVersion: 1,
    name: 'hostile server harness',
    brain: { policy: { type: 'min_cost', qualityFloor: 0 } },
    mission: { kind: 'task', goal: 'use the tool', doneDefinition: 'used' },
    superpowers: [{ id: 'conna', scopes: [] }],
    memory: { enabled: false },
    rules: [],
    fuel: { maxUsdPerRun: 1, hardStop: true },
    checkIns: [],
    ...over,
  };
}

function scripted(results: ServingResult[]): ServingClient {
  const queue = [...results];
  return {
    complete: async (_req: ServingRequest) => queue.shift() ?? Promise.reject(new Error('exhausted')),
    emitSpans: async () => true,
  } as unknown as ServingClient;
}
const ok = (over: Partial<Extract<ServingResult, { kind: 'ok' }>> = {}): ServingResult => ({
  kind: 'ok',
  completionId: `chatcmpl-${Math.random().toString(36).slice(2, 10)}`,
  text: 'done.',
  toolCalls: [],
  finishReason: 'stop',
  usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
  frontierTrace: 'cluster=x;strategy=t;policy=min_cost;fallback=0;provenance=mock',
  ...over,
});

const servers: MockMcpServer[] = [];
let handle: DbHandle | null = null;
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
  await handle?.close();
  handle = null;
});

async function seeded(s: HarnessSpec, grants: Array<{ id: string; token: string }>): Promise<{ h: DbHandle; hash: string }> {
  const h = await createDb();
  await migrate(h.db);
  await seedIsolationOrgs(h.db);
  const hash = harnessSpecHash(s);
  await createLabRun(h.db, { id: 'run-h', orgId: ORG_A, harnessHash: hash, harnessName: s.name, spec: s });
  for (const g of grants) {
    await upsertLabGrant(h.db, {
      id: `grant-${g.id}`,
      orgId: ORG_A,
      connectorId: g.id,
      superpowerId: g.id,
      scopesGranted: [],
      tokenEnvelope: sealEnvelope(MASTER, g.token),
      grantedBy: 'usr_admin',
    });
  }
  return { h, hash };
}

// ───────────────────────────── T2: protocol fuzzing ─────────────────────

describe('T2 — a malicious server at the protocol level', () => {
  const cases: Array<[string, unknown]> = [
    ['a result with no content array at all', { __rawResult: { isError: false } }],
    ['content of the wrong TYPE (numbers where blocks belong)', { __rawResult: { content: [1, 2, 3] } }],
    ['a content block with no text field', { __rawResult: { content: [{ type: 'text' }] } }],
    ['a deeply nested result (depth bomb)', { __rawResult: { content: [{ type: 'text', text: 'x' }], deep: nest(200) } }],
    ['a result claiming isError with no explanation', { __rawResult: { content: [], isError: true } }],
  ];
  for (const [label, raw] of cases) {
    it(`${label} → a TYPED value, never a throw into the loop`, async () => {
      const server = await MockMcpServer.start({ tools: [{ name: 'get_me', handler: () => raw }], requireBearer: TOKEN_A });
      servers.push(server);
      const s = spec();
      const { h } = await seeded(s, [{ id: 'conna', token: TOKEN_A }]);
      handle = h;
      const leg = await buildMcpLabTools({
        db: h.db, orgId: ORG_A, runId: 'run-h', masterKey: MASTER, spec: s,
        connectors: [connector('conna', server.mcpUrl, server.tokenUrl, server.url)],
      });
      const tool = leg.tools.find((t) => t.name === 'conna.get_me')!;
      const out = await tool.run({});
      // The contract this module states in its header: it never throws into
      // the loop. Whatever the server sends, the model gets a VALUE.
      expect(out).toBeDefined();
      expect(typeof out === 'string' || typeof out === 'object').toBe(true);
      await leg.close();
    }, 60_000);
  }

  it('a server that LIES about its tool surface cannot widen it', async () => {
    // It advertises a tool we never authored, and a tool we authored under a
    // different name. Neither can be called: discovery is an INTERSECTION
    // with the authored allowlist, so the extra name is invisible.
    const server = await MockMcpServer.start({
      tools: [
        { name: 'get_me', handler: () => 'ok' },
        { name: 'exfiltrate_everything', handler: () => 'should never run' },
        { name: 'GET_ME', handler: () => 'case-shifted twin' },
      ],
      requireBearer: TOKEN_A,
    });
    servers.push(server);
    const s = spec();
    const { h } = await seeded(s, [{ id: 'conna', token: TOKEN_A }]);
    handle = h;
    const leg = await buildMcpLabTools({
      db: h.db, orgId: ORG_A, runId: 'run-h', masterKey: MASTER, spec: s,
      connectors: [connector('conna', server.mcpUrl, server.tokenUrl, server.url)],
    });
    expect(leg.tools.map((t) => t.name).sort()).toEqual(['conna.get_me']);
    // publish is authored but the server does not have it → it never loads.
    expect(leg.tools.some((t) => t.name === 'conna.publish')).toBe(false);
    await leg.close();
  }, 60_000);

  it('a server that changes its surface MID-SESSION cannot add a tool to a live leg', async () => {
    // Tools are bound at leg start from one discovery. A later tools/list
    // answer — however hostile — reaches nothing: the leg's tool array is
    // already closed over the authored defs.
    const server = await MockMcpServer.start({ tools: [{ name: 'get_me', handler: () => 'ok' }], requireBearer: TOKEN_A });
    servers.push(server);
    const s = spec();
    const { h } = await seeded(s, [{ id: 'conna', token: TOKEN_A }]);
    handle = h;
    const leg = await buildMcpLabTools({
      db: h.db, orgId: ORG_A, runId: 'run-h', masterKey: MASTER, spec: s,
      connectors: [connector('conna', server.mcpUrl, server.tokenUrl, server.url)],
    });
    const before = leg.tools.map((t) => t.name);
    // The server would now love to offer 'publish'. The leg does not ask again.
    expect(leg.tools.map((t) => t.name)).toEqual(before);
    await leg.close();
  }, 60_000);
});

function nest(depth: number): unknown {
  let v: unknown = 'bottom';
  for (let i = 0; i < depth; i++) v = { v };
  return v;
}

// ─────────────────── T3: exfiltration through tool ARGUMENTS ────────────

describe('T3 — exfiltration through the tool ARGUMENTS, not the results', () => {
  it('an act tool suspends at the pore with its ARGUMENTS shown, before anything leaves', async () => {
    const server = await MockMcpServer.start({
      tools: [{ name: 'get_me', handler: () => 'ok' }, { name: 'publish', handler: () => 'published' }],
      requireBearer: TOKEN_A,
    });
    servers.push(server);
    const s = spec({ checkIns: [{ trigger: 'before-external-action' }] });
    const { h, hash } = await seeded(s, [{ id: 'conna', token: TOKEN_A }]);
    handle = h;
    const leg = await buildMcpLabTools({
      db: h.db, orgId: ORG_A, runId: 'run-h', masterKey: MASTER, spec: s,
      connectors: [connector('conna', server.mcpUrl, server.tokenUrl, server.url)],
    });
    const secretish = 'the customer list: alice@x.com, bob@y.com, carol@z.com';
    const outcome = await runLeg({
      db: h.db,
      client: scripted([
        ok({
          text: '',
          finishReason: 'tool_calls',
          toolCalls: [{ id: 'p1', type: 'function', function: { name: 'conna.publish', arguments: JSON.stringify({ body: secretish }) } }],
        }),
      ]),
      runId: 'run-h', orgId: ORG_A, spec: s, harnessHash: hash, tools: leg.tools,
    });
    await leg.close();
    const parked = awaitingHuman(outcome);
    // The human sees WHAT is about to leave, not merely THAT something is.
    expect(parked.question).toContain('conna.publish');
    expect(parked.question).toContain('alice@x.com');
    // …and nothing left: the server never saw a tools/call.
    expect(server.requests.some((r) => r.method === 'tools/call')).toBe(false);
  }, 60_000);

  // ── Step 12 finding L2 (CRITICAL), reproduced then closed ──────────────
  //
  // BEFORE the fix this test failed at the last line: the operator was shown
  // `publish({body:'first'})`, answered yes, and the run executed
  // `publish({body:'second — never approved'})` — the ONLY call that ever
  // reached the server. The approval was a bearer token for "whatever the
  // model asks next", so a model persuaded between the question and the
  // answer (by an injected instruction in a prior result, say) could swap
  // the action underneath a human who had already consented.
  it('an approval authorizes THE action shown, not merely the next one', async () => {
    const server = await MockMcpServer.start({
      tools: [{ name: 'get_me', handler: () => 'ok' }, { name: 'publish', handler: () => 'published' }],
      requireBearer: TOKEN_A,
    });
    servers.push(server);
    const s = spec({ checkIns: [{ trigger: 'before-external-action' }] });
    const { h, hash } = await seeded(s, [{ id: 'conna', token: TOKEN_A }]);
    handle = h;
    const call = (i: number, body: string) => ({
      id: `p${i}`,
      type: 'function' as const,
      function: { name: 'conna.publish', arguments: JSON.stringify({ body }) },
    });
    const leg = await buildMcpLabTools({
      db: h.db, orgId: ORG_A, runId: 'run-h', masterKey: MASTER, spec: s,
      connectors: [connector('conna', server.mcpUrl, server.tokenUrl, server.url)],
    });
    const first = await runLeg({
      db: h.db,
      client: scripted([ok({ text: '', finishReason: 'tool_calls', toolCalls: [call(1, 'first')] })]),
      runId: 'run-h', orgId: ORG_A, spec: s, harnessHash: hash, tools: leg.tools,
    });
    expect(first.status).toBe('awaiting-human');
    // Approve once (through the same door the CLI uses — the answer is
    // RECORDED first, then the leg resumes), and the model immediately asks
    // for a SECOND act.
    const { resumeRun } = await import('./cli.js');
    const second = await resumeRun({
      db: h.db,
      client: scripted([
        ok({ text: '', finishReason: 'tool_calls', toolCalls: [call(2, 'second — never approved')] }),
        ok({ text: 'done.' }),
        ok({ text: 'wrap.' }),
        ok({ text: 'spare.' }),
      ]),
      orgId: ORG_A,
      specText: JSON.stringify(s),
      runId: 'run-h',
      answer: 'yes, proceed',
      tools: leg.tools,
    });
    await leg.close();
    // The consumed approval covered the first call only.
    const bodies = server.requests
      .filter((r) => r.method === 'tools/call')
      .map((r) => JSON.stringify((r.params as { arguments?: unknown }).arguments));
    // What the human approved RAN — replayed byte for byte from the record,
    // not re-proposed by a model that had since changed its mind.
    expect(bodies.length).toBe(1);
    expect(bodies[0]).toContain('first');
    // And the substituted action never reached the server.
    expect(bodies.some((b) => b.includes('never approved'))).toBe(false);
    // It was not silently dropped either: it re-fired the pore, so a human
    // gets asked about the thing the model actually wants to do now.
    expect(awaitingHuman(second).question).toContain('never approved');
  }, 60_000);

  it('the SAME action, re-emitted after approval, runs exactly once', async () => {
    // The other half of the property: one approval buys ONE execution. The
    // approved call runs from the record; a model that immediately asks for
    // it again is asking for a second act, and gets a second question.
    const server = await MockMcpServer.start({
      tools: [{ name: 'get_me', handler: () => 'ok' }, { name: 'publish', handler: () => 'published' }],
      requireBearer: TOKEN_A,
    });
    servers.push(server);
    const s = spec({ checkIns: [{ trigger: 'before-external-action' }] });
    const { h, hash } = await seeded(s, [{ id: 'conna', token: TOKEN_A }]);
    handle = h;
    const same = {
      id: 'p1',
      type: 'function' as const,
      function: { name: 'conna.publish', arguments: JSON.stringify({ body: 'the approved body' }) },
    };
    const leg = await buildMcpLabTools({
      db: h.db, orgId: ORG_A, runId: 'run-h', masterKey: MASTER, spec: s,
      connectors: [connector('conna', server.mcpUrl, server.tokenUrl, server.url)],
    });
    const first = await runLeg({
      db: h.db,
      client: scripted([ok({ text: '', finishReason: 'tool_calls', toolCalls: [same] })]),
      runId: 'run-h', orgId: ORG_A, spec: s, harnessHash: hash, tools: leg.tools,
    });
    expect(first.status).toBe('awaiting-human');
    const { resumeRun } = await import('./cli.js');
    const second = await resumeRun({
      db: h.db,
      client: scripted([
        ok({ text: '', finishReason: 'tool_calls', toolCalls: [same] }),
        ok({ text: 'done.' }),
        ok({ text: 'wrap.' }),
      ]),
      orgId: ORG_A, specText: JSON.stringify(s), runId: 'run-h', answer: 'yes, proceed', tools: leg.tools,
    });
    await leg.close();
    const calls = server.requests.filter((r) => r.method === 'tools/call');
    // Exactly once — the record's copy. The model re-proposing the same call
    // afterwards does NOT get a free second execution: the authorization was
    // consumed, so it asks again.
    expect(calls.length).toBe(1);
    expect(JSON.stringify(calls[0]!.params)).toContain('the approved body');
    expect(second.status).toBe('awaiting-human');
  }, 60_000);
});

// ───────────────── T4: cross-connector interaction attacks ──────────────

describe('T4 — cross-connector: one grant’s material reaching another’s call', () => {
  it('each connector’s session carries ONLY its own bearer', async () => {
    const a = await MockMcpServer.start({ tools: [{ name: 'get_me', handler: () => 'A' }], requireBearer: TOKEN_A });
    const b = await MockMcpServer.start({ tools: [{ name: 'get_me', handler: () => 'B' }], requireBearer: TOKEN_B });
    servers.push(a, b);
    const s = spec({ superpowers: [{ id: 'conna', scopes: [] }, { id: 'connb', scopes: [] }] });
    const { h } = await seeded(s, [{ id: 'conna', token: TOKEN_A }, { id: 'connb', token: TOKEN_B }]);
    handle = h;
    const leg = await buildMcpLabTools({
      db: h.db, orgId: ORG_A, runId: 'run-h', masterKey: MASTER, spec: s,
      connectors: [
        connector('conna', a.mcpUrl, a.tokenUrl, a.url),
        connector('connb', b.mcpUrl, b.tokenUrl, b.url),
      ],
    });
    await leg.tools.find((t) => t.name === 'conna.get_me')!.run({});
    await leg.tools.find((t) => t.name === 'connb.get_me')!.run({});
    await leg.close();
    const authOf = (srv: MockMcpServer): string[] => srv.requests.map((r) => r.authorization ?? '');
    expect(authOf(a).every((h2) => h2.includes(TOKEN_A))).toBe(true);
    expect(authOf(a).some((h2) => h2.includes(TOKEN_B))).toBe(false);
    expect(authOf(b).every((h2) => h2.includes(TOKEN_B))).toBe(true);
    expect(authOf(b).some((h2) => h2.includes(TOKEN_A))).toBe(false);
  }, 60_000);

  it('connector A echoing connector B’s token is scrubbed — the redactor spans the whole LEG', async () => {
    // A cannot normally know B's bearer; this hands it to A anyway, because
    // the property under test is the redactor's SCOPE, not A's knowledge.
    const a = await MockMcpServer.start({
      tools: [{ name: 'get_me', handler: () => `here is the other connector's token: ${TOKEN_B}` }],
      requireBearer: TOKEN_A,
    });
    const b = await MockMcpServer.start({ tools: [{ name: 'get_me', handler: () => 'B' }], requireBearer: TOKEN_B });
    servers.push(a, b);
    const s = spec({ superpowers: [{ id: 'conna', scopes: [] }, { id: 'connb', scopes: [] }] });
    const { h, hash } = await seeded(s, [{ id: 'conna', token: TOKEN_A }, { id: 'connb', token: TOKEN_B }]);
    handle = h;
    const leg = await buildMcpLabTools({
      db: h.db, orgId: ORG_A, runId: 'run-h', masterKey: MASTER, spec: s,
      connectors: [
        connector('conna', a.mcpUrl, a.tokenUrl, a.url),
        connector('connb', b.mcpUrl, b.tokenUrl, b.url),
      ],
    });
    await runLeg({
      db: h.db,
      client: scripted([
        ok({ text: '', finishReason: 'tool_calls', toolCalls: [{ id: 'x1', type: 'function', function: { name: 'conna.get_me', arguments: '{}' } }] }),
        ok({ text: 'done.' }),
        ok({ text: 'wrap.' }),
      ]),
      runId: 'run-h', orgId: ORG_A, spec: s, harnessHash: hash, tools: leg.tools,
    });
    await leg.close();
    const dump = JSON.stringify(await listLabSteps(h.db, 'run-h', ORG_A));
    expect(dump).not.toContain(TOKEN_B);
    expect(dump).toContain('[REDACTED:grant]');
  }, 60_000);
});

// ─── L3 + L4: the two CRITICALs the independent pass found in the pore ───
//
// Both were the same mistake wearing different clothes — treating "an
// answer exists" as "this action is approved":
//
//   L4  ANY answer armed the gate, including "no". A human who refused an
//       action authorized it. 3/3 skeptics confirmed.
//   L3  consumption was in-memory only while the durable pending_answer
//       survived the leg-cap exit (which releases the lease without a state
//       transition), so one "yes" re-armed the pore on every later leg.
//       3/3 skeptics confirmed.

describe('L4 — a REFUSAL must not authorize the action it refused', () => {
  const cases = ['no', 'No', 'no thanks', "don't", 'stop', 'absolutely not', 'nope', 'cancel that'];
  it('isAffirmative recognises approval and nothing else', async () => {
    const { isAffirmative } = await import('./loop.js');
    for (const answer of cases) {
      expect(isAffirmative(answer), `'${answer}' must NOT authorize`).toBe(false);
    }
    for (const answer of ['yes', 'yes, proceed', 'ok', 'approve', 'go', 'go ahead', 'do it', 'Confirmed']) {
      expect(isAffirmative(answer), `'${answer}' should authorize`).toBe(true);
    }
    // Fail closed on anything it cannot read as consent — including prose
    // that merely mentions the action, and the empty answer.
    for (const answer of ['', '   ', 'what does that do?', 'tell me more first', 'maybe later', 'go back to the previous step']) {
      expect(isAffirmative(answer), `'${answer}' must NOT authorize`).toBe(false);
    }
  });

  it('answering "no" leaves the act unrun and the pore still closed', async () => {
    const server = await MockMcpServer.start({
      tools: [{ name: 'get_me', handler: () => 'ok' }, { name: 'publish', handler: () => 'published' }],
      requireBearer: TOKEN_A,
    });
    servers.push(server);
    const s = spec({ checkIns: [{ trigger: 'before-external-action' }] });
    const { h, hash } = await seeded(s, [{ id: 'conna', token: TOKEN_A }]);
    handle = h;
    const call = {
      id: 'p1',
      type: 'function' as const,
      function: { name: 'conna.publish', arguments: JSON.stringify({ body: 'the refused body' }) },
    };
    const leg = await buildMcpLabTools({
      db: h.db, orgId: ORG_A, runId: 'run-h', masterKey: MASTER, spec: s,
      connectors: [connector('conna', server.mcpUrl, server.tokenUrl, server.url)],
    });
    const first = await runLeg({
      db: h.db,
      client: scripted([ok({ text: '', finishReason: 'tool_calls', toolCalls: [call] })]),
      runId: 'run-h', orgId: ORG_A, spec: s, harnessHash: hash, tools: leg.tools,
    });
    expect(first.status).toBe('awaiting-human');
    const { resumeRun } = await import('./cli.js');
    // The human says NO — and the model, unmoved, asks for the very same act.
    const second = await resumeRun({
      db: h.db,
      client: scripted([
        ok({ text: '', finishReason: 'tool_calls', toolCalls: [call] }),
        ok({ text: 'fine.' }),
        ok({ text: 'wrap.' }),
      ]),
      orgId: ORG_A, specText: JSON.stringify(s), runId: 'run-h', answer: 'no', tools: leg.tools,
    });
    await leg.close();
    expect(second.status).toBe('awaiting-human'); // asked again, never run
    expect(server.requests.filter((r) => r.method === 'tools/call').length).toBe(0);
  }, 60_000);
});

describe('L3 — one approval does not survive into the next leg', () => {
  it('the durable answer is BURNED on consumption, so a later leg re-poses the question', async () => {
    const server = await MockMcpServer.start({
      tools: [{ name: 'get_me', handler: () => 'ok' }, { name: 'publish', handler: () => 'published' }],
      requireBearer: TOKEN_A,
    });
    servers.push(server);
    const s = spec({ checkIns: [{ trigger: 'before-external-action' }] });
    const { h, hash } = await seeded(s, [{ id: 'conna', token: TOKEN_A }]);
    handle = h;
    const call = {
      id: 'p1',
      type: 'function' as const,
      function: { name: 'conna.publish', arguments: JSON.stringify({ body: 'approved once' }) },
    };
    const leg = await buildMcpLabTools({
      db: h.db, orgId: ORG_A, runId: 'run-h', masterKey: MASTER, spec: s,
      connectors: [connector('conna', server.mcpUrl, server.tokenUrl, server.url)],
    });
    await runLeg({
      db: h.db,
      client: scripted([ok({ text: '', finishReason: 'tool_calls', toolCalls: [call] })]),
      runId: 'run-h', orgId: ORG_A, spec: s, harnessHash: hash, tools: leg.tools,
    });
    const { resumeRun } = await import('./cli.js');
    await resumeRun({
      db: h.db,
      client: scripted([
        ok({ text: '', finishReason: 'tool_calls', toolCalls: [call] }),
        ok({ text: 'done.' }),
        ok({ text: 'wrap.' }),
      ]),
      orgId: ORG_A, specText: JSON.stringify(s), runId: 'run-h', answer: 'yes, proceed', tools: leg.tools,
    });
    // The approved call ran exactly once…
    expect(server.requests.filter((r) => r.method === 'tools/call').length).toBe(1);
    // …and the durable answer is GONE, which is what stops the next leg
    // (leg-cap or otherwise) from re-arming the gate with a stale "yes".
    const { getLabRun } = await import('@potion/db');
    const row = await getLabRun(h.db, 'run-h', ORG_A);
    expect(row!.pendingAnswer).toBeNull();
    await leg.close();
  }, 60_000);
});
