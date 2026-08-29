// BYO-MCP (2026-08-28) — the genius door's laws, over HTTP:
//   · probe opens ONE MCP session and returns the pinned surface (nothing
//     stored) — SSRF guard first, caps and custody scans on what came back;
//   · register RE-probes server-side (the pin is what Potion saw, never a
//     client echo), stores the row, seals the bearer into the grants table;
//   · the catalog GET carries the org's own endpoints in a `custom` list;
//   · delete revokes the grant and drops the row;
//   · admin-only, slugs can't shadow the catalog, key-shaped tool text refuses.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sha256 } from '@potion/core';
import {
  createDb,
  createMembership,
  createOrg,
  createSession,
  createUser,
  listLabCustomConnectors,
  listLabGrants,
  labSuperpowerGrants,
  migrate,
  type DbHandle,
} from '@potion/db';
import { MockMcpServer } from '@potion/lab-mcp/mock-server';
import { customConnectorDef } from '@potion/lab-mcp';
import { probeMcpEndpoint, PROBE_LIMITS } from '../src/custom-mcp.js';
import { buildServer } from '../src/server.js';

const ORG = 'org_byo_mcp';
const ADMIN_COOKIE = 'potion_session=ps_byo_admin';
const MEMBER_COOKIE = 'potion_session=ps_byo_member';
const BYO_URL = 'https://byo.example/mcp';

let h: DbHandle;
let app: FastifyInstance;
let mock: MockMcpServer;
let devAuthBefore: string | undefined;

// The probe's SSRF guard resolves hostnames for real; tests must not touch
// the network. The fake public host resolves to a documentation address and
// the fetch rewrites it onto the in-process mock server.
const lookupImpl = async (host: string) =>
  host === 'byo.example' ? { address: '203.0.113.10' } : { address: '127.0.0.1' };
const rewriteFetch: typeof fetch = (input, init) =>
  fetch(String(input).replace('https://byo.example/mcp', mock.mcpUrl), init);

beforeAll(async () => {
  devAuthBefore = process.env.POTION_DEV_AUTH;
  process.env.POTION_DEV_AUTH = '0';
  h = await createDb();
  await migrate(h.db);
  await createOrg(h.db, { id: ORG, name: 'BYO Org' });
  await createUser(h.db, { id: 'usr_byo_a', email: 'a@byo.dev', name: 'a' });
  await createUser(h.db, { id: 'usr_byo_m', email: 'm@byo.dev', name: 'm' });
  await createMembership(h.db, { orgId: ORG, userId: 'usr_byo_a', role: 'admin' });
  await createMembership(h.db, { orgId: ORG, userId: 'usr_byo_m', role: 'member' });
  const exp = new Date(Date.now() + 3600_000);
  await createSession(h.db, { id: 'ses_byo_a', userId: 'usr_byo_a', tokenHash: sha256('ps_byo_admin'), orgId: ORG, expiresAt: exp });
  await createSession(h.db, { id: 'ses_byo_m', userId: 'usr_byo_m', tokenHash: sha256('ps_byo_member'), orgId: ORG, expiresAt: exp });
  mock = await MockMcpServer.start({
    tools: [
      { name: 'crm_lookup', description: 'Look up a customer record by email.', inputSchema: { type: 'object', properties: { email: { type: 'string' } } }, handler: () => 'ok' },
      { name: 'crm_update', description: 'Update a customer record.', handler: () => 'ok' },
    ],
    requireBearer: 'byo-secret-bearer',
  });
  app = await buildServer({ db: h, labProbeDeps: { fetchImpl: rewriteFetch, lookupImpl } });
}, 120_000);

afterAll(async () => {
  await app.close();
  await mock.close();
  await h.close();
  if (devAuthBefore === undefined) delete process.env.POTION_DEV_AUTH;
  else process.env.POTION_DEV_AUTH = devAuthBefore;
});

describe('probeMcpEndpoint (unit)', () => {
  it('refuses private/unresolvable endpoints before any request leaves', async () => {
    const r1 = await probeMcpEndpoint('http://127.0.0.1:8790/mcp', undefined, {});
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.reason).toContain('blocked range');
    const r2 = await probeMcpEndpoint('ftp://byo.example/mcp', undefined, { lookupImpl });
    expect(r2.ok).toBe(false);
  });

  it('pins the declared surface through one real session', async () => {
    const r = await probeMcpEndpoint(BYO_URL, 'byo-secret-bearer', { fetchImpl: rewriteFetch, lookupImpl });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.surface.serverName).toBe('mock-mcp');
      expect(r.surface.tools.map((t) => t.name).sort()).toEqual(['crm_lookup', 'crm_update']);
    }
  });

  it('a wrong bearer fails with a typed reason, never the server text', async () => {
    const r = await probeMcpEndpoint(BYO_URL, 'the-WRONG-bearer', { fetchImpl: rewriteFetch, lookupImpl });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/could not open an MCP session/);
  });

  it('key-shaped content in a tool description refuses the whole surface', async () => {
    const hostile = await MockMcpServer.start({
      tools: [{ name: 'leaky', description: 'use header sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', handler: () => 'ok' }],
    });
    try {
      const rw: typeof fetch = (input, init) => fetch(String(input).replace('https://byo.example/mcp', hostile.mcpUrl), init);
      const r = await probeMcpEndpoint(BYO_URL, undefined, { fetchImpl: rw, lookupImpl });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toContain('key-shaped');
    } finally {
      await hostile.close();
    }
  });

  it('a tool horde over the cap refuses', async () => {
    const horde = await MockMcpServer.start({
      tools: Array.from({ length: PROBE_LIMITS.MAX_TOOLS + 1 }, (_, i) => ({ name: `t${i}`, handler: () => 'ok' })),
    });
    try {
      const rw: typeof fetch = (input, init) => fetch(String(input).replace('https://byo.example/mcp', horde.mcpUrl), init);
      const r = await probeMcpEndpoint(BYO_URL, undefined, { fetchImpl: rw, lookupImpl });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toContain('the cap is');
    } finally {
      await horde.close();
    }
  });
});

describe('customConnectorDef (unit)', () => {
  it('every pinned tool compiles to an ACT — fail-closed, no exceptions', () => {
    const def = customConnectorDef({
      connectorId: 'our-crm', displayName: 'Our CRM', endpointUrl: BYO_URL,
      tools: [
        { name: 'crm_lookup', description: 'read-ish', inputSchema: { type: 'object' } },
        { name: 'crm_update', description: 'writes', inputSchema: { type: 'object' } },
      ],
    });
    expect(Object.values(def.tools).every((t) => t.action === 'act')).toBe(true);
    expect(def.oauth.authorizationUrl).toBe('');
  });
});

describe('the routes', () => {
  it('probe: admin previews the surface; member is refused', async () => {
    const denied = await app.inject({
      method: 'POST', url: '/api/lab/connectors/custom/probe',
      headers: { cookie: MEMBER_COOKIE, 'content-type': 'application/json' },
      payload: { url: BYO_URL, bearerToken: 'byo-secret-bearer' },
    });
    expect(denied.statusCode).toBe(403);
    const res = await app.inject({
      method: 'POST', url: '/api/lab/connectors/custom/probe',
      headers: { cookie: ADMIN_COOKIE, 'content-type': 'application/json' },
      payload: { url: BYO_URL, bearerToken: 'byo-secret-bearer' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; surface: { tools: unknown[] } };
    expect(body.ok).toBe(true);
    expect(body.surface.tools).toHaveLength(2);
  });

  it('register: re-probes, stores the row, seals the bearer as a grant', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/lab/connectors/custom',
      headers: { cookie: ADMIN_COOKIE, 'content-type': 'application/json' },
      payload: { url: BYO_URL, bearerToken: 'byo-secret-bearer', slug: 'our-crm', displayName: 'Our CRM' },
    });
    expect(res.statusCode).toBe(201);
    const rows = await listLabCustomConnectors(h.db, ORG);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tools.map((t) => t.name).sort()).toEqual(['crm_lookup', 'crm_update']);
    const grant = (await listLabGrants(h.db, ORG)).find((g) => g.connectorId === 'our-crm');
    expect(grant).toBeDefined();
    expect(grant!.scopesGranted).toEqual(['mcp:pinned']);
    // The bearer is SEALED — the raw envelope column must never contain it
    // (the list projection can't even see the envelope; go to the table).
    const raw = await h.db.select({ env: labSuperpowerGrants.tokenEnvelope }).from(labSuperpowerGrants);
    expect(raw.some((r) => String(r.env).includes('byo-secret-bearer'))).toBe(false);
    expect(raw.some((r) => String(r.env).startsWith('v1:') || String(r.env).length > 20)).toBe(true);
  });

  it('a slug shadowing the catalog (or a builtin) refuses with 409', async () => {
    for (const slug of ['github', 'web', 'code']) {
      const res = await app.inject({
        method: 'POST', url: '/api/lab/connectors/custom',
        headers: { cookie: ADMIN_COOKIE, 'content-type': 'application/json' },
        payload: { url: BYO_URL, slug, displayName: 'Shadow' },
      });
      expect(res.statusCode, slug).toBe(409);
    }
  });

  it('the catalog GET carries the registered endpoint in `custom`', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/lab/connectors', headers: { cookie: MEMBER_COOKIE } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { custom: Array<{ connectorId: string; tier: string; status: string; tools: Array<{ action: string }> }> };
    expect(body.custom).toHaveLength(1);
    expect(body.custom[0]!.connectorId).toBe('our-crm');
    expect(body.custom[0]!.tier).toBe('byo');
    expect(body.custom[0]!.status).toBe('connected');
    expect(body.custom[0]!.tools.every((t) => t.action === 'act')).toBe(true);
  });

  it('delete: revokes the grant and drops the row (admin only)', async () => {
    const denied = await app.inject({ method: 'DELETE', url: '/api/lab/connectors/custom/our-crm', headers: { cookie: MEMBER_COOKIE } });
    expect(denied.statusCode).toBe(403);
    const res = await app.inject({ method: 'DELETE', url: '/api/lab/connectors/custom/our-crm', headers: { cookie: ADMIN_COOKIE } });
    expect(res.statusCode).toBe(200);
    expect(await listLabCustomConnectors(h.db, ORG)).toHaveLength(0);
    const grant = (await listLabGrants(h.db, ORG)).find((g) => g.connectorId === 'our-crm');
    expect(grant?.revokedAt).not.toBeNull();
  });
});
