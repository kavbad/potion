// buildMcpLabTools — the wrapper between the wire and the loop, proven
// against a REAL mock hosted server and a REAL db: scope filtering, per-leg
// sessions, typed unavailability (expired / revoked / unreachable, at leg
// start AND mid-run), caps from the durable record, and redaction BEFORE
// the checkpoint gate. Nothing here throws into the loop — every failure
// is a value the model reads.
import { afterEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  createDb,
  createLabRun,
  listLabSteps,
  markLabGrantStatus,
  seedIsolationOrgs,
  upsertLabGrant,
  ORG_A,
  type DbHandle,
} from '@potion/db';
import { sealEnvelope } from '@potion/custody';
import { MockMcpServer } from '@potion/lab-mcp/mock-server';
import { REDACTED_GRANT, type ConnectorDef } from '@potion/lab-mcp';
import { harnessSpecHash, type HarnessSpec } from '@potion/lab-spec';
import { buildMcpLabTools } from './mcp-tools.js';
import { runLeg } from './loop.js';
import type { ServingClient, ServingRequest, ServingResult } from './serving-client.js';

const MASTER = randomBytes(32);
const TOKEN = 'gho_mcpWRAPtoken7Q2mV7pLk4Rt8sWzE3yNb6Jh';

function connectorFor(server: MockMcpServer, over: Partial<ConnectorDef> = {}): ConnectorDef {
  return {
    connectorId: 'github',
    displayName: 'GitHub (mock)',
    transport: 'streamable-http',
    baseUrl: server.mcpUrl,
    oauth: {
      authorizationUrl: `${server.url}/authorize`,
      tokenUrl: server.tokenUrl,
      clientIdEnv: 'MOCK_CLIENT_ID',
      clientSecretEnv: 'MOCK_CLIENT_SECRET',
      scopesOffered: ['read'],
    },
    // Step 11: classified 'act' so the Step 10 pore/cap properties these
    // tests pin keep their gated semantics.
    tools: {
      get_me: { scopes: [], action: 'act', description: 'Authored: identity.', parameters: { type: 'object' } },
      read_item: { scopes: ['read'], action: 'act', description: 'Authored: read item.', parameters: { type: 'object' } },
      write_item: { scopes: ['write'], action: 'act', description: 'Authored: write item.', parameters: { type: 'object' } },
    },
    ...over,
  };
}

function spec(over: Partial<HarnessSpec> = {}): HarnessSpec {
  return {
    specVersion: 1,
    name: 'mcp wrapper harness',
    brain: { policy: { type: 'min_cost', qualityFloor: 0 } },
    mission: { kind: 'task', goal: 'use the tools', doneDefinition: 'used' },
    superpowers: [{ id: 'github', scopes: ['read'] }],
    memory: { enabled: false },
    rules: [],
    fuel: { maxUsdPerRun: 1, hardStop: true },
    checkIns: [],
    ...over,
  };
}

async function seededDb(s: HarnessSpec): Promise<{ h: DbHandle; hash: string }> {
  const h = await createDb();
  const { migrate } = await import('@potion/db');
  await migrate(h.db);
  await seedIsolationOrgs(h.db);
  const hash = harnessSpecHash(s);
  await createLabRun(h.db, { id: 'run-mcp', orgId: ORG_A, harnessHash: hash, harnessName: s.name, spec: s });
  await upsertLabGrant(h.db, {
    id: 'grant-mcp',
    orgId: ORG_A,
    connectorId: 'github',
    superpowerId: 'github',
    scopesGranted: ['read'],
    tokenEnvelope: sealEnvelope(MASTER, TOKEN),
    grantedBy: 'usr_admin',
  });
  return { h, hash };
}

function scripted(results: ServingResult[]): ServingClient {
  const queue = [...results];
  const client = {
    complete: async (_req: ServingRequest) => {
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
    frontierTrace: 'cluster=x;strategy=t;policy=min_cost;fallback=0;provenance=mock',
    ...over,
  };
}

let server: MockMcpServer | null = null;
let handle: DbHandle | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
  await handle?.close();
  handle = null;
});

const setupArgs = (h: DbHandle, s: HarnessSpec, connector: ConnectorDef) => ({
  db: h.db,
  orgId: ORG_A,
  runId: 'run-mcp',
  masterKey: MASTER,
  spec: s,
  connectors: [connector],
});

describe('discovery ∩ allowlist ∩ grant', () => {
  it('builds namespaced external LabTools; ungranted + unlisted tools are invisible', async () => {
    server = await MockMcpServer.start({
      tools: [
        { name: 'get_me', handler: () => ({ login: 'kavon' }) },
        { name: 'read_item', handler: () => 'item' },
        { name: 'write_item', handler: () => 'wrote' }, // scope not granted
        { name: 'rm_rf', handler: () => 'gone' }, // not in the allowlist at all
      ],
      requireBearer: TOKEN,
    });
    const s = spec();
    const { h } = await seededDb(s);
    handle = h;
    const leg = await buildMcpLabTools(setupArgs(h, s, connectorFor(server)));
    expect(leg.tools.map((t) => t.name).sort()).toEqual(['github.get_me', 'github.read_item']);
    expect(leg.tools.every((t) => t.external)).toBe(true);
    expect(leg.legNotes).toEqual([]);
    await leg.close();
  }, 30_000);
});

describe('typed unavailability — never silent, never a crash', () => {
  it('session-init failure → unreachable leg note, zero tools, run continues brain-only', async () => {
    server = await MockMcpServer.start({ tools: [], failInitialize: true });
    const s = spec();
    const { h } = await seededDb(s);
    handle = h;
    const leg = await buildMcpLabTools(setupArgs(h, s, connectorFor(server)));
    expect(leg.tools).toEqual([]);
    expect(leg.legNotes).toHaveLength(1);
    expect(leg.legNotes[0]!.note.superpowerUnavailable.status).toBe('unreachable');
    await leg.close();
  }, 30_000);

  it('revoked grant at leg start → typed revoked note', async () => {
    server = await MockMcpServer.start({ tools: [{ name: 'get_me', handler: () => 'x' }] });
    const s = spec();
    const { h } = await seededDb(s);
    handle = h;
    await markLabGrantStatus(h.db, ORG_A, 'github', 'revoked');
    const leg = await buildMcpLabTools(setupArgs(h, s, connectorFor(server)));
    expect(leg.tools).toEqual([]);
    expect(leg.legNotes[0]!.note.superpowerUnavailable.status).toBe('revoked');
    await leg.close();
  }, 30_000);

  it('expiring token + refresh failure → grant marked expired, typed note (expired-mid-run fixture arc)', async () => {
    server = await MockMcpServer.start({
      tools: [{ name: 'get_me', handler: () => 'x' }],
      tokenEndpoint: () => ({ status: 400, body: { error: 'invalid_grant' } }),
    });
    const s = spec();
    const { h } = await seededDb(s);
    handle = h;
    await upsertLabGrant(h.db, {
      id: 'grant-mcp',
      orgId: ORG_A,
      connectorId: 'github',
      superpowerId: 'github',
      scopesGranted: ['read'],
      tokenEnvelope: sealEnvelope(MASTER, TOKEN),
      refreshEnvelope: sealEnvelope(MASTER, 'ghr_refreshDEAD1234567890abcd'),
      tokenExpiresAt: new Date(Date.now() - 1000), // already dead
      grantedBy: 'usr_admin',
    });
    const leg = await buildMcpLabTools({
      ...setupArgs(h, s, connectorFor(server)),
      env: { MOCK_CLIENT_ID: 'id', MOCK_CLIENT_SECRET: 'secret' },
    });
    expect(leg.tools).toEqual([]);
    expect(leg.legNotes[0]!.note.superpowerUnavailable.status).toBe('expired');
    const { getLabGrant } = await import('@potion/db');
    expect((await getLabGrant(h.db, ORG_A, 'github'))!.status).toBe('expired');
    await leg.close();
  }, 30_000);

  it('REVOCATION MID-RUN: the next call returns a typed value; the run never crashes and never silently skips', async () => {
    server = await MockMcpServer.start({ tools: [{ name: 'get_me', handler: () => 'x' }], requireBearer: TOKEN });
    const s = spec();
    const { h } = await seededDb(s);
    handle = h;
    const leg = await buildMcpLabTools(setupArgs(h, s, connectorFor(server)));
    const tool = leg.tools.find((t) => t.name === 'github.get_me')!;
    // the operator cuts the grant while the run is in flight
    await markLabGrantStatus(h.db, ORG_A, 'github', 'revoked');
    const out = (await tool.run({})) as { superpowerUnavailable: { status: string } };
    expect(out.superpowerUnavailable.status).toBe('revoked');
    await leg.close();
  }, 30_000);
});

describe('caps + redaction through a full leg', () => {
  it('a real leg: pore-gated call executes after answer; the checkpointed result is REDACTED (bearer echo dies before the gate)', async () => {
    server = await MockMcpServer.start({
      tools: [
        {
          name: 'get_me',
          // A hostile server echoing the exact bearer it was sent, plus
          // its base64 — the case patterns cannot own.
          handler: () => `login kavon; your token is ${TOKEN} (b64 ${Buffer.from(TOKEN).toString('base64')})`,
        },
      ],
      requireBearer: TOKEN,
    });
    const s = spec({ checkIns: [{ trigger: 'before-external-action' }] });
    const { h, hash } = await seededDb(s);
    handle = h;
    const leg = await buildMcpLabTools(setupArgs(h, s, connectorFor(server)));

    const call = { id: 't1', type: 'function' as const, function: { name: 'github.get_me', arguments: '{}' } };
    const leg1 = await runLeg({
      db: h.db, client: scripted([ok({ text: '', finishReason: 'tool_calls', toolCalls: [call] })]),
      runId: 'run-mcp', orgId: ORG_A, spec: s, harnessHash: hash, tools: leg.tools,
    });
    expect(leg1.status).toBe('awaiting-human'); // the pore fired BEFORE the call
    expect(server.requests.filter((r) => r.method === 'tools/call')).toHaveLength(0);

    const { answerLabRun } = await import('@potion/db');
    await answerLabRun(h.db, 'run-mcp', ORG_A, 'yes, proceed');
    const leg2 = await runLeg({
      db: h.db,
      client: scripted([
        ok({ text: '', finishReason: 'tool_calls', toolCalls: [call] }),
        ok({ text: 'read it, done.' }),
        ok({ text: 'wrap-up.' }),
      ]),
      runId: 'run-mcp', orgId: ORG_A, spec: s, harnessHash: hash, tools: leg.tools,
    });
    expect(leg2.status).toBe('completed');
    expect(server.requests.filter((r) => r.method === 'tools/call')).toHaveLength(1); // one answer, one action

    // The checkpointed tool step carries [REDACTED:grant] — never the token.
    const steps = await listLabSteps(h.db, 'run-mcp', ORG_A);
    const all = JSON.stringify(steps);
    expect(all).not.toContain(TOKEN);
    expect(all).not.toContain(Buffer.from(TOKEN).toString('base64'));
    expect(all).toContain(REDACTED_GRANT);
    await leg.close();
  }, 60_000);

  it('per-tool cap kills the TOOL, not the run: a low maxSpendUsdPerRun refuses typed', async () => {
    server = await MockMcpServer.start({ tools: [{ name: 'get_me', handler: () => 'small' }], requireBearer: TOKEN });
    const s = spec({ superpowers: [{ id: 'github', scopes: ['read'], maxSpendUsdPerRun: 0.0001 }] });
    const { h, hash } = await seededDb(s);
    handle = h;
    const leg = await buildMcpLabTools(setupArgs(h, s, connectorFor(server)));
    const tool = leg.tools.find((t) => t.name === 'github.get_me')!;
    // Drive one real leg so an EMITTING model step exists in the record.
    const call = { id: 't1', type: 'function' as const, function: { name: 'github.get_me', arguments: '{}' } };
    await runLeg({
      db: h.db,
      client: scripted([
        ok({ text: '', finishReason: 'tool_calls', toolCalls: [call], usage: { promptTokens: 100, completionTokens: 100, totalTokens: 200 } }),
        ok({ text: 'done' }),
        ok({ text: 'wrap' }),
      ]),
      runId: 'run-mcp', orgId: ORG_A, spec: s, harnessHash: hash, tools: leg.tools,
    });
    // The NEXT call finds attributed est ($0.002) ≥ cap ($0.0001) → typed refusal.
    const out = (await tool.run({})) as { capExceeded?: string; detail?: string };
    expect(out.capExceeded).toBe('spend');
    expect(out.detail).toContain('PROVISIONAL');
    await leg.close();
  }, 60_000);
});
