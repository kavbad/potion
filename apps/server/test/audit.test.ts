// Unified audit surface tests (M4, ROADMAP #34, SPEC §13.6).
//   · GET /api/audit merges custody + auth + incident events newest-first,
//     admin-only (viewer 403), org-scoped (org B never sees org A's rows)
//   · GET /api/audit/export.jsonl: window validation (missing/inverted/
//     >92-day → 400), JSONL ascending chronology, Content-Disposition
//     attachment, one source line per event with actor/ip/requestId shape
//   · tenant isolation on the export path (org B's export contains only
//     org B's events even when org A's window is dense)
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sha256 } from '@potion/core';
import {
  DEFAULT_ORG_ID,
  createMembership,
  createOrg,
  createSession,
  createUser,
  insertApiKey,
  insertAuthEvent,
  insertCustodyAudit,
  insertIncident,
} from '@potion/db';
import { buildServer } from '../src/server.js';

const ORG_A = DEFAULT_ORG_ID;
const ORG_B = 'org_audit_b';
const KEY_B = 'pk_audit_org_b';

const T = {
  c1: '2026-07-01T10:00:00Z', // custody, org A
  a1: '2026-07-01T11:00:00Z', // auth, org A
  i1: '2026-07-01T12:00:00Z', // incident, org A
  b1: '2026-07-01T10:30:00Z', // auth, org B (must not leak)
};

let app: FastifyInstance;
const db = () => app.potion.db.db;

beforeAll(async () => {
  app = await buildServer({ seed: false });
  await createOrg(db(), { id: ORG_B, name: 'Audit Org B' });
  await insertApiKey(db(), {
    id: 'key-audit-b',
    keyHash: sha256(KEY_B),
    name: 'b',
    orgId: ORG_B,
    scopes: 'serve+admin', // admin routes gate api keys on the admin SCOPE (M2 #15)
  });

  // Org A evidence: one of each source.
  await insertCustodyAudit(db(), {
    id: 'ca-a1',
    orgId: ORG_A,
    action: 'encrypt',
    actor: 'usr_admin',
    providerKeyId: 'pk-row-1',
    metadata: { provider: 'openrouter' },
    createdAt: new Date(T.c1),
  });
  await insertAuthEvent(db(), {
    id: 'ae-a1',
    orgId: ORG_A,
    kind: 'login',
    method: 'magic_link',
    actor: 'admin@a.dev',
    ip: '10.0.0.9',
    requestId: 'req-audit-1',
    createdAt: new Date(T.a1),
  });
  await insertIncident(db(), {
    orgId: ORG_A,
    kind: 'rollback',
    detail: { clusterId: 'code-gen', fromStrategy: 'abc123' },
    createdAt: new Date(T.i1),
  });
  // Org B evidence: one auth row between A's custody/auth rows.
  await insertAuthEvent(db(), {
    id: 'ae-b1',
    orgId: ORG_B,
    kind: 'logout',
    method: 'magic_link',
    actor: 'bob@b.dev',
    createdAt: new Date(T.b1),
  });

  // Viewer on org A.
  await createUser(db(), { id: 'usr_au_viewer', email: 'viewer@au.dev', name: 'viewer' });
  await createMembership(db(), { orgId: ORG_A, userId: 'usr_au_viewer', role: 'viewer' });
  await createSession(db(), {
    id: 'ses_au_viewer',
    userId: 'usr_au_viewer',
    tokenHash: sha256('ps_au_viewer'),
    orgId: ORG_A,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
});

afterAll(async () => {
  await app.close();
});

const FROM = '2026-07-01T00:00:00Z';
const TO = '2026-07-02T00:00:00Z';

describe('GET /api/audit', () => {
  it('merges the three sources newest-first, org-scoped', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/audit' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.orgId).toBe(ORG_A);
    const kinds = body.events.map((e: { kind: string }) => e.kind);
    expect(kinds).toContain('custody.encrypt');
    expect(kinds).toContain('auth.login');
    expect(kinds).toContain('incident.rollback');
    expect(kinds).not.toContain('auth.logout'); // org B's row
    // newest-first
    const ts = body.events.map((e: { ts: string }) => e.ts);
    const sorted = [...ts].sort().reverse();
    expect(ts).toEqual(sorted);
    // shape: actor + ip/requestId slots present
    const login = body.events.find((e: { kind: string }) => e.kind === 'auth.login');
    expect(login).toMatchObject({ actor: 'admin@a.dev', ip: '10.0.0.9', requestId: 'req-audit-1' });
    const custody = body.events.find((e: { kind: string }) => e.kind === 'custody.encrypt');
    expect(custody.actor).toBe('usr_admin');
  });

  it('viewer is 403 (admin only)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/audit',
      headers: { cookie: 'potion_session=ps_au_viewer' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('org B sees only its own events', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/audit',
      headers: { authorization: `Bearer ${KEY_B}` },
    });
    expect(res.statusCode).toBe(200);
    const kinds = res.json().events.map((e: { kind: string }) => e.kind);
    expect(kinds).toEqual(['auth.logout']);
  });
});

describe('GET /api/audit/export.jsonl', () => {
  it('window validation: missing from/to → 400; inverted → 400; >92 days → 400', async () => {
    const missing = await app.inject({ method: 'GET', url: '/api/audit/export.jsonl?from=2026-07-01' });
    expect(missing.statusCode).toBe(400);
    const inverted = await app.inject({
      method: 'GET',
      url: `/api/audit/export.jsonl?from=${encodeURIComponent(TO)}&to=${encodeURIComponent(FROM)}`,
    });
    expect(inverted.statusCode).toBe(400);
    const wide = await app.inject({
      method: 'GET',
      url: '/api/audit/export.jsonl?from=2026-01-01&to=2026-06-01',
    });
    expect(wide.statusCode).toBe(400);
    expect(wide.json().error.message).toContain('92 days');
  });

  it('exports ascending JSONL with attachment headers, org-scoped', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/audit/export.jsonl?from=${encodeURIComponent(FROM)}&to=${encodeURIComponent(TO)}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/x-ndjson');
    expect(res.headers['content-disposition']).toContain('attachment');
    expect(res.headers['content-disposition']).toContain(ORG_A);

    const lines = res.body.trim().split('\n').map((l) => JSON.parse(l) as { ts: string; kind: string });
    expect(lines).toHaveLength(3); // org A only — B's row must not leak
    expect(lines.map((l) => l.kind)).toEqual(['custody.encrypt', 'auth.login', 'incident.rollback']);
    const ts = lines.map((l) => l.ts);
    expect(ts).toEqual([...ts].sort()); // ascending chronology
  });

  it('org B export contains only org B rows', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/audit/export.jsonl?from=${encodeURIComponent(FROM)}&to=${encodeURIComponent(TO)}`,
      headers: { authorization: `Bearer ${KEY_B}` },
    });
    expect(res.statusCode).toBe(200);
    const lines = res.body.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as { kind: string });
    expect(lines.map((l) => l.kind)).toEqual(['auth.logout']);
  });

  it('empty window → empty body (still a valid attachment)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/audit/export.jsonl?from=2026-01-05&to=2026-01-06',
    });
    expect(res.statusCode).toBe(200);
    expect(res.body.trim()).toBe('');
  });
});
