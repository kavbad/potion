// CONNECT & AUTO-ROUTE (SERVING-ROADMAP S1) — the surface that makes the
// auto-switch findable and its work checkable.
//
// What these pin is a property, not a page: a customer who signed up and
// closed the tab must be able to come back and get (a) where to point
// traffic, under what policy, with which keys, and (b) evidence that their
// own requests were ROUTED rather than defaulted. The evidence half is where
// dishonesty is cheapest — "auto-routing: on" is one boolean away from being
// decoration — so the routed flag is read back out of the trace we handed the
// caller, and every unknown counts against it.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';
import { parseTraceHeader, traceHeaderValue, traceWasRouted } from '../src/routes/chat.js';
import { configuredPublicUrl, publicBaseUrl } from '../src/public-url.js';
import { describePolicy } from '../src/routes/connection.js';

// ---------------------------------------------------------------- unit ----

describe('trace parsing — reading back what we told the caller', () => {
  it('round-trips every field of a trace this server writes', () => {
    const written = traceHeaderValue({
      clusterId: 'code-gen',
      strategyHash8: 'abcd1234',
      frontierVersion: 3,
      policyType: 'min_cost',
      fallback: 0,
      provenance: 'live',
    });
    const t = parseTraceHeader(written);
    expect(t.clusterId).toBe('code-gen');
    expect(t.strategyHash8).toBe('abcd1234');
    expect(t.frontierVersion).toBe(3);
    expect(t.policyType).toBe('min_cost');
    expect(t.fallback).toBe(0);
    expect(t.provenance).toBe('live');
    expect(traceWasRouted(t)).toBe(true);
  });

  it('keeps the appended tokens (policy_override, latency, upgraded) verbatim', () => {
    const t = parseTraceHeader(
      'cluster=summarization;strategy=aaaa1111;frontier=v2;policy=compound;fallback=0;' +
        'provenance=live;policy_override=peak-hours;upgraded=1;latency_p95=880',
    );
    expect(t.extra).toEqual({ policy_override: 'peak-hours', upgraded: '1', latency_p95: '880' });
    // …and the known fields are unaffected by the extras riding along.
    expect(t.policyType).toBe('compound');
    expect(traceWasRouted(t)).toBe(true);
  });

  it('a FALLBACK on a real frontier is not routed — the one-field check would say it was', () => {
    // This is the case a naive `frontierVersion > 0` test gets wrong: a
    // frontier existed, and no point on it satisfied the policy, so the
    // request rode the default strategy anyway.
    const t = parseTraceHeader(
      'cluster=code-gen;strategy=deadbeef;frontier=v4;policy=min_cost;fallback=1;provenance=live',
    );
    expect(t.frontierVersion).toBe(4);
    expect(traceWasRouted(t)).toBe(false);
  });

  it('fallback=0 with NO frontier (v0) is not routed either', () => {
    const t = parseTraceHeader(
      'cluster=general;strategy=deadbeef;frontier=v0;policy=min_cost;fallback=0;provenance=mock',
    );
    expect(traceWasRouted(t)).toBe(false);
  });

  it('unknown is UNKNOWN — a missing or unparseable trace never reads as routed', () => {
    for (const input of [null, undefined, '', 'garbage', 'fallback=maybe;frontier=vX']) {
      const t = parseTraceHeader(input);
      expect(t.fallback, `input: ${String(input)}`).toBeNull();
      expect(traceWasRouted(t), `input: ${String(input)}`).toBe(false);
    }
  });
});

describe('public base url', () => {
  const saved = process.env.POTION_PUBLIC_URL;
  afterAll(() => {
    if (saved === undefined) delete process.env.POTION_PUBLIC_URL;
    else process.env.POTION_PUBLIC_URL = saved;
  });

  const req = { protocol: 'http', headers: { host: 'potion-server:3000' } } as never;

  it('POTION_PUBLIC_URL WINS over the request — the proxy case', () => {
    // Without this the customer is handed `http://potion-server:3000`, an
    // internal name on an internal scheme, and their first request fails.
    process.env.POTION_PUBLIC_URL = 'https://api.potion.dev';
    expect(publicBaseUrl(req)).toBe('https://api.potion.dev');
  });

  it('strips a trailing slash so callers can append /v1 safely', () => {
    process.env.POTION_PUBLIC_URL = 'https://api.potion.dev/';
    expect(configuredPublicUrl()).toBe('https://api.potion.dev');
    expect(publicBaseUrl(req)).toBe('https://api.potion.dev');
  });

  it('falls back to the request origin when unset — correct in local dev', () => {
    delete process.env.POTION_PUBLIC_URL;
    expect(configuredPublicUrl()).toBeNull();
    expect(publicBaseUrl(req)).toBe('http://potion-server:3000');
  });

  it('treats blank as unset rather than advertising an empty base url', () => {
    process.env.POTION_PUBLIC_URL = '   ';
    expect(configuredPublicUrl()).toBeNull();
    expect(publicBaseUrl(req)).toBe('http://potion-server:3000');
  });
});

describe('describePolicy — the policy in a sentence, rendered from the object', () => {
  it('states the actual numbers, per policy type', () => {
    expect(describePolicy({ type: 'min_cost', qualityFloor: 0.8 })).toContain('0.80');
    expect(describePolicy({ type: 'max_quality', costCeilingPer1K: 1 })).toContain('$1.0000');
    expect(describePolicy({ type: 'latency_bound', p95Ms: 900 })).toContain('900 ms');
    const compound = describePolicy({ type: 'compound', qualityFloor: 0.75, p95Ms: 1200 });
    expect(compound).toContain('0.75');
    expect(compound).toContain('1200 ms');
  });
});

// ------------------------------------------------------------ end to end ----

let app: FastifyInstance;
let apiKey: string;
let cookie: string;
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  for (const k of ['POTION_SELF_SERVE', 'POTION_MAGIC_LINK_IN_RESPONSE', 'POTION_DEV_AUTH']) {
    saved[k] = process.env[k];
  }
  process.env.POTION_SELF_SERVE = '1';
  process.env.POTION_MAGIC_LINK_IN_RESPONSE = '1';
  process.env.POTION_DEV_AUTH = '0';
  // Same shape as cold-start.test.ts: a BARE database with the platform
  // baseline, which is what a real deployment boots with.
  app = await buildServer({ seed: false, platformBaseline: true });

  const signup = await app.inject({
    method: 'POST',
    url: '/auth/request-link',
    headers: { 'content-type': 'application/json' },
    payload: { email: 'connect@startup.test' },
  });
  const token = new URL(signup.json().devLink as string).searchParams.get('token')!;
  const verify = await app.inject({ method: 'GET', url: `/auth/verify?token=${encodeURIComponent(token)}` });
  cookie = String(verify.headers['set-cookie'] ?? '').split(';')[0]!;
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

describe('GET /api/connection — coming back after closing the tab', () => {
  it('answers where to point traffic, under what policy, with which keys', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/connection', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body.endpoint).toMatch(/\/v1\/chat\/completions$/);
    expect(body.snippets.curl).toContain(body.baseUrl);
    // The policy is legible, not just JSON — this is the whole point of the
    // description field, and it must carry the bound policy's real numbers.
    expect(body.policy.config).toEqual({ type: 'min_cost', qualityFloor: 0.8 });
    expect(body.policy.description).toContain('0.80');
    // The key minted at signup is FINDABLE afterwards…
    expect(body.servingKeys.length).toBeGreaterThan(0);
    // …as metadata only. Only the sha256 is stored, so no raw key can appear
    // here; asserting it structurally means a future field cannot leak one in.
    expect(JSON.stringify(body.servingKeys)).not.toContain('pk_');
  });

  it('says who serves this org — platform keys, since nothing was brought', async () => {
    const body = (await app.inject({ method: 'GET', url: '/api/connection', headers: { cookie } })).json();
    expect(body.serving.byok).toBe(false);
    expect(body.serving.byokProviders).toEqual([]);
    expect(body.serving.platformProviders.length).toBeGreaterThan(0);
  });

  it('reports auto-routing readiness for the whole taxonomy, per cluster', async () => {
    const body = (await app.inject({ method: 'GET', url: '/api/connection', headers: { cookie } })).json();
    expect(body.autoRouting.total).toBe(10);
    // The baseline covers the taxonomy, so a bare database is READY — this is
    // the cold-start claim, restated on the surface a customer actually sees.
    expect(body.autoRouting.ready).toBe(10);
    for (const c of body.autoRouting.clusters) {
      expect(c.name, `cluster ${c.clusterId} must carry its human name`).toBeTruthy();
      expect(c.pointCount).toBeGreaterThan(0);
    }
  });
});

describe('GET /api/routing-activity — proof, quoted from what we returned', () => {
  it('shows the org OWN requests as routed, matching the header they got', async () => {
    const chat = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      payload: {
        model: 'potion-auto',
        messages: [{ role: 'user', content: 'Write a Python function that merges two sorted lists.' }],
      },
    });
    expect(chat.statusCode).toBe(200);
    const header = chat.headers['x-frontier-trace'] as string;

    const res = await app.inject({ method: 'GET', url: '/api/routing-activity', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    const latest = body.requests[0];
    expect(latest.status).toBe('ok');
    expect(latest.routed).toBe(true);
    // The row is the HEADER, not a re-derivation: every field the customer
    // saw comes back identical. If these could disagree, the panel would be
    // a second opinion about our own decision.
    const fromHeader = parseTraceHeader(header);
    expect(latest.clusterId).toBe(fromHeader.clusterId);
    expect(latest.strategy).toBe(fromHeader.strategyHash8);
    expect(latest.frontierVersion).toBe(fromHeader.frontierVersion);
    expect(latest.fallback).toBe(fromHeader.fallback);
    expect(latest.provenance).toBe(fromHeader.provenance);

    expect(body.summary.routed).toBeGreaterThan(0);
    expect(body.summary.defaulted).toBe(0);
    expect(body.summary.clustersSeen).toContain(fromHeader.clusterId);
  }, 60_000);

  it('a REJECTED request stays visible but never enters the routing ratio', async () => {
    // A bad key is a connection problem, not a routing failure. It must show
    // up (that is the diagnostic the connect page exists for) and must not
    // move the routed/defaulted counts, in either direction.
    const before = (await app.inject({ method: 'GET', url: '/api/routing-activity', headers: { cookie } })).json();

    const bad = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: 'Bearer pk_not_a_real_key', 'content-type': 'application/json' },
      payload: { model: 'potion-auto', messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(bad.statusCode).toBe(401);

    const after = (await app.inject({ method: 'GET', url: '/api/routing-activity', headers: { cookie } })).json();
    // The failed row lands on the DEFAULT org (it has no tenant), so this
    // org's own counts are untouched — and that is the assertion either way:
    // nothing about a rejected request may be counted as routing.
    expect(after.summary.routed).toBe(before.summary.routed);
    expect(after.summary.defaulted).toBe(before.summary.defaulted);
    expect(after.summary.withRoutingDecision).toBe(before.summary.withRoutingDecision);
  });

  it('?limit= is clamped rather than trusted', async () => {
    for (const limit of ['0', '-5', '9999', 'abc']) {
      const res = await app.inject({
        method: 'GET',
        url: `/api/routing-activity?limit=${limit}`,
        headers: { cookie },
      });
      expect(res.statusCode, `limit=${limit}`).toBe(200);
      expect(res.json().requests.length).toBeLessThanOrEqual(200);
    }
  });
});
