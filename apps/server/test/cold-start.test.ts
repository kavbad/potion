// COLD START — the from-scratch customer, who is the hard case.
//
// Someone building something new has no traffic, so there is nothing of theirs
// to measure and nothing personal to route on. Everything they get on day zero
// comes from the PLATFORM frontiers. Before the baseline import those did not
// exist on a fresh database (two mock-provenance clusters from the demo seed,
// discarded by the provenance guard under a live server), so every request
// from every org — cold or warm — fell through to the default strategy with
// `fallback=1`. "We pick the best model for what you're building" had nothing
// underneath it.
//
// These tests assert the routed outcome end to end, through the real serving
// path, for an org that signed itself up seconds earlier and has sent nothing.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';

let app: FastifyInstance;
let apiKey: string;
const saved: Record<string, string | undefined> = {};

/** Parse the x-frontier-trace header into its named parts. */
function trace(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const [k, v] = part.split('=');
    if (k && v !== undefined) out[k] = v;
  }
  return out;
}

beforeAll(async () => {
  for (const k of ['POTION_SELF_SERVE', 'POTION_MAGIC_LINK_IN_RESPONSE', 'POTION_DEV_AUTH']) {
    saved[k] = process.env[k];
  }
  process.env.POTION_SELF_SERVE = '1';
  process.env.POTION_MAGIC_LINK_IN_RESPONSE = '1';
  process.env.POTION_DEV_AUTH = '0';
  // seed:false — a BARE database, the shape a real deployment boots with.
  // platformBaseline:true — this suite IS the test of the baseline, and a
  // deployment turns it on with POTION_PLATFORM_BASELINE=1.
  app = await buildServer({ seed: false, platformBaseline: true });

  const signup = await app.inject({
    method: 'POST',
    url: '/auth/request-link',
    headers: { 'content-type': 'application/json' },
    payload: { email: 'from-scratch@startup.test' },
  });
  const token = new URL(signup.json().devLink as string).searchParams.get('token')!;
  const verify = await app.inject({ method: 'GET', url: `/auth/verify?token=${encodeURIComponent(token)}` });
  const cookie = String(verify.headers['set-cookie'] ?? '').split(';')[0]!;
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
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('cold start: a customer with no workload of their own', () => {
  it('a BARE database carries live-provenance platform routing for the taxonomy', async () => {
    const rows = await app.potion.db.db.execute(
      "select count(*)::int as n from frontier_points where provider_mode = 'live' and org_id is null",
    );
    const n = Number(((rows.rows ?? []) as Array<{ n: number }>)[0]!.n);
    expect(n).toBeGreaterThan(20); // the Step 5 sweep's measured points
  });

  it('the first request an org ever sends is ROUTED, not defaulted', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      payload: {
        model: 'potion-auto',
        messages: [{ role: 'user', content: 'Write a Python function that merges two sorted lists.' }],
      },
    });
    expect(res.statusCode).toBe(200);
    const t = trace(res.headers['x-frontier-trace'] as string | undefined);
    // The whole claim, in three fields: a real frontier was used (not v0),
    // it was not a fallback, and the evidence behind it is live.
    expect(t.fallback, 'fallback=1 means the auto-switch did nothing').toBe('0');
    expect(t.provenance).toBe('live');
    expect(Number(t.frontier?.replace('v', ''))).toBeGreaterThan(0);
  }, 60_000);

  it('different intents route from DIFFERENT clusters — the switch is doing work', async () => {
    const ask = async (content: string): Promise<Record<string, string>> => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        payload: { model: 'potion-auto', messages: [{ role: 'user', content }] },
      });
      expect(res.statusCode).toBe(200);
      return trace(res.headers['x-frontier-trace'] as string | undefined);
    };

    const code = await ask('Write a Python function that merges two sorted lists.');
    const summary = await ask('Summarize this long earnings call transcript into three bullet points.');

    expect(code.cluster).not.toBe(summary.cluster);
    // …and BOTH are genuinely routed, so the difference is not one of them
    // silently falling back.
    for (const t of [code, summary]) {
      expect(t.fallback).toBe('0');
      expect(t.provenance).toBe('live');
    }
  }, 60_000);
});
