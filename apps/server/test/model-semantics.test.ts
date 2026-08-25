// Least-surprise model semantics (migration 0058, external review 2026-08-25):
// 'potion-auto' routes; a known model name PINS to exactly that model; an
// unknown name 400s; route-all-models (explicit org opt-in) restores
// label-blind routing for migrating apps.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { setOrgRouteAllModels } from '@potion/db';
import { buildServer } from '../src/server.js';

let app: FastifyInstance;
let apiKey: string;
let orgId: string;

beforeAll(async () => {
  app = await buildServer({ seed: true }); // demo seed: mock frontiers + roster
  const signup = await app.inject({
    method: 'POST',
    url: '/auth/request-link',
    headers: { 'content-type': 'application/json' },
    payload: { email: 'model-semantics@test.dev' },
  });
  const token = new URL(signup.json().devLink as string).searchParams.get('token')!;
  const verify = await app.inject({ method: 'GET', url: `/auth/verify?token=${encodeURIComponent(token)}` });
  const cookie = String(verify.headers['set-cookie'] ?? '').split(';')[0]!;
  orgId = (verify.json() as { session: { orgId: string } }).session.orgId;
  const policy = await app.inject({
    method: 'POST',
    url: '/api/policies',
    headers: { cookie, 'content-type': 'application/json' },
    payload: { policy: { type: 'min_cost', qualityFloor: 0.8 }, createKey: true },
  });
  apiKey = policy.json().apiKey as string;
}, 120_000);

afterAll(async () => {
  await app?.close();
});

const chat = (model: string) =>
  app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    payload: { model, messages: [{ role: 'user', content: 'Classify the sentiment: great product.' }] },
  });

describe('the model field means what it says', () => {
  it("'potion-auto' routes by measurement (trace carries the policy)", async () => {
    const res = await chat('potion-auto');
    expect(res.statusCode).toBe(200);
    expect(String(res.headers['x-frontier-trace'])).toContain('policy=min_cost');
  });

  it('a known model name PINS: exactly that model serves, trace says pinned', async () => {
    const res = await chat('mock-mid');
    expect(res.statusCode).toBe(200);
    expect(String(res.headers['x-frontier-trace'])).toContain('policy=pinned');
    expect(String(res.headers['x-frontier-trace'])).toContain('fallback=0');
    expect(String(res.headers['x-potion-model'])).toBe('mock-mid');
  });

  it('an unknown model name is a 400, never a silent reroute', async () => {
    const res = await chat('gpt-99-ultra');
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('unknown_model');
    expect(res.json().error.message).toContain('potion-auto');
  });

  it('route-all-models (explicit opt-in) routes any label again', async () => {
    await setOrgRouteAllModels(app.potion.db.db, orgId, true);
    const res = await chat('gpt-99-ultra');
    expect(res.statusCode).toBe(200);
    expect(String(res.headers['x-frontier-trace'])).toContain('policy=min_cost');
    await setOrgRouteAllModels(app.potion.db.db, orgId, false);
  });

  it('the settings surface reads and writes the flag (admin only)', async () => {
    const signup = await app.inject({ method: 'POST', url: '/auth/request-link', headers: { 'content-type': 'application/json' }, payload: { email: 'model-semantics@test.dev' } });
    const token = new URL(signup.json().devLink as string).searchParams.get('token')!;
    const verify = await app.inject({ method: 'GET', url: `/auth/verify?token=${encodeURIComponent(token)}` });
    const cookie = String(verify.headers['set-cookie'] ?? '').split(';')[0]!;
    const before = await app.inject({ method: 'GET', url: '/api/org-settings', headers: { cookie } });
    expect(before.statusCode).toBe(200);
    expect(before.json().routeAllModels).toBe(false);
    const put = await app.inject({ method: 'PUT', url: '/api/org-settings', headers: { cookie, 'content-type': 'application/json' }, payload: { routeAllModels: true } });
    expect(put.statusCode).toBe(200);
    const after = await app.inject({ method: 'GET', url: '/api/org-settings', headers: { cookie } });
    expect(after.json().routeAllModels).toBe(true);
    await setOrgRouteAllModels(app.potion.db.db, orgId, false);
  });
});
