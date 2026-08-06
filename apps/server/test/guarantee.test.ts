// Quality guarantee tests (M3, ROADMAP #22, SPEC §12.5).
//   · shouldSampleGuarantee / serveQualityScore (pure)
//   · runGuaranteeSample: rows tagged with the serving strategy hash,
//     errors swallowed (never throws into the serving path)
//   · serving integration: sampleRate honored; fire-and-forget (response
//     returns, rows land after); rollback integration — 5th sample breaches
//     → operating point moves to the PREVIOUS frontier version's equivalent
//     point (trace header proves it) → resolve lifts the override; alert
//     mode leaves routing unchanged; cooldown suppresses duplicates
//   · API: /api/guarantee/status shape + org isolation;
//     /api/incidents/:id/resolve admin-only (viewer 403, cross-org 404)
//   · metric: potion_guarantee_breaches_total increments
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  sha256,
  strategyHash,
  type FrontierPoint,
  type Policy,
  type StrategyConfig,
} from '@potion/core';
import {
  createMembership,
  createOrg,
  createSession,
  createUser,
  insertApiKey,
  insertIncident,
  insertPolicy,
  insertQualitySample,
  listIncidents,
  listQualitySamples,
  resolveIncident,
  DEFAULT_ORG_ID,
} from '@potion/db';
import { saveFrontier } from '@potion/pareto';
import { buildServer } from '../src/server.js';
import {
  runGuaranteeSample,
  serveQualityScore,
  shouldSampleGuarantee,
} from '../src/guarantee.js';

const CFG_CHEAP = { type: 'single', model: 'mock-cheap' } as const;
const CFG_MID = { type: 'single', model: 'mock-mid' } as const;
const H_CHEAP = strategyHash(CFG_CHEAP);
const H_MID = strategyHash(CFG_MID);

function point(config: StrategyConfig, quality: number, costPer1K: number): FrontierPoint {
  return {
    clusterId: 'code-gen',
    strategyHash: strategyHash(config),
    strategyConfig: config,
    quality,
    costPer1K,
    latencyP95: 500,
  };
}

// v1: cheap only. v2 (current): cheap + mid. max_quality ceiling 100 serves
// MID on v2; the previous version's equivalent point is CHEAP — the
// meaningful rollback move (mid → cheap, source='previous-version').
const V1_POINTS = [point(CFG_CHEAP, 0.5, 0.1)];
const V2_POINTS = [point(CFG_CHEAP, 0.5, 0.1), point(CFG_MID, 0.7, 1.0)];

const CODE_PROMPT = 'Write a python function that reverses a string';

// minQuality 0.99: any realistic deterministic-scorer mean breaches.
const G_ROLLBACK = { minQuality: 0.99, windowMin: 60, sampleRate: 1, action: 'rollback' as const };
const G_ALERT = { ...G_ROLLBACK, action: 'alert' as const };

const ORG_RB = 'org_g_rollback'; // rollback integration
const ORG_ALERT = 'org_g_alert'; // alert integration
const ORG_ZERO = 'org_g_zero'; // sampleRate 0
const ORG_PLAIN = 'org_g_plain'; // no guarantee
const ORG_B = 'org_g_b'; // isolation
const KEY = (org: string) => `pk_g_${org}`;

let app: FastifyInstance;
const db = () => app.potion.db.db;

async function policy(id: string, orgId: string, key: string, config: Policy): Promise<void> {
  await insertPolicy(db(), { id, orgId, name: id, config });
  await insertApiKey(db(), {
    id: `key-${id}`,
    keyHash: sha256(key),
    name: id,
    orgId,
    policyId: id,
  });
}

async function chat(rawKey: string, payload: Record<string, unknown> = {}) {
  return app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: { authorization: `Bearer ${rawKey}`, 'content-type': 'application/json' },
    payload: { model: 'potion-auto', messages: [{ role: 'user', content: CODE_PROMPT }], ...payload },
  });
}

/** Poll until pred holds or the deadline passes (guarantee work is async). */
async function waitFor<T>(fn: () => Promise<T>, pred: (v: T) => boolean, timeoutMs = 9000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let v = await fn();
  while (!pred(v) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
    v = await fn();
  }
  return v;
}

beforeAll(async () => {
  app = await buildServer({ seed: false });
  await saveFrontier(db(), 'code-gen', V1_POINTS, 'manual', '2026-08-04');
  await saveFrontier(db(), 'code-gen', V2_POINTS, 'recompute', '2026-08-04');
  for (const [org, name] of [
    [ORG_RB, 'Rollback'],
    [ORG_ALERT, 'Alert'],
    [ORG_ZERO, 'Zero'],
    [ORG_PLAIN, 'Plain'],
    [ORG_B, 'Isolation B'],
  ] as const) {
    await createOrg(db(), { id: org, name });
  }
  // max_quality ceiling 100 → serves MID (v2's best point).
  await policy('pol-g-rb', ORG_RB, KEY(ORG_RB), {
    type: 'max_quality',
    costCeilingPer1K: 100,
    guarantee: G_ROLLBACK,
  });
  await policy('pol-g-alert', ORG_ALERT, KEY(ORG_ALERT), {
    type: 'max_quality',
    costCeilingPer1K: 100,
    guarantee: G_ALERT,
  });
  await policy('pol-g-zero', ORG_ZERO, KEY(ORG_ZERO), {
    type: 'max_quality',
    costCeilingPer1K: 100,
    guarantee: { ...G_ROLLBACK, sampleRate: 0 },
  });
  await policy('pol-g-plain', ORG_PLAIN, KEY(ORG_PLAIN), {
    type: 'max_quality',
    costCeilingPer1K: 100,
  });
  await policy('pol-g-b', ORG_B, KEY(ORG_B), {
    type: 'max_quality',
    costCeilingPer1K: 100,
    guarantee: G_ROLLBACK,
  });
}, 90_000);

afterAll(async () => {
  await app.close();
});

// ---------- pure helpers ----------

describe('shouldSampleGuarantee', () => {
  it('samples deterministically against an injected rand', () => {
    expect(shouldSampleGuarantee({ ...G_ROLLBACK, sampleRate: 0 }, () => 0)).toBe(false);
    expect(shouldSampleGuarantee(G_ROLLBACK, () => 0.999)).toBe(true);
    expect(shouldSampleGuarantee({ ...G_ROLLBACK, sampleRate: 0.5 }, () => 0.5)).toBe(false);
  });
});

describe('serveQualityScore (deterministic served-answer scorer)', () => {
  it('is 1 for identical texts, 0 for disjoint token sets, deterministic', () => {
    expect(serveQualityScore('the quick brown fox', 'the quick brown fox')).toBe(1);
    expect(serveQualityScore('the quick brown fox', 'completely different words')).toBe(0);
    expect(serveQualityScore('The   QUICK fox', 'the quick fox')).toBe(1);
  });
});

describe('runGuaranteeSample', () => {
  it('inserts a sample tagged with the SERVING strategy hash and returns the evaluation', async () => {
    const before = (await listQualitySamples(db(), ORG_B)).length;
    const evaluation = await runGuaranteeSample(
      app.potion,
      {
        orgId: ORG_B,
        requestId: 'chatcmpl-g-unit-1',
        clusterId: 'code-gen',
        messages: [{ role: 'user', content: 'alpha beta gamma delta' }],
        policy: { type: 'max_quality', costCeilingPer1K: 100, guarantee: G_ROLLBACK },
        served: { hash: H_MID, text: 'epsilon zeta eta theta' },
      },
      () => {},
    );
    expect(evaluation).not.toBeNull();
    const rows = await listQualitySamples(db(), ORG_B);
    expect(rows.length).toBe(before + 1);
    expect(rows[0]!.requestId).toBe('chatcmpl-g-unit-1');
    expect(rows[0]!.strategyHash).toBe(H_MID);
    expect(rows[0]!.quality).toBe(0); // disjoint token sets
  });

  it('NEVER throws: a broken db is swallowed with a warn', async () => {
    const warnings: string[] = [];
    const brokenCtx = { ...app.potion, db: { db: null } } as never;
    const result = await runGuaranteeSample(
      brokenCtx,
      {
        orgId: ORG_B,
        requestId: 'chatcmpl-g-unit-2',
        clusterId: 'code-gen',
        messages: [{ role: 'user', content: 'x' }],
        policy: { type: 'max_quality', costCeilingPer1K: 100, guarantee: G_ROLLBACK },
        served: { hash: H_MID, text: 'y' },
      },
      (msg) => warnings.push(msg),
    );
    expect(result).toBeNull();
    expect(warnings.some((w) => w.includes('swallowed'))).toBe(true);
  });

  it('no-ops for a policy without a guarantee config', async () => {
    const before = (await listQualitySamples(db(), ORG_B)).length;
    const result = await runGuaranteeSample(app.potion, {
      orgId: ORG_B,
      requestId: 'chatcmpl-g-unit-3',
      clusterId: 'code-gen',
      messages: [{ role: 'user', content: 'x' }],
      policy: { type: 'max_quality', costCeilingPer1K: 100 },
      served: { hash: H_MID, text: 'y' },
    });
    expect(result).toBeNull();
    expect((await listQualitySamples(db(), ORG_B)).length).toBe(before);
  });
});

// ---------- sampling integration ----------

describe('sampling integration (POST /v1/chat/completions)', () => {
  it('sampleRate 1 → 200 + normal trace + the row lands AFTER the response, tagged with the serving hash', async () => {
    const before = (await listQualitySamples(db(), ORG_B)).length;
    const res = await chat(KEY(ORG_B));
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-frontier-trace']).toContain(`strategy=${H_MID.slice(0, 8)}`);
    const completionId = res.json().id as string;
    const rows = await waitFor(
      async () => (await listQualitySamples(db(), ORG_B)).filter((r) => r.requestId === completionId),
      (r) => r.length >= 1,
    );
    expect(rows.length).toBeGreaterThanOrEqual(before - before + 1);
    expect(rows[0]!.strategyHash).toBe(H_MID); // serving strategy, not a candidate
    expect(rows[0]!.orgId).toBe(ORG_B);
  });

  it('sampleRate 0 → never any rows', async () => {
    const res = await chat(KEY(ORG_ZERO));
    expect(res.statusCode).toBe(200);
    await new Promise((r) => setTimeout(r, 1200));
    expect(await listQualitySamples(db(), ORG_ZERO)).toHaveLength(0);
  });

  it('no guarantee config → no rows', async () => {
    const res = await chat(KEY(ORG_PLAIN));
    expect(res.statusCode).toBe(200);
    await new Promise((r) => setTimeout(r, 800));
    expect(await listQualitySamples(db(), ORG_PLAIN)).toHaveLength(0);
  });
});

// ---------- rollback integration ----------

describe('rollback integration (2 frontier versions)', () => {
  it('5th breaching sample moves the operating point to the PREVIOUS version; resolve lifts it', async () => {
    // 4 low samples for MID already in the window; the request's sample is
    // the 5th → breach → rollback mid → cheap (v1's equivalent point).
    for (let i = 0; i < 4; i++) {
      await insertQualitySample(db(), { orgId: ORG_RB, strategyHash: H_MID, quality: 0.05 });
    }
    const res1 = await chat(KEY(ORG_RB));
    expect(res1.statusCode).toBe(200);
    expect(res1.headers['x-frontier-trace']).toContain(`strategy=${H_MID.slice(0, 8)}`);
    const incidents = await waitFor(
      () => listIncidents(db(), ORG_RB),
      (r) => r.length >= 1,
    );
    expect(incidents[0]!.kind).toBe('rollback');
    expect(incidents[0]!.detail).toMatchObject({
      clusterId: 'code-gen',
      fromStrategy: H_MID,
      toStrategy: H_CHEAP,
      toFrontierVersion: 1,
      targetSource: 'previous-version',
    });

    // Subsequent requests serve the ROLLED-BACK point (trace header proof).
    const res2 = await chat(KEY(ORG_RB));
    expect(res2.statusCode).toBe(200);
    expect(res2.headers['x-frontier-trace']).toContain(`strategy=${H_CHEAP.slice(0, 8)}`);
    expect(res2.json().choices[0].message.content).toBeTruthy();

    // Cooldown: the breach does not flap — still exactly one incident.
    const res3 = await chat(KEY(ORG_RB));
    expect(res3.statusCode).toBe(200);
    await waitFor(
      () => listQualitySamples(db(), ORG_RB),
      (r) => r.filter((s) => s.strategyHash === H_CHEAP).length >= 2,
    );
    expect(await listIncidents(db(), ORG_RB)).toHaveLength(1);

    // Resolving the incident lifts the override → policy routing resumes.
    const resolved = await resolveIncident(db(), ORG_RB, incidents[0]!.id);
    expect(resolved).not.toBeNull();
    const res4 = await chat(KEY(ORG_RB));
    expect(res4.headers['x-frontier-trace']).toContain(`strategy=${H_MID.slice(0, 8)}`);
  });

  it('increments potion_guarantee_breaches_total', async () => {
    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(200);
    const line = res.body
      .split('\n')
      .find((l) => l.startsWith('potion_guarantee_breaches_total') && l.includes(`org_id="${ORG_RB}"`));
    expect(line).toBeTruthy();
    expect(line).toContain('action="rollback"');
  });
});

// ---------- alert mode integration ----------

describe('alert integration', () => {
  it('breach writes a quality_breach incident; the operating point is UNCHANGED', async () => {
    for (let i = 0; i < 4; i++) {
      await insertQualitySample(db(), { orgId: ORG_ALERT, strategyHash: H_MID, quality: 0.05 });
    }
    const res1 = await chat(KEY(ORG_ALERT));
    expect(res1.statusCode).toBe(200);
    const incidents = await waitFor(
      () => listIncidents(db(), ORG_ALERT),
      (r) => r.length >= 1,
    );
    expect(incidents[0]!.kind).toBe('quality_breach');
    expect(incidents[0]!.detail.toStrategy).toBeUndefined();
    // routing unchanged — still MID on the next request
    const res2 = await chat(KEY(ORG_ALERT));
    expect(res2.headers['x-frontier-trace']).toContain(`strategy=${H_MID.slice(0, 8)}`);
  });
});

// ---------- API ----------

describe('guarantee API', () => {
  it('GET /api/guarantee/status → per-policy rolling quality + breaches (org-scoped)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/guarantee/status',
      headers: { authorization: `Bearer ${KEY(ORG_RB)}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.orgId).toBe(ORG_RB);
    expect(body.policies).toHaveLength(1);
    const p = body.policies[0];
    expect(p.policyId).toBe('pol-g-rb');
    expect(p.guarantee).toEqual(G_ROLLBACK);
    expect(p.samples).toBeGreaterThanOrEqual(5);
    expect(typeof p.rollingQuality).toBe('number');
    expect(p.rollingQuality).toBeLessThan(G_ROLLBACK.minQuality);
    expect(Array.isArray(p.breaches)).toBe(true);
    expect(p.breaches[0]).toMatchObject({ kind: 'rollback' });
    expect(p.breaches[0].detail.clusterId).toBe('code-gen');
    expect(typeof p.breaches[0].createdAt).toBe('string');
  });

  it('org isolation: org B status carries neither org A policies nor incidents', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/guarantee/status',
      headers: { authorization: `Bearer ${KEY(ORG_ALERT)}` },
    });
    const body = res.json();
    expect(body.orgId).toBe(ORG_ALERT);
    expect(body.policies[0].policyId).toBe('pol-g-alert');
    for (const b of body.policies[0].breaches) {
      expect(b.detail.clusterId).toBe('code-gen');
    }
    expect(body.policies[0].breaches.every((b: { kind: string }) => b.kind === 'quality_breach')).toBe(true);
  });

  it('POST /api/incidents/:id/resolve — admin (dev bypass) resolves; double-resolve 404', async () => {
    const incidentId = await insertIncident(db(), {
      orgId: DEFAULT_ORG_ID,
      kind: 'quality_breach',
      detail: { clusterId: 'code-gen', fromStrategy: H_MID, rollingQuality: 0.2 },
    });
    const res = await app.inject({ method: 'POST', url: `/api/incidents/${incidentId}/resolve` });
    expect(res.statusCode).toBe(200);
    expect(res.json().incident.id).toBe(incidentId);
    expect(res.json().incident.resolvedAt).not.toBeNull();
    const again = await app.inject({ method: 'POST', url: `/api/incidents/${incidentId}/resolve` });
    expect(again.statusCode).toBe(404);
  });

  it('POST /api/incidents/:id/resolve — cross-org is 404 (existence does not leak)', async () => {
    const incidentId = await insertIncident(db(), {
      orgId: DEFAULT_ORG_ID,
      kind: 'quality_breach',
      detail: { clusterId: 'code-gen', fromStrategy: H_MID },
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/incidents/${incidentId}/resolve`,
      headers: { authorization: `Bearer ${KEY(ORG_B)}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('POST /api/incidents/:id/resolve — viewer is 403 (admin only)', async () => {
    const incidentId = await insertIncident(db(), {
      orgId: ORG_B,
      kind: 'quality_breach',
      detail: { clusterId: 'code-gen', fromStrategy: H_MID },
    });
    await createUser(db(), { id: 'usr_g_viewer', email: 'viewer@g.dev', name: 'viewer' });
    await createMembership(db(), { orgId: ORG_B, userId: 'usr_g_viewer', role: 'viewer' });
    await createSession(db(), {
      id: 'ses_g_viewer',
      userId: 'usr_g_viewer',
      tokenHash: sha256('ps_g_viewer'),
      orgId: ORG_B,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/incidents/${incidentId}/resolve`,
      headers: { cookie: 'potion_session=ps_g_viewer' },
    });
    expect(res.statusCode).toBe(403);
    // …and the incident is still unresolved
    const incidents = await listIncidents(db(), ORG_B);
    expect(incidents.find((i) => i.id === incidentId)?.resolvedAt ?? null).toBeNull();
  });
});
