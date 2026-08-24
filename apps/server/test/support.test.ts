// P2-9: the support channel. Delivery context comes from auth, the body is
// just the message; without a Resend env the log transport answers (tests,
// dev) — the route's contract is the same either way.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sha256 } from '@potion/core';
import { createOrg, insertApiKey } from '@potion/db';
import { buildServer } from '../src/server.js';

const ORG = 'org-support';
const KEY = 'pk_support_serve';
let app: FastifyInstance;

beforeAll(async () => {
  app = await buildServer({ seed: false });
  const db = app.potion.db.db;
  await createOrg(db, { id: ORG, name: 'Support Co' });
  await insertApiKey(db, { id: 'key-support', keyHash: sha256(KEY), name: 'serve', orgId: ORG, scopes: 'serve' });
});
afterAll(async () => {
  await app.close();
});

// NOTE: the unauthenticated-401 case is covered by the tenancy sweep (the
// route's inventory row), which runs without the dev-auth bypass this test
// environment has on.
describe('POST /api/support', () => {
  it('rejects an empty or oversized message', async () => {
    const empty = await app.inject({ method: 'POST', url: '/api/support', headers: { authorization: `Bearer ${KEY}` }, payload: { message: '' } });
    expect(empty.statusCode).toBe(400);
    const oversized = await app.inject({ method: 'POST', url: '/api/support', headers: { authorization: `Bearer ${KEY}` }, payload: { message: 'x'.repeat(4001) } });
    expect(oversized.statusCode).toBe(400);
  });

  it('delivers through the environment transport and says which', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/support',
      headers: { authorization: `Bearer ${KEY}` },
      payload: { message: 'The receipt for my 14:02 request names a model I do not recognize.', page: '/usage' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, transport: 'log' });
  });
});
