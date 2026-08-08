// Share-link tests (M4, ROADMAP #31, SPEC §13.3).
//   · mint/list/revoke over HTTP (dev-bypass org = org_demo admin)
//   · hash-only storage: the raw token NEVER appears in the share_tokens row
//   · public endpoints work WITHOUT a session (dev bypass forced OFF) and
//     preserve per-point provenance; unknown/revoked/kind-mismatch → uniform 404
//   · redaction strips org-identifying fields (org id/name); cluster names +
//     strategy labels stay; redactNames:false discloses the org block
//   · org isolation: org B cannot see/revoke org A's tokens, and org B's
//     shared report contains only org B's evidence
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sha256, strategyHash, type FrontierPoint, type Usage } from '@potion/core';
import {
  findShareTokenByHash,
  insertApiKey,
  insertRequestLog,
  insertShadowResult,
  listShareTokens,
  upsertStrategyConfig,
} from '@potion/db';
import { saveFrontier } from '@potion/pareto';
import { buildServer } from '../src/server.js';
import { shareUrlPath } from '../src/routes/share.js';
// G2.4 carryover: cross-tenant suites use TWO DISTINCT NON-DEFAULT orgs from the
// shared fixture — the demo org must never be the probed subject (see the
// fixture header; that assumption is what hid tenancy defect D1).
import { ORG_A, ORG_A_NAME, ORG_B, seedIsolationOrgs } from './fixtures/orgs.js';

/** ORG_A admin credential. Mints used to be unauthenticated and rode the dev
 * bypass onto the demo org — which silently happened to be the seeded subject
 * org. The subject tenant is named explicitly now. */
const RAW_A = 'pk_share_org_a';
const RAW_B = 'pk_share_org_b';

const CFG_CHEAP = { type: 'single', model: 'mock-cheap' } as const;
const CFG_MID = { type: 'single', model: 'mock-mid' } as const;
const H_CHEAP = strategyHash(CFG_CHEAP);
const H_MID = strategyHash(CFG_MID);

const POINTS: FrontierPoint[] = [
  {
    clusterId: 'code-gen',
    strategyHash: H_CHEAP,
    strategyConfig: CFG_CHEAP,
    quality: 0.72,
    costPer1K: 0.4,
    latencyP95: 120,
    providerMode: 'mock',
  },
  {
    clusterId: 'code-gen',
    strategyHash: H_MID,
    strategyConfig: CFG_MID,
    quality: 0.91,
    costPer1K: 2.1,
    latencyP95: 340,
    providerMode: 'live',
  },
];

const usage = (cost: number): Usage => ({
  inputTokens: 10,
  outputTokens: 5,
  costUsd: cost,
  latencyMs: 10,
});

let app: FastifyInstance;
const db = () => app.potion.db.db;

beforeAll(async () => {
  app = await buildServer({ seed: false });
  await saveFrontier(db(), 'code-gen', POINTS, 'manual', 'test-prices');
  await seedIsolationOrgs(db());
  // G2.3: probes the admin revoke route cross-org — explicit admin scope.
  await insertApiKey(db(), { id: 'key-share-a', keyHash: sha256(RAW_A), name: 'a', orgId: ORG_A, scopes: 'serve+admin' });
  await insertApiKey(db(), { id: 'key-share-b', keyHash: sha256(RAW_B), name: 'b', orgId: ORG_B, scopes: 'serve+admin' });
  await upsertStrategyConfig(db(), H_CHEAP, CFG_CHEAP);

  // Savings-report evidence: org A — 2 ok requests ($0.03) + 2 shadow samples;
  // org B — 1 request ($0.50) + 1 shadow sample (must not leak into A's link).
  const at = (iso: string) => new Date(iso);
  const today = new Date().toISOString().slice(0, 10);
  await insertRequestLog(db(), { ts: at(`${today}T10:00:00Z`), orgId: ORG_A, clusterId: 'code-gen', status: 'ok', usage: usage(0.01) });
  await insertRequestLog(db(), { ts: at(`${today}T11:00:00Z`), orgId: ORG_A, clusterId: 'code-gen', status: 'ok', usage: usage(0.02) });
  await insertRequestLog(db(), { ts: at(`${today}T10:00:00Z`), orgId: ORG_B, clusterId: 'code-gen', status: 'ok', usage: usage(0.5) });
  await insertShadowResult(db(), { orgId: ORG_A, requestId: 'r1', clusterId: 'code-gen', primaryHash: 'p', candidateHash: H_CHEAP, candidateModel: 'mock-cheap', quality: 0.5, costUsd: 0.001, latencyMs: 12, createdAt: at(`${today}T13:00:00Z`) });
  await insertShadowResult(db(), { orgId: ORG_A, requestId: 'r2', clusterId: 'code-gen', primaryHash: 'p', candidateHash: H_CHEAP, candidateModel: 'mock-cheap', quality: 0.7, costUsd: 0.003, latencyMs: 15, createdAt: at(`${today}T14:00:00Z`) });
  await insertShadowResult(db(), { orgId: ORG_B, requestId: 'r9', clusterId: 'code-gen', primaryHash: 'p', candidateHash: H_CHEAP, candidateModel: 'mock-cheap', quality: 0.8, costUsd: 0.4, latencyMs: 20, createdAt: at(`${today}T13:30:00Z`) });
}, 90_000);

afterAll(async () => {
  await app.close();
});

async function mintShare(body: Record<string, unknown>, bearer: string = RAW_A): Promise<{
  status: number;
  json: Record<string, unknown>;
}> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/share',
    headers: { authorization: `Bearer ${bearer}` },
    payload: body,
  });
  return { status: res.statusCode, json: res.json() as Record<string, unknown> };
}

describe('POST /api/share (mint)', () => {
  it('mints a frontier link: raw token returned once, url path shaped /share/f/<token>', async () => {
    const { status, json } = await mintShare({ kind: 'frontier', clusterId: 'code-gen' });
    expect(status).toBe(201);
    const token = json.token as string;
    expect(token.startsWith('st_')).toBe(true);
    expect(json.url).toBe(shareUrlPath('frontier', token));
    expect(json.url).toBe(`/share/f/${token}`);
    expect(json.kind).toBe('frontier');
    expect(typeof json.id).toBe('string');
  });

  it('mints a report link with a default window of 30 days', async () => {
    const { status, json } = await mintShare({ kind: 'report' });
    expect(status).toBe(201);
    expect(String(json.url)).toMatch(/^\/share\/r\/st_/);
    const rows = await listShareTokens(db(), ORG_A);
    const row = rows.find((r) => r.id === json.id)!;
    expect(row.payload).toEqual({ windowDays: 30 });
  });

  it('stores ONLY the sha256 hash — the raw token never touches the db', async () => {
    const { status, json } = await mintShare({ kind: 'frontier', clusterId: 'code-gen' });
    expect(status).toBe(201);
    const token = json.token as string;
    const rows = await listShareTokens(db(), ORG_A);
    const row = rows.find((r) => r.id === json.id)!;
    expect(row.tokenHash).toBe(sha256(token));
    expect(JSON.stringify(row)).not.toContain(token);
    // global lookup works only via the hash
    const byHash = await findShareTokenByHash(db(), sha256(token));
    expect(byHash?.id).toBe(json.id);
  });

  it('rejects bad bodies: frontier without clusterId → 400; unknown cluster → 404', async () => {
    expect((await mintShare({ kind: 'frontier' })).status).toBe(400);
    expect((await mintShare({ kind: 'frontier', clusterId: 'no-such-cluster' })).status).toBe(404);
    expect((await mintShare({ kind: 'report', windowDays: 0 })).status).toBe(400);
    expect((await mintShare({ kind: 'nope' })).status).toBe(400);
  });
});

describe('GET /api/share (list, masked)', () => {
  it('lists the org’s tokens with kind/payload/revocation state — never the raw token', async () => {
    const { json: minted } = await mintShare({ kind: 'frontier', clusterId: 'code-gen' });
    const res = await app.inject({
      method: 'GET',
      url: '/api/share',
      headers: { authorization: `Bearer ${RAW_A}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { tokens: Array<Record<string, unknown>> };
    const entry = body.tokens.find((t) => t.id === minted.id)!;
    expect(entry.kind).toBe('frontier');
    expect(entry.payload).toEqual({ clusterId: 'code-gen' });
    expect(entry.revokedAt).toBeNull();
    expect(entry.redactNames).toBe(true);
    expect(entry.tokenHashPrefix).toBe(sha256(minted.token as string).slice(0, 8));
    expect(JSON.stringify(body)).not.toContain(minted.token as string);
  });
});

describe('public endpoints (NO session)', () => {
  it('frontier payload: works session-free with the dev bypass forced OFF; provenance preserved', async () => {
    const { json: minted } = await mintShare({ kind: 'frontier', clusterId: 'code-gen' });
    const token = minted.token as string;
    const prev = process.env.POTION_DEV_AUTH;
    process.env.POTION_DEV_AUTH = '0'; // prove the route needs NO credential at all
    try {
      const res = await app.inject({ method: 'GET', url: `/api/public/share/${token}/frontier` });
      expect(res.statusCode).toBe(200);
      const body = res.json() as Record<string, unknown>;
      expect(body.kind).toBe('frontier');
      expect(body.clusterId).toBe('code-gen');
      expect(typeof body.clusterName).toBe('string'); // cluster names stay
      expect(body.redacted).toBe(true);
      expect(body.organization).toBeNull(); // org stripped under redaction
      expect(JSON.stringify(body)).not.toContain('Demo Org');
      const frontier = body.frontier as { version: number; points: Array<Record<string, unknown>> };
      expect(frontier.version).toBe(1);
      expect(frontier.points).toHaveLength(2);
      const cheap = frontier.points.find((p) => p.strategyHash === H_CHEAP)!;
      const mid = frontier.points.find((p) => p.strategyHash === H_MID)!;
      // Provenance badges preserved exactly: mock stays mock, live stays live.
      expect(cheap.providerMode).toBe('mock');
      expect(mid.providerMode).toBe('live');
      expect(cheap.strategyConfig).toEqual(CFG_CHEAP); // strategy labels stay
      expect(body.provenance).toEqual({ live: 1, simulated: 1 });
    } finally {
      if (prev === undefined) delete process.env.POTION_DEV_AUTH;
      else process.env.POTION_DEV_AUTH = prev;
    }
  });

  it('report payload: windowDays window, org id redacted to "shared"', async () => {
    const { json: minted } = await mintShare({ kind: 'report', windowDays: 7 });
    const res = await app.inject({
      method: 'GET',
      url: `/api/public/share/${minted.token as string}/report`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body.kind).toBe('report');
    expect(body.windowDays).toBe(7);
    const report = body.report as {
      orgId: string;
      actualSpendUsd: number;
      alternatives: Array<{ strategyHash: string; sampleSize: number }>;
    };
    expect(report.orgId).toBe('shared'); // org-identifying id stripped
    expect(JSON.stringify(body)).not.toContain(ORG_A);
    expect(report.actualSpendUsd).toBeCloseTo(0.03, 10);
    expect(report.alternatives).toHaveLength(1); // org B's sample must not leak
    expect(report.alternatives[0]!.strategyHash).toBe(H_CHEAP);
    expect(report.alternatives[0]!.sampleSize).toBe(2);
  });

  it('redactNames:false discloses the org block (name redaction is an OPTION)', async () => {
    const { json: minted } = await mintShare({
      kind: 'report',
      windowDays: 7,
      redactNames: false,
    });
    const res = await app.inject({
      method: 'GET',
      url: `/api/public/share/${minted.token as string}/report`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body.redacted).toBe(false);
    expect(body.organization).toEqual({ id: ORG_A, name: ORG_A_NAME });
    expect((body.report as { orgId: string }).orgId).toBe(ORG_A);
  });

  it('unknown / revoked / kind-mismatched tokens → uniform 404', async () => {
    const { json: minted } = await mintShare({ kind: 'frontier', clusterId: 'code-gen' });
    const token = minted.token as string;
    // unknown
    const unknown = await app.inject({ method: 'GET', url: '/api/public/share/st_deadbeef/frontier' });
    expect(unknown.statusCode).toBe(404);
    // kind mismatch: a frontier token at the report endpoint
    const wrong = await app.inject({ method: 'GET', url: `/api/public/share/${token}/report` });
    expect(wrong.statusCode).toBe(404);
    expect(wrong.json()).toEqual(unknown.json()); // no existence oracle via body either
    // revoke → 404
    const revoke = await app.inject({
      method: 'POST',
      url: `/api/share/${minted.id as string}/revoke`,
      headers: { authorization: `Bearer ${RAW_A}` },
    });
    expect(revoke.statusCode).toBe(200);
    const after = await app.inject({ method: 'GET', url: `/api/public/share/${token}/frontier` });
    expect(after.statusCode).toBe(404);
    // double revoke → 404
    const again = await app.inject({
      method: 'POST',
      url: `/api/share/${minted.id as string}/revoke`,
      headers: { authorization: `Bearer ${RAW_A}` },
    });
    expect(again.statusCode).toBe(404);
  });
});

describe('org isolation', () => {
  it('org B lists only its own tokens; cannot revoke org A’s; its shared report carries only its evidence', async () => {
    const { json: aToken } = await mintShare({ kind: 'report', windowDays: 7 });
    const { json: bToken } = await mintShare({ kind: 'report', windowDays: 7 }, RAW_B);
    expect(bToken.id).not.toBe(aToken.id);

    // org B's list contains its own token, never org A's
    const list = await app.inject({
      method: 'GET',
      url: '/api/share',
      headers: { authorization: `Bearer ${RAW_B}` },
    });
    const tokens = (list.json() as { tokens: Array<{ id: string }> }).tokens;
    expect(tokens.map((t) => t.id)).toContain(bToken.id);
    expect(tokens.map((t) => t.id)).not.toContain(aToken.id);

    // org B cannot revoke org A's token (404 — no cross-org oracle)
    const cross = await app.inject({
      method: 'POST',
      url: `/api/share/${aToken.id as string}/revoke`,
      headers: { authorization: `Bearer ${RAW_B}` },
    });
    expect(cross.statusCode).toBe(404);

    // org B's shared report: org B's spend + samples only
    const pub = await app.inject({
      method: 'GET',
      url: `/api/public/share/${bToken.token as string}/report`,
    });
    expect(pub.statusCode).toBe(200);
    const report = (pub.json() as { report: { actualSpendUsd: number; alternatives: unknown[] } })
      .report;
    expect(report.actualSpendUsd).toBeCloseTo(0.5, 10);
    expect(report.alternatives).toHaveLength(1);
  });
});
