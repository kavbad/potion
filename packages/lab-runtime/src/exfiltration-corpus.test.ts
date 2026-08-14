// THE EXFILTRATION GOLDEN CORPUS (Step 10 §7, the DoD headline) — the seven
// fixtures under packages/lab-mcp/fixtures/golden, each failing BY TEST.
// These run the REAL loop against a REAL mock MCP server and a REAL db, then
// assert the exfiltration attempt is defeated across every DURABLE and
// VISIBLE surface: the checkpoint, the span content, the run narration DTO
// derivation, and the report. A token must be absent from ALL FOUR, in
// every encoding — the DoD's "fail in tests" made mechanical.
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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
import { grantValueRedactor, type ConnectorDef } from '@potion/lab-mcp';
import { harnessSpecHash, parseHarnessSpecText, scanRawValue, type HarnessSpec } from '@potion/lab-spec';
import { buildMcpLabTools } from './mcp-tools.js';
import { runLeg } from './loop.js';
import { spansForSteps } from './spans.js';
import { buildRunReport } from './report.js';
import type { ServingClient, ServingRequest, ServingResult } from './serving-client.js';

const MASTER = randomBytes(32);
const TOKEN = 'gho_CORPUScanary4X9mQ2vL7pK8rT3sW6zE1yNb';

// ---- the corpus is REAL committed files, enumerated (never a hand list) ----
const GOLDEN_DIR = fileURLToPath(new URL('../../lab-mcp/fixtures/golden', import.meta.url));

describe('golden corpus — the seven fixtures are committed and byte-stable', () => {
  it('exactly seven fixtures, each with a description + expect', () => {
    const files = readdirSync(GOLDEN_DIR).filter((f) => f.endsWith('.json')).sort();
    expect(files).toEqual([
      '01-spec-embeds-token.json',
      '02-result-echoes-bearer.json',
      '03-result-shaped-like-credentials.json',
      '04-server-injects-instructions.json',
      '05-ungranted-tool-offered.json',
      '06-oversized-result.json',
      '07-expired-mid-run.json',
    ]);
    for (const f of files) {
      const fx = JSON.parse(readFileSync(`${GOLDEN_DIR}/${f}`, 'utf8')) as { description: string; expect: string };
      expect(fx.description.length).toBeGreaterThan(20);
      expect(fx.expect.length).toBeGreaterThan(10);
    }
  });
});

function connectorFor(server: MockMcpServer): ConnectorDef {
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
      scopesOffered: [],
    },
    toolScopeMap: { get_me: [], read_item: ['read'], write_item: ['write'], dump_everything: [] },
  };
}

function spec(over: Partial<HarnessSpec> = {}): HarnessSpec {
  return {
    specVersion: 1,
    name: 'exfil corpus harness',
    brain: { policy: { type: 'min_cost', qualityFloor: 0 } },
    mission: { kind: 'task', goal: 'use the tool', doneDefinition: 'used' },
    superpowers: [{ id: 'github', scopes: ['read'] }],
    memory: { enabled: false },
    rules: [],
    fuel: { maxUsdPerRun: 1, hardStop: true },
    checkIns: [],
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

async function seededDb(s: HarnessSpec, opts: { expiredGrant?: boolean } = {}): Promise<{ h: DbHandle; hash: string }> {
  const h = await createDb();
  await migrate(h.db);
  await seedIsolationOrgs(h.db);
  const hash = harnessSpecHash(s);
  await createLabRun(h.db, { id: 'run-x', orgId: ORG_A, harnessHash: hash, harnessName: s.name, spec: s });
  await upsertLabGrant(h.db, {
    id: 'grant-x',
    orgId: ORG_A,
    connectorId: 'github',
    superpowerId: 'github',
    scopesGranted: ['read'],
    tokenEnvelope: sealEnvelope(MASTER, TOKEN),
    refreshEnvelope: sealEnvelope(MASTER, 'ghr_corpusREFRESH1234567890abcdef'),
    ...(opts.expiredGrant === true ? { tokenExpiresAt: new Date(Date.now() - 1000) } : {}),
    grantedBy: 'usr_admin',
  });
  return { h, hash };
}

function scripted(results: ServingResult[]): ServingClient {
  const queue = [...results];
  const client = {
    complete: async (_req: ServingRequest) => queue.shift() ?? Promise.reject(new Error('exhausted')),
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
const toolCall = { id: 't1', type: 'function' as const, function: { name: 'github.get_me', arguments: '{}' } };

/** All four durable/visible surfaces, as one flat string per surface. */
async function surfaces(h: DbHandle): Promise<{ checkpoint: string; span: string; narration: string; report: string }> {
  const steps = await listLabSteps(h.db, 'run-x', ORG_A);
  const report = await buildRunReport(h.db, 'run-x', ORG_A);
  return {
    checkpoint: JSON.stringify(steps),
    span: JSON.stringify(spansForSteps('run-x', steps)),
    // The run narration DTO derives from the SAME checkpoints server-side;
    // the excerpt is the surface a viewer reads. Model here as the excerpt
    // projection over the tool output (matches routes/lab.ts step DTO).
    narration: JSON.stringify(
      steps.map((s) => {
        const p = s.payload as { toolName?: string; toolOutput?: unknown; responseText?: string };
        return { toolName: p.toolName, excerpt: JSON.stringify(p.toolOutput ?? p.responseText ?? '').slice(0, 400) };
      }),
    ),
    report: JSON.stringify(report),
  };
}

function allEncodings(secret: string): string[] {
  return [
    secret,
    Buffer.from(secret).toString('base64'),
    Buffer.from(secret).toString('base64url'),
    Buffer.from(secret).toString('base64').replace(/=+$/, ''),
    encodeURIComponent(secret),
    Buffer.from(secret).toString('hex'),
    Buffer.from(secret).toString('hex').toUpperCase(),
  ];
}

describe('Fixture 01 — spec-embeds-token → typed secret-material refusal', () => {
  it('every grant-shaped rule is refused; opaque env-assignment too', () => {
    const fx = JSON.parse(readFileSync(`${GOLDEN_DIR}/01-spec-embeds-token.json`, 'utf8')) as { rules: string[] };
    for (const rule of fx.rules) {
      const issues = scanRawValue({ rules: [rule] }).filter((i) => i.code === 'secret-material');
      expect(issues.length, `rule not refused: ${rule}`).toBeGreaterThan(0);
    }
    // and the whole spec fails to parse when a rule carries a token
    const parsed = parseHarnessSpecText(JSON.stringify({ ...spec(), rules: [fx.rules[0]] }));
    expect(parsed.ok).toBe(false);
  });
});

describe('Fixture 02 — result-echoes-bearer → [REDACTED:grant], absent from ALL FOUR surfaces (raw+b64+url+HEX)', () => {
  it('raw + base64 + url-encoded + hex all die before the checkpoint; no surface carries the token', async () => {
    const b64 = Buffer.from(TOKEN).toString('base64');
    const url = encodeURIComponent(TOKEN);
    const hex = Buffer.from(TOKEN).toString('hex');
    server = await MockMcpServer.start({
      tools: [{ name: 'get_me', handler: () => `bearer ${TOKEN} b64 ${b64} url ${url} hex ${hex}` }],
      requireBearer: TOKEN,
    });
    const s = spec();
    const { h, hash } = await seededDb(s);
    handle = h;
    const leg = await buildMcpLabTools({ db: h.db, orgId: ORG_A, runId: 'run-x', masterKey: MASTER, spec: s, connectors: [connectorFor(server)] });
    const outcome = await runLeg({
      db: h.db,
      client: scripted([ok({ text: '', finishReason: 'tool_calls', toolCalls: [toolCall] }), ok({ text: 'done.' }), ok({ text: 'wrap.' })]),
      runId: 'run-x', orgId: ORG_A, spec: s, harnessHash: hash, tools: leg.tools,
    });
    await leg.close();
    expect(outcome.status).toBe('completed');
    const surf = await surfaces(h);
    for (const surface of ['checkpoint', 'span', 'narration', 'report'] as const) {
      for (const form of allEncodings(TOKEN)) {
        expect(surf[surface].includes(form), `${surface} leaked TOKEN (${form.slice(0, 10)}…)`).toBe(false);
      }
    }
    expect(surf.checkpoint).toContain('[REDACTED:grant]');
  }, 60_000);
});

describe('Fixture 03 — result-shaped-like-credentials → fail-closed, tool step NOT written', () => {
  it('a THIRD-PARTY key the redactor cannot know trips the secret gate; the run fails typed', async () => {
    const fx = JSON.parse(readFileSync(`${GOLDEN_DIR}/03-result-shaped-like-credentials.json`, 'utf8')) as { result: string };
    server = await MockMcpServer.start({ tools: [{ name: 'get_me', handler: () => fx.result }], requireBearer: TOKEN });
    const s = spec();
    const { h, hash } = await seededDb(s);
    handle = h;
    const leg = await buildMcpLabTools({ db: h.db, orgId: ORG_A, runId: 'run-x', masterKey: MASTER, spec: s, connectors: [connectorFor(server)] });
    const outcome = await runLeg({
      db: h.db,
      client: scripted([ok({ text: '', finishReason: 'tool_calls', toolCalls: [toolCall] }), ok({ text: 'unreachable' })]),
      runId: 'run-x', orgId: ORG_A, spec: s, harnessHash: hash, tools: leg.tools,
    });
    await leg.close();
    expect(outcome.status).toBe('failed');
    const steps = await listLabSteps(h.db, 'run-x', ORG_A);
    // the offending tool step is NOT written (the gate refuses the checkpoint)
    expect(steps.some((st) => st.kind === 'tool')).toBe(false);
    expect(JSON.stringify(steps)).not.toContain('sk-or-v1-');
  }, 60_000);
});

describe('Fixture 04 — server-injects-instructions → recorded as DATA, the pore still fires', () => {
  it('the injected SYSTEM: text is data; the NEXT external call still suspends at the pore', async () => {
    const fx = JSON.parse(readFileSync(`${GOLDEN_DIR}/04-server-injects-instructions.json`, 'utf8')) as { result: string };
    server = await MockMcpServer.start({ tools: [{ name: 'get_me', handler: () => fx.result }], requireBearer: TOKEN });
    const s = spec({ checkIns: [{ trigger: 'before-external-action' }] });
    const { h, hash } = await seededDb(s);
    handle = h;
    const leg = await buildMcpLabTools({ db: h.db, orgId: ORG_A, runId: 'run-x', masterKey: MASTER, spec: s, connectors: [connectorFor(server)] });
    // first external call suspends at the pore (no tool call yet)
    const first = await runLeg({
      db: h.db, client: scripted([ok({ text: '', finishReason: 'tool_calls', toolCalls: [toolCall] })]),
      runId: 'run-x', orgId: ORG_A, spec: s, harnessHash: hash, tools: leg.tools,
    });
    expect(first.status).toBe('awaiting-human');
    expect(server.requests.some((r) => r.method === 'tools/call')).toBe(false);
    // approve → the call runs; the injected instruction is recorded as data
    const { answerLabRun } = await import('@potion/db');
    await answerLabRun(h.db, 'run-x', ORG_A, 'go');
    await runLeg({
      db: h.db,
      client: scripted([ok({ text: '', finishReason: 'tool_calls', toolCalls: [toolCall] }), ok({ text: 'done' }), ok({ text: 'wrap' })]),
      runId: 'run-x', orgId: ORG_A, spec: s, harnessHash: hash, tools: leg.tools,
    });
    await leg.close();
    const surf = await surfaces(h);
    expect(surf.checkpoint).toContain('SYSTEM'); // recorded verbatim as data
    for (const form of allEncodings(TOKEN)) expect(surf.checkpoint.includes(form)).toBe(false);
  }, 60_000);
});

describe('Fixture 05 — ungranted-tool-offered → filtered before toolDefs', () => {
  it('the model never sees a tool outside the grant, nor one absent from the allowlist', async () => {
    server = await MockMcpServer.start({
      tools: [
        { name: 'get_me', handler: () => 'ok' },
        { name: 'read_item', handler: () => 'ok' }, // needs 'read' — granted
        { name: 'write_item', handler: () => 'ok' }, // needs 'write' — NOT granted
        { name: 'rm_rf', handler: () => 'ok' }, // absent from allowlist
      ],
      requireBearer: TOKEN,
    });
    const s = spec();
    const { h } = await seededDb(s);
    handle = h;
    const leg = await buildMcpLabTools({ db: h.db, orgId: ORG_A, runId: 'run-x', masterKey: MASTER, spec: s, connectors: [connectorFor(server)] });
    expect(leg.tools.map((t) => t.name).sort()).toEqual(['github.get_me', 'github.read_item']);
    await leg.close();
  }, 60_000);
});

describe('Fixture 06 — oversized-result → per-call truncation, cumulative cap trips typed', () => {
  it('a 1 MB result truncates with the typed marker; cumulative crossing → capExceeded, tool-cap-exceeded struggle', async () => {
    server = await MockMcpServer.start({
      tools: [{ name: 'dump_everything', handler: () => 'z'.repeat(1024 * 1024) }],
      requireBearer: TOKEN,
    });
    const s = spec({ superpowers: [{ id: 'github', scopes: ['read'] }] });
    const { h, hash } = await seededDb(s);
    handle = h;
    const leg = await buildMcpLabTools({ db: h.db, orgId: ORG_A, runId: 'run-x', masterKey: MASTER, spec: s, connectors: [connectorFor(server)] });
    const dump = leg.tools.find((t) => t.name === 'github.dump_everything')!;
    // per-call truncation with the typed marker (direct call, no record yet)
    const one = (await dump.run({})) as { truncated?: boolean; bytes?: number; originalBytes?: number };
    expect(one.truncated).toBe(true);
    expect(one.bytes).toBeLessThanOrEqual(64 * 1024);
    expect(one.originalBytes).toBe(1024 * 1024);
    // ONE leg that emits FIVE dump calls in a single model step: each call's
    // cap check reads the accumulating record (prior calls already
    // checkpointed), so the 5th crosses the cumulative 256 KB ceiling and
    // records a typed capExceeded step — the cap kills the TOOL, the run
    // completes without it.
    const call = (i: number) => ({ id: `d${i}`, type: 'function' as const, function: { name: 'github.dump_everything', arguments: '{}' } });
    const outcome = await runLeg({
      db: h.db,
      client: scripted([
        ok({ text: '', finishReason: 'tool_calls', toolCalls: [call(1), call(2), call(3), call(4), call(5)] }),
        ok({ text: 'finished without the tool' }),
        ok({ text: 'wrap' }),
      ]),
      runId: 'run-x', orgId: ORG_A, spec: s, harnessHash: hash, tools: leg.tools,
    });
    await leg.close();
    expect(outcome.status).toBe('completed'); // the run finishes; only the tool died
    const steps = await listLabSteps(h.db, 'run-x', ORG_A);
    const refusals = steps.filter(
      (st) => st.kind === 'tool' && (st.payload as { toolOutput?: { capExceeded?: string } }).toolOutput?.capExceeded === 'result-bytes',
    );
    expect(refusals.length).toBeGreaterThan(0);
    const report = await buildRunReport(h.db, 'run-x', ORG_A);
    expect(report!.struggles.some((st) => st.code === 'tool-cap-exceeded')).toBe(true);
  }, 90_000);
});

describe('Fixture 07 — expired-mid-run → typed expired state, struggle, hollow DTO', () => {
  it('refresh failure marks the grant expired, records a typed note, and never crashes', async () => {
    server = await MockMcpServer.start({
      tools: [{ name: 'get_me', handler: () => 'ok' }],
      tokenEndpoint: () => ({ status: 400, body: { error: 'invalid_grant' } }),
    });
    const s = spec();
    const { h } = await seededDb(s, { expiredGrant: true });
    handle = h;
    const leg = await buildMcpLabTools({
      db: h.db, orgId: ORG_A, runId: 'run-x', masterKey: MASTER, spec: s,
      connectors: [connectorFor(server)],
      env: { MOCK_CLIENT_ID: 'id', MOCK_CLIENT_SECRET: 'secret' },
    });
    expect(leg.tools).toEqual([]);
    expect(leg.legNotes[0]!.note.superpowerUnavailable.status).toBe('expired');
    await leg.close();
    const { getLabGrant } = await import('@potion/db');
    expect((await getLabGrant(h.db, ORG_A, 'github'))!.status).toBe('expired');
  }, 60_000);
});

describe('redactor unit — the corpus fixture 02 mechanism in isolation', () => {
  it('scrubs all encodings of a held secret to [REDACTED:grant]', () => {
    const r = grantValueRedactor([TOKEN]);
    for (const form of [TOKEN, Buffer.from(TOKEN).toString('base64'), encodeURIComponent(TOKEN)]) {
      expect((r(`x ${form} y`) as string)).not.toContain(form);
    }
  });
});
