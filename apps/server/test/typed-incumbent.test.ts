// A typed "other" model that is on the measured roster becomes a real
// incumbent; one that is not stays 'other' (routes/learning.ts PUT).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { sha256 } from '@potion/core';
import { createOrg, insertApiKey } from '@potion/db';
import { buildServer } from '../src/server.js';
import { incumbentRoster } from '../src/incumbents/roster.js';

const ORG = 'org-typed';
const ADMIN = 'pk_typed_admin';
let app: FastifyInstance;

beforeAll(async () => {
  app = await buildServer({ seed: false });
  await createOrg(app.potion.db.db, { id: ORG, name: 'Typed' });
  await insertApiKey(app.potion.db.db, { id: 'key-typed-admin', keyHash: sha256(ADMIN), name: 'admin', orgId: ORG, scopes: 'serve+admin' });
});
afterAll(async () => {
  await app.close();
});

const put = (body: NonNullable<InjectOptions['payload']>) =>
  app.inject({ method: 'PUT', url: '/api/incumbents', headers: { authorization: `Bearer ${ADMIN}` }, payload: body });

describe('typed incumbents', () => {
  it('a typed display name resolves to the roster alias', async () => {
    const first = incumbentRoster(app.potion.prices)[0]!;
    const res = await put({ models: [], other: `${first.vendor} ${first.name}`, samplingConsent: true });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ models: [first.alias], other: null, resolvedOther: { alias: first.alias } });
  });
  it('a model the roster has not measured stays "other"', async () => {
    const res = await put({ models: [], other: 'quasar-9-ultra', samplingConsent: true });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ models: [], other: 'quasar-9-ultra' });
    expect(res.json().resolvedOther).toBeUndefined();
  });
});
