// Team invites (P0-2): the invite authorizes the email, the magic link
// proves possession, verification converts invite → membership.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sha256 } from '@potion/core';
import { createOrg, createMembership, createUser, insertApiKey, listMembersWithEmail } from '@potion/db';
import { buildServer } from '../src/server.js';

const ORG = 'org-invites';
const ADMIN_KEY = 'pk_invites_admin';
let app: FastifyInstance;
let cookie = '';

beforeAll(async () => {
  process.env.POTION_MAGIC_LINK_IN_RESPONSE = '1';
  process.env.POTION_SELF_SERVE = '0';
  app = await buildServer({ seed: false });
  const db = app.potion.db.db;
  await createOrg(db, { id: ORG, name: 'Invites Co' });
  await createUser(db, { id: 'usr-inviter', email: 'boss@invites.co', name: 'Boss' });
  await createMembership(db, { orgId: ORG, userId: 'usr-inviter', role: 'admin' });
  await insertApiKey(db, { id: 'key-invites-admin', keyHash: sha256(ADMIN_KEY), name: 'admin', orgId: ORG, scopes: 'serve+admin' });
});
afterAll(async () => {
  delete process.env.POTION_MAGIC_LINK_IN_RESPONSE;
  delete process.env.POTION_SELF_SERVE;
  await app.close();
});

describe('the invite lifecycle', () => {
  let inviteId = '';
  it('an admin invites an email with a role', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/invites', headers: { authorization: `Bearer ${ADMIN_KEY}` }, payload: { email: 'neweng@invites.co', role: 'member' } });
    expect(res.statusCode).toBe(200);
    inviteId = res.json().id;
    expect(res.json()).toMatchObject({ email: 'neweng@invites.co', role: 'member', status: 'open' });
  });
  it('a duplicate open invite is refused', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/invites', headers: { authorization: `Bearer ${ADMIN_KEY}` }, payload: { email: 'neweng@invites.co', role: 'viewer' } });
    expect(res.statusCode).toBe(409);
  });
  it('the invited unknown email now RECEIVES a sign-in link (uninvited stays silent)', async () => {
    const uninvited = await app.inject({ method: 'POST', url: '/auth/request-link', payload: { email: 'stranger@nowhere.co' } });
    expect(uninvited.json().devLink).toBeUndefined();
    const invited = await app.inject({ method: 'POST', url: '/auth/request-link', payload: { email: 'neweng@invites.co' } });
    expect(invited.statusCode).toBe(200);
    expect(invited.json().devLink).toContain('/auth/verify?token=');
  });
  it('verifying the link converts the invite into a membership with the invited role', async () => {
    const link = (await app.inject({ method: 'POST', url: '/auth/request-link', payload: { email: 'neweng@invites.co' } })).json().devLink as string;
    const token = new URL(link).searchParams.get('token')!;
    const res = await app.inject({ method: 'GET', url: `/auth/verify?token=${token}` });
    expect([200, 302, 303]).toContain(res.statusCode);
    const members = await listMembersWithEmail(app.potion.db.db, ORG);
    expect(members.map((m) => [m.email, m.role]).sort()).toEqual([
      ['boss@invites.co', 'admin'],
      ['neweng@invites.co', 'member'],
    ]);
    const list = await app.inject({ method: 'GET', url: '/api/invites', headers: { authorization: `Bearer ${ADMIN_KEY}` } });
    expect(list.json().invites.find((i: { id: string }) => i.id === inviteId).status).toBe('accepted');
  });
  it('a revoked invite authorizes nothing', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/invites', headers: { authorization: `Bearer ${ADMIN_KEY}` }, payload: { email: 'gone@invites.co', role: 'viewer' } });
    const id = created.json().id;
    const rev = await app.inject({ method: 'DELETE', url: `/api/invites/${id}`, headers: { authorization: `Bearer ${ADMIN_KEY}` } });
    expect(rev.json().revoked).toBe(true);
    const req2 = await app.inject({ method: 'POST', url: '/auth/request-link', payload: { email: 'gone@invites.co' } });
    expect(req2.json().devLink).toBeUndefined();
  });
  it('members are listable with a viewer-scope key', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/members', headers: { authorization: `Bearer ${ADMIN_KEY}` } });
    expect(res.json().members.length).toBe(2);
  });
});
