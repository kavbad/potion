// G2.2 incident-SLA server surfaces:
//   · PARITY pin — the queueless in-process breach path emits the SAME
//     alert the worker emits; the delivery row lands with incident linkage,
//     the legacy SLA clock, and measured latency (real local HTTP capture)
//   · GET /api/alerts/deliveries — the audit incl. latency, org-scoped
//   · manual verify threads the open advisory id (202 body carries it)
//   · /api/guarantee/status — unverifiableAdvisories + honest autoRestore
//   · report verification states: pending / unverifiable (+ HTML banner)
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { sha256, strategyHash, type Policy, type StrategyConfig } from '@potion/core';
import {
  clusters,
  createOrg,
  designateIncumbent,
  insertAlertRule,
  insertApiKey,
  insertIncident,
  insertPolicy,
  insertQualitySample,
  upsertStrategyConfig,
} from '@potion/db';
import { buildServer } from '../src/server.js';
import { runGuaranteeSample } from '../src/guarantee.js';
import type { OrgProviders } from '../src/context.js';

const CFG_SERVING: StrategyConfig = { type: 'single', model: 'mock-mid' };
const CFG_INCUMBENT: StrategyConfig = { type: 'single', model: 'mock-cheap' };
const H_SERVING = strategyHash(CFG_SERVING);
const H_INCUMBENT = strategyHash(CFG_INCUMBENT);

const ORG = 'org_sla_srv';
const OTHER = 'org_sla_other';
const PID = 'pol-sla';
const KEY = 'pk_sla_key';
const CLUSTER = 'agent-slatest-billing';
const HOURS = 3_600_000;

const GUARANTEE = { minQuality: 0.99, windowMin: 60, sampleRate: 1, action: 'alert' as const };
const POLICY: Policy = { type: 'max_quality', costCeilingPer1K: 100, guarantee: GUARANTEE };

let app: FastifyInstance;
let capture: Server;
let captureUrl: string;
const captured: Array<Record<string, unknown>> = [];
const db = () => app.potion.db.db;

function orgProvidersOf(): OrgProviders {
  return {
    providers: app.potion.providers,
    resolve: app.potion.resolve,
    source: 'platform',
  } as unknown as OrgProviders;
}

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
  capture = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try {
        captured.push(JSON.parse(body) as Record<string, unknown>);
      } catch {
        captured.push({ raw: body });
      }
      res.writeHead(200).end('ok');
    });
  });
  await new Promise<void>((r) => capture.listen(0, '127.0.0.1', r));
  captureUrl = `http://127.0.0.1:${(capture.address() as AddressInfo).port}/hook`;
  for (const [id, name] of [
    [ORG, 'SLA'],
    [OTHER, 'Other'],
  ] as const) {
    await createOrg(db(), { id, name });
  }
  await insertPolicy(db(), { id: PID, orgId: ORG, name: PID, config: POLICY });
  // G2.3: this key drives the ADMIN manual-verify route — explicit scope.
  await insertApiKey(db(), { id: `key-${PID}`, keyHash: sha256(KEY), name: PID, orgId: ORG, policyId: PID, scopes: 'serve+admin' });
  await upsertStrategyConfig(db(), H_SERVING, CFG_SERVING);
  await upsertStrategyConfig(db(), H_INCUMBENT, CFG_INCUMBENT);
  await db().insert(clusters).values({ id: CLUSTER, name: 'billing', description: 'sla test cluster', orgId: ORG });
  await insertAlertRule(db(), {
    orgId: ORG,
    kind: 'webhook',
    targetUrl: captureUrl,
    events: ['quality_breach', 'rollback', 'guarantee_unverifiable'] as never,
  });
}, 30000);

afterAll(async () => {
  await app.close();
  await new Promise<void>((r) => void capture.close(() => r()));
});

describe('in-process breach parity (G2.2)', () => {
  it('the queueless path emits the alert; delivery row carries incidentId + legacy clock + measured latency', async () => {
    // 5 confidently-low keyed samples; the sampled request adds a 6th and
    // the in-process evaluation breaches against minQuality 0.99.
    for (const q of [0.1, 0.12, 0.09, 0.11, 0.1]) {
      await insertQualitySample(db(), {
        orgId: ORG,
        strategyHash: H_SERVING,
        quality: q,
        createdAt: new Date(),
        policyId: PID,
        clusterId: CLUSTER,
      });
    }
    // `queue` is an OPTIONAL property, so under exactOptionalPropertyTypes it
    // must be ABSENT rather than explicitly undefined.
    const { queue: _queue, ...noQueueCtx } = app.potion;
    const evaluation = await runGuaranteeSample(
      noQueueCtx,
      {
        orgId: ORG,
        requestId: 'chatcmpl-sla-parity',
        clusterId: CLUSTER,
        messages: [{ role: 'user', content: 'Reconcile ledger entry 9' }],
        policy: POLICY,
        policyId: PID,
        orgProviders: orgProvidersOf(),
        served: { hash: H_SERVING, text: 'reconciled.' },
      },
      () => {},
    );
    expect(evaluation).not.toBeNull();
    expect(evaluation!.breach).toBe(true);
    expect(evaluation!.incidentId).not.toBeNull();
    expect(evaluation!.incidentAt).toBeInstanceOf(Date);
    // The webhook actually fired (in-process dispatch, real POST).
    expect(captured.some((c) => c.event === 'quality_breach')).toBe(true);
    // The delivery audit row: incident linkage, the LEGACY clock (= the
    // breach incident's createdAt), measured latency ≥ 0.
    const res = await app.inject({
      method: 'GET',
      url: '/api/alerts/deliveries',
      headers: { authorization: `Bearer ${KEY}` },
    });
    expect(res.statusCode).toBe(200);
    const rows = res.json().deliveries as Array<Record<string, unknown>>;
    const row = rows.find((d) => d.incidentId === evaluation!.incidentId)!;
    expect(row).toBeTruthy();
    expect(row.status).toBe('delivered');
    expect(row.clockStartAt).toBe(evaluation!.incidentAt!.toISOString());
    expect(typeof row.latencyMs).toBe('number');
    expect(row.latencyMs as number).toBeGreaterThanOrEqual(0);
  });

  it('GET /api/alerts/deliveries is org-scoped through the rule join', async () => {
    // The other org has no rules → no deliveries visible, not an error.
    await insertApiKey(db(), { id: 'key-other-sla', keyHash: sha256('pk_other_sla'), name: 'o', orgId: OTHER });
    const res = await app.inject({
      method: 'GET',
      url: '/api/alerts/deliveries',
      headers: { authorization: 'Bearer pk_other_sla' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().deliveries).toHaveLength(0);
  });
});

describe('manual verify threads the open advisory (G2.2)', () => {
  it('202 carries the advisory id; the verify run appends to the advisory ledger', async () => {
    await designateIncumbent(db(), ORG, CLUSTER, H_INCUMBENT);
    const advisoryId = await insertIncident(db(), {
      orgId: ORG,
      kind: 'advisory',
      detail: { leg: 'serve', policyId: PID, clusterId: CLUSTER, fromStrategy: H_SERVING },
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/guarantee/clusters/${CLUSTER}/verify`,
      headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
      payload: { policyId: PID, servingStrategyHash: H_SERVING },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json().advisoryIncidentId).toBe(advisoryId);
    // The job runs on the in-process worker: no derived suite exists for
    // this cluster, so the outcome is open-leaving — but it must land as a
    // DURABLE attempt on the advisory (starved verification is evidence).
    const job = await waitFor(
      async () =>
        (await app.inject({ method: 'GET', url: `/api/jobs/${res.json().jobId as string}`, headers: { authorization: `Bearer ${KEY}` } })).json(),
      (j: { state?: string }) => j.state === 'completed' || j.state === 'failed',
    );
    expect(job.state).toBe('completed');
    const incidents = await app.inject({
      method: 'GET',
      url: '/api/guarantee/status',
      headers: { authorization: `Bearer ${KEY}` },
    });
    const advisory = (incidents.json().policies[0].breaches as Array<Record<string, unknown>>).find(
      (b) => b.id === advisoryId,
    )!;
    const attempts = (advisory.detail as Record<string, unknown>).verifyAttempts as Array<{ outcome: string }>;
    expect(attempts.length).toBeGreaterThanOrEqual(1);
    expect(attempts[0]!.outcome).toBe('no-suite');
  });
});

describe('/api/guarantee/status G2.2 fields', () => {
  it('counts unverifiable (escalated) advisories and reports the honest autoRestore posture', async () => {
    await insertIncident(db(), {
      orgId: ORG,
      kind: 'advisory',
      createdAt: new Date(Date.now() - 6 * HOURS),
      detail: {
        leg: 'serve',
        policyId: PID,
        clusterId: CLUSTER,
        fromStrategy: 'sha-escalated',
        escalation: { at: new Date().toISOString(), verifySlaMin: 240, ageMin: 360, verifyAttempts: 2 },
      },
    });
    const res = await app.inject({
      method: 'GET',
      url: '/api/guarantee/status',
      headers: { authorization: `Bearer ${KEY}` },
    });
    const body = res.json();
    expect(body.unverifiableAdvisories).toBeGreaterThanOrEqual(1);
    // autoRestore not configured on this policy → configured false, no reason.
    const pol = body.policies.find((p: { policyId: string }) => p.policyId === PID);
    expect(pol.autoRestore).toEqual({ configured: false, effective: false, reason: null });
  });

  it('autoRestore configured WITHOUT an incumbent → effective:false with the structural reason', async () => {
    await createOrg(db(), { id: 'org_sla_legacy', name: 'Legacy' });
    await insertPolicy(db(), {
      id: 'pol-sla-legacy',
      orgId: 'org_sla_legacy',
      name: 'legacy',
      config: { ...POLICY, guarantee: { ...GUARANTEE, autoRestore: true } } as Policy,
    });
    await insertApiKey(db(), { id: 'key-sla-legacy', keyHash: sha256('pk_sla_legacy'), name: 'l', orgId: 'org_sla_legacy', policyId: 'pol-sla-legacy' });
    const res = await app.inject({
      method: 'GET',
      url: '/api/guarantee/status',
      headers: { authorization: 'Bearer pk_sla_legacy' },
    });
    const pol = res.json().policies[0];
    expect(pol.autoRestore.configured).toBe(true);
    expect(pol.autoRestore.effective).toBe(false);
    expect(pol.autoRestore.reason).toContain('structurally undetectable');
  });
});

describe('report verification states (G2.2)', () => {
  const today = new Date().toISOString().slice(0, 10);

  async function reportEntry(policyId: string, clusterId: string, key: string) {
    const res = await app.inject({
      method: 'GET',
      url: `/api/reports/guarantee?from=${today}&to=${today}`,
      headers: { authorization: `Bearer ${key}` },
    });
    expect(res.statusCode).toBe(200);
    return (res.json().entries as Array<Record<string, unknown>>).find(
      (e) => e.policyId === policyId && e.clusterId === clusterId,
    );
  }

  it("'unverifiable' names the starved state — report-time age check, reason string, HTML banner", async () => {
    // A fresh org so the earlier tests' incidents don't interfere.
    await createOrg(db(), { id: 'org_sla_rep', name: 'Rep' });
    await insertPolicy(db(), { id: 'pol-sla-rep', orgId: 'org_sla_rep', name: 'r', config: POLICY });
    await insertApiKey(db(), { id: 'key-sla-rep', keyHash: sha256('pk_sla_rep'), name: 'r', orgId: 'org_sla_rep', policyId: 'pol-sla-rep' });
    await insertQualitySample(db(), {
      orgId: 'org_sla_rep',
      strategyHash: H_SERVING,
      quality: 0.5,
      createdAt: new Date(),
      policyId: 'pol-sla-rep',
      clusterId: 'agent-rep-x',
    });
    // Open advisory aged past the default 240min bound, NOT yet sweep-
    // escalated — the report computes unverifiable at read time.
    await insertIncident(db(), {
      orgId: 'org_sla_rep',
      kind: 'advisory',
      createdAt: new Date(Date.now() - 5 * HOURS),
      detail: {
        leg: 'serve',
        policyId: 'pol-sla-rep',
        clusterId: 'agent-rep-x',
        fromStrategy: H_SERVING,
        verifyAttempts: [
          { at: new Date().toISOString(), outcome: 'budget-refused', detail: 'no spend occurred' },
        ],
      },
    });
    const entry = (await reportEntry('pol-sla-rep', 'agent-rep-x', 'pk_sla_rep'))!;
    const verification = entry.verification as Record<string, unknown>;
    expect(verification.state).toBe('unverifiable');
    expect(verification.openAdvisoryAgeMin as number).toBeGreaterThanOrEqual(300 - 1);
    expect(verification.verifyAttempts).toBe(1);
    expect((verification.lastAttempt as Record<string, unknown>).outcome).toBe('budget-refused');
    expect(entry.retentionUnavailableReason).toContain('guarantee currently unverifiable');
    expect(entry.retentionUnavailableReason).toContain('budget-refused');
    const html = await app.inject({
      method: 'GET',
      url: `/api/reports/guarantee?from=${today}&to=${today}&format=html`,
      headers: { authorization: 'Bearer pk_sla_rep' },
    });
    expect(html.body).toContain('Guarantee currently unverifiable');
    expect(html.body).toContain('clock keeps running');
  });

  it("a fresh open advisory reads 'pending', never unverifiable", async () => {
    await createOrg(db(), { id: 'org_sla_pend', name: 'Pend' });
    await insertPolicy(db(), { id: 'pol-sla-pend', orgId: 'org_sla_pend', name: 'p', config: POLICY });
    await insertApiKey(db(), { id: 'key-sla-pend', keyHash: sha256('pk_sla_pend'), name: 'p', orgId: 'org_sla_pend', policyId: 'pol-sla-pend' });
    await insertQualitySample(db(), {
      orgId: 'org_sla_pend',
      strategyHash: H_SERVING,
      quality: 0.5,
      createdAt: new Date(),
      policyId: 'pol-sla-pend',
      clusterId: 'agent-pend-x',
    });
    await insertIncident(db(), {
      orgId: 'org_sla_pend',
      kind: 'advisory',
      detail: { leg: 'serve', policyId: 'pol-sla-pend', clusterId: 'agent-pend-x', fromStrategy: H_SERVING },
    });
    const entry = (await reportEntry('pol-sla-pend', 'agent-pend-x', 'pk_sla_pend'))!;
    expect((entry.verification as Record<string, unknown>).state).toBe('pending');
    expect(entry.retentionUnavailableReason).not.toContain('unverifiable');
  });
});
