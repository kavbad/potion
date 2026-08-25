// GET /v1/models — catalog ≠ frontier, and `model` ≠ a choice (S5).
//
// Two separate misrepresentations lived in one response.
//
//   1. Every price-table alias was listed exactly like `potion-auto`, which
//      implies you can pick one. You cannot: routes/chat.ts uses body.model
//      as a LABEL — echoed back, written to request_logs — and resolves the
//      strategy from cluster + policy + frontier. A customer reading this
//      list would reasonably build a model-selection UI on top of an id that
//      is discarded.
//   2. Appearing in the list said nothing about whether Potion had MEASURED
//      the model, and only measured points are ever routed to. "We support N
//      models" is precisely the claim the dial-honesty decision forbids
//      making without measurement underneath it.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';

let app: FastifyInstance;
let apiKey: string;
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  for (const k of ['POTION_SELF_SERVE', 'POTION_MAGIC_LINK_IN_RESPONSE', 'POTION_DEV_AUTH']) {
    saved[k] = process.env[k];
  }
  process.env.POTION_SELF_SERVE = '1';
  process.env.POTION_MAGIC_LINK_IN_RESPONSE = '1';
  process.env.POTION_DEV_AUTH = '0';
  app = await buildServer({ seed: false, platformBaseline: true });
  const signup = await app.inject({
    method: 'POST', url: '/auth/request-link',
    headers: { 'content-type': 'application/json' },
    payload: { email: 'catalog@startup.test' },
  });
  const token = new URL(signup.json().devLink as string).searchParams.get('token')!;
  const verify = await app.inject({ method: 'GET', url: `/auth/verify?token=${encodeURIComponent(token)}` });
  const cookie = String(verify.headers['set-cookie'] ?? '').split(';')[0]!;
  const created = await app.inject({
    method: 'POST', url: '/api/policies',
    headers: { cookie, 'content-type': 'application/json' },
    payload: { policy: { type: 'min_cost', qualityFloor: 0.8 }, createKey: true },
  });
  apiKey = created.json().apiKey as string;
}, 120_000);

afterAll(async () => {
  await app?.close();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

async function models() {
  const res = await app.inject({
    method: 'GET', url: '/v1/models', headers: { authorization: `Bearer ${apiKey}` },
  });
  expect(res.statusCode).toBe(200);
  return res.json().data as Array<{ id: string; object: string; owned_by: string;
    potion?: { role: string; measured?: boolean; note?: string } }>;
}

describe('the list says what each id actually IS', () => {
  it('marks potion-auto as the router and says the other ids are labels', async () => {
    const auto = (await models()).find((m) => m.id === 'potion-auto')!;
    expect(auto.potion?.role).toBe('router');
    expect(auto.potion?.note).toMatch(/label/i);
  });

  it('marks every catalogue entry as catalogue, NOT as something to select', async () => {
    const rest = (await models()).filter((m) => m.id !== 'potion-auto');
    expect(rest.length).toBeGreaterThan(0);
    expect(rest.every((m) => m.potion?.role === 'catalog')).toBe(true);
  });

  it('distinguishes MEASURED models from merely known ones', async () => {
    // The baseline measured a handful of models across ten clusters; the
    // price table carries more than that. If every entry came back measured,
    // the flag would be decoration.
    const rest = (await models()).filter((m) => m.id !== 'potion-auto');
    const measured = rest.filter((m) => m.potion?.measured === true);
    expect(measured.length).toBeGreaterThan(0);
    expect(measured.length).toBeLessThan(rest.length);
  });

  it('keeps the OpenAI-shaped fields intact so existing clients still work', async () => {
    // The honesty lives in a namespaced block precisely so it cannot break
    // anyone enumerating models against the standard schema.
    for (const m of await models()) {
      expect(typeof m.id).toBe('string');
      expect(m.object).toBe('model');
      expect(typeof m.owned_by).toBe('string');
    }
  });

  it('and the claim is TRUE: a named model id PINS — the label means what it says (0058)', async () => {
    // The 2026-08-25 semantics flip (external review): the old contract —
    // "the label changes nothing" — violated least surprise for apps using
    // `model` as an entitlement or eval condition. Now: potion-auto routes,
    // a known id serves exactly that model, and the trace says pinned.
    const ask = async (model: string) => {
      const res = await app.inject({
        method: 'POST', url: '/v1/chat/completions',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        payload: { model, messages: [{ role: 'user', content: 'Write a Python function that merges two sorted lists.' }] },
      });
      expect(res.statusCode).toBe(200);
      return res;
    };
    const asAuto = await ask('potion-auto');
    expect(String(asAuto.headers['x-frontier-trace'])).not.toContain('policy=pinned');
    const asPinned = await ask('or-opus');
    expect(String(asPinned.headers['x-frontier-trace'])).toContain('policy=pinned');
    expect(String(asPinned.headers['x-potion-model'])).toBe('or-opus');
  }, 60_000);
});
