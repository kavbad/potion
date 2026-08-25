// Walkthrough seam (2026-08-24): the audit page promises "key custody, one
// chronology" — and minting a serving key, the first thing every partner
// does, wrote no row. Issue and revoke now join the trail.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sha256 } from '@potion/core';
import { createOrg, insertApiKey } from '@potion/db';
import { buildServer } from '../src/server.js';

const ORG = 'org-custody';
const ADMIN_KEY = 'pk_custody_admin';
let app: FastifyInstance;

beforeAll(async () => {
  app = await buildServer({ seed: false });
  const db = app.potion.db.db;
  await createOrg(db, { id: ORG, name: 'Custody Co' });
  await insertApiKey(db, { id: 'key-cust-admin', keyHash: sha256(ADMIN_KEY), name: 'admin', orgId: ORG, scopes: 'serve+admin' });
});
afterAll(async () => {
  await app.close();
});

const admin = { authorization: `Bearer ${ADMIN_KEY}` };

describe('serving-key custody', () => {
  let keyId = '';

  it('minting a serving key writes custody.issue — with ids only, never key material', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/api-keys', headers: admin, payload: { name: 'partner key' } });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { id: string; apiKey?: string; key?: string };
    keyId = body.id;
    const raw = body.apiKey ?? body.key ?? '';
    const audit = await app.inject({ method: 'GET', url: '/api/audit', headers: admin });
    expect(audit.statusCode).toBe(200);
    const events = (audit.json().events as Array<{ kind: string; detail: unknown }>).filter((e) => e.kind === 'custody.issue');
    expect(events.length).toBe(1);
    const serialized = JSON.stringify(events[0]);
    expect(serialized).toContain(keyId);
    if (raw) expect(serialized).not.toContain(raw); // the raw key never reaches the trail
  });

  it('revoking writes custody.revoke into the same chronology', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/api-keys/${keyId}/revoke`, headers: admin });
    expect(res.statusCode).toBe(200);
    const audit = await app.inject({ method: 'GET', url: '/api/audit', headers: admin });
    const kinds = (audit.json().events as Array<{ kind: string }>).map((e) => e.kind);
    expect(kinds).toContain('custody.revoke');
    expect(kinds).toContain('custody.issue');
  });
});
