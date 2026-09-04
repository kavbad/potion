// G2.1 surfaces: completion-id correlation, incumbent designation routes,
// the guarantee report (retention HEADLINE, gap-filled series, labeled
// legs), and the widened /api/guarantee/status. Mock providers throughout.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sha256, strategyHash, type FrontierPoint, type Policy, type StrategyConfig } from '@potion/core';
import {
  activeIncumbent,
  clusters,
  createMembership,
  createOrg,
  createSession,
  createUser,
  designateIncumbent,
  insertApiKey,
  insertIncident,
  insertGuaranteeVerdict,
  derivedSuiteIdFor,
  upsertDerivedSuite,
  supersedeVerdict,
  insertPolicy,
  insertQualitySample,
  listQualitySamples,
  listRequestLogs,
  upsertStrategyConfig,
  type IncidentRow,
} from '@potion/db';
import { saveFrontier } from '@potion/pareto';
import { fileURLToPath } from 'node:url';
import { insertTraceSpans, type NewTraceSpan } from '@potion/db';
import { evalTaskById } from '@potion/providers';
import { suiteCertifyHandler, tracesClusterHandler, orgHashOf, toolSignatureSlug, type JobContext, type SuiteCertifyResult } from '@potion/workers';
import { buildServer } from '../src/server.js';
import { latestRetentionHeadline } from '../src/routes/guarantee-report.js';

const CFG_CHEAP: StrategyConfig = { type: 'single', model: 'mock-cheap' };
const CFG_MID: StrategyConfig = { type: 'single', model: 'mock-mid' };
const H_CHEAP = strategyHash(CFG_CHEAP);
const H_MID = strategyHash(CFG_MID);

const ORG = 'org_gr';
const KEY = 'pk_gr_key';
const PID = 'pol-gr';
const AGENT_CLUSTER = 'agent-grtest-billing';

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

const GUARANTEE = { minQuality: 0.99, windowMin: 60, sampleRate: 1, action: 'alert' as const };

let app: FastifyInstance;
const db = () => app.potion.db.db;

/** `suiteCertifyHandler` is declared as a `WorkerHandler`, whose contract
 *  resolves `unknown`; the implementation resolves a `SuiteCertifyResult`.
 *  Narrow it back through a REAL runtime check rather than a cast, so a
 *  handler that ever stopped returning one would fail loudly right here. */
function isSuiteCertifyResult(r: unknown): r is SuiteCertifyResult {
  return (
    typeof r === 'object' &&
    r !== null &&
    'status' in r &&
    (r.status === 'certified' || r.status === 'failed') &&
    'outcome' in r &&
    typeof r.outcome === 'string'
  );
}

async function certify(
  payload: Parameters<typeof suiteCertifyHandler>[0],
  ctx: JobContext,
): Promise<SuiteCertifyResult> {
  const r = await suiteCertifyHandler(payload, ctx);
  if (!isSuiteCertifyResult(r)) {
    throw new Error(`suite:certify did not return a SuiteCertifyResult: ${JSON.stringify(r)}`);
  }
  return r;
}

const today = new Date().toISOString().slice(0, 10);
// Fixture times RELATIVE to the test run (base = 24h ago): the clustering
// window is `sinceDays: 7` back from now, so hardcoded calendar dates rot
// out of it (the '2026-08-06T…' literals these replace expired 2026-08-13).
const FIXTURE_BASE_MS = Date.now() - 24 * 60 * 60 * 1000;


function retentionBlock(over: Record<string, unknown> = {}) {
  return {
    mean: 0.95,
    ci95: [0.9, 1.0],
    floor: 0.9,
    pairs: 8,
    excludedPairs: 1,
    seed: 42,
    resamples: 1000,
    epsilon: 0.05,
    ...over,
  };
}

beforeAll(async () => {
  app = await buildServer({ seed: false });
  await saveFrontier(db(), 'code-gen', [point(CFG_CHEAP, 0.5, 0.1), point(CFG_MID, 0.7, 1.0)], 'manual', '2026-08-04');
  await createOrg(db(), { id: ORG, name: 'GR' });
  await insertPolicy(db(), {
    id: PID,
    orgId: ORG,
    name: PID,
    config: { type: 'max_quality', costCeilingPer1K: 100, guarantee: GUARANTEE } as Policy,
  });
  await insertApiKey(db(), { id: `key-${PID}`, keyHash: sha256(KEY), name: PID, orgId: ORG, policyId: PID });
  await upsertStrategyConfig(db(), H_CHEAP, CFG_CHEAP);
  await upsertStrategyConfig(db(), H_MID, CFG_MID);
  await db()
    .insert(clusters)
    .values({ id: AGENT_CLUSTER, name: 'billing', description: 'test agent cluster', orgId: ORG });
  // Sessions: admin + viewer for the designation role checks.
  await createUser(db(), { id: 'usr_gr_admin', email: 'admin@gr.dev', name: 'admin' });
  await createMembership(db(), { orgId: ORG, userId: 'usr_gr_admin', role: 'admin' });
  await createSession(db(), {
    id: 'ses_gr_admin',
    userId: 'usr_gr_admin',
    tokenHash: sha256('ps_gr_admin'),
    orgId: ORG,
    expiresAt: new Date(Date.now() + 3600_000),
  });
  await createUser(db(), { id: 'usr_gr_viewer', email: 'viewer@gr.dev', name: 'viewer' });
  await createMembership(db(), { orgId: ORG, userId: 'usr_gr_viewer', role: 'viewer' });
  await createSession(db(), {
    id: 'ses_gr_viewer',
    userId: 'usr_gr_viewer',
    tokenHash: sha256('ps_gr_viewer'),
    orgId: ORG,
    expiresAt: new Date(Date.now() + 3600_000),
  });
}, 30000);

afterAll(async () => {
  await app.close();
});

async function waitFor<T>(fn: () => Promise<T>, pred: (v: T) => boolean, timeoutMs = 9000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let v = await fn();
  while (!pred(v) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
    v = await fn();
  }
  return v;
}

describe('completion-id correlation (G2.1)', () => {
  it('ok request logs its completion id; the sampled quality row + judge-spend row join on it', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
      payload: { model: 'potion-auto', messages: [{ role: 'user', content: 'Write a python function that reverses a string' }] },
    });
    expect(res.statusCode).toBe(200);
    const completionId = res.json().id as string;
    expect(completionId).toMatch(/^chatcmpl-/);
    // The serving row carries the id (correlation label, not an FK)...
    const logs = await waitFor(
      () => listRequestLogs(db(), ORG),
      (rows) => rows.some((r) => r.status === 'ok' && r.completionId === completionId),
    );
    expect(logs.some((r) => r.status === 'ok' && r.completionId === completionId)).toBe(true);
    // ...the sampled quality row joins on the same id...
    const samples = await waitFor(
      () => listQualitySamples(db(), ORG),
      (rows) => rows.some((r) => r.requestId === completionId),
    );
    expect(samples.some((r) => r.requestId === completionId)).toBe(true);
    // ...and the guarantee judge-spend meter row carries it too.
    const judgeRows = await waitFor(
      () => listRequestLogs(db(), ORG),
      (rows) => rows.some((r) => r.status === 'guarantee_judge' && r.completionId === completionId),
    );
    expect(judgeRows.some((r) => r.status === 'guarantee_judge' && r.completionId === completionId)).toBe(true);
  });
});

describe('incumbent designation routes (G2.1)', () => {
  it('viewer 403; unknown cluster 404; platform cluster 404; bad hash 400; admin designates; GET history', async () => {
    const post = (cluster: string, body: unknown, cookie: string) =>
      app.inject({
        method: 'POST',
        url: `/api/guarantee/clusters/${cluster}/incumbent`,
        headers: { cookie, 'content-type': 'application/json' },
        payload: body as Record<string, unknown>,
      });
    expect((await post(AGENT_CLUSTER, { strategyHash: H_MID }, 'potion_session=ps_gr_viewer')).statusCode).toBe(403);
    expect((await post('agent-nope-x', { strategyHash: H_MID }, 'potion_session=ps_gr_admin')).statusCode).toBe(404);
    // Platform cluster (org_id NULL): designation refused — the contractual
    // leg needs the org's OWN derived suite.
    expect((await post('code-gen', { strategyHash: H_MID }, 'potion_session=ps_gr_admin')).statusCode).toBe(404);
    expect((await post(AGENT_CLUSTER, {}, 'potion_session=ps_gr_admin')).statusCode).toBe(400);
    expect((await post(AGENT_CLUSTER, { strategyHash: 'sha-nope' }, 'potion_session=ps_gr_admin')).statusCode).toBe(400);

    const ok = await post(AGENT_CLUSTER, { strategyHash: H_MID }, 'potion_session=ps_gr_admin');
    expect(ok.statusCode).toBe(200);
    expect(ok.json().incumbent.strategyHash).toBe(H_MID);
    // Redesignate → supersession visible in history.
    const re = await post(AGENT_CLUSTER, { strategyHash: H_CHEAP }, 'potion_session=ps_gr_admin');
    expect(re.statusCode).toBe(200);
    const hist = await app.inject({
      method: 'GET',
      url: `/api/guarantee/clusters/${AGENT_CLUSTER}/incumbent`,
      headers: { cookie: 'potion_session=ps_gr_admin' },
    });
    expect(hist.statusCode).toBe(200);
    const body = hist.json();
    expect(body.active.strategyHash).toBe(H_CHEAP);
    expect(body.history).toHaveLength(2);
    expect(body.history.some((h: { status: string }) => h.status === 'superseded')).toBe(true);
    expect((await activeIncumbent(db(), ORG, AGENT_CLUSTER))?.strategyHash).toBe(H_CHEAP);
  });
});

describe('latestRetentionHeadline (pure)', () => {
  const rowBase = {
    orgId: ORG,
    resolvedAt: null as Date | null,
  };
  function row(over: Partial<IncidentRow> & { detail: Record<string, unknown> }): IncidentRow {
    return { id: 'inc', kind: 'quality_breach', createdAt: new Date(), ...rowBase, ...over } as IncidentRow;
  }

  it('picks the NEWEST verdict across breach incidents and resolved all-clear advisories', () => {
    const older = row({
      id: 'inc-old',
      kind: 'quality_breach',
      createdAt: new Date('2026-08-01T00:00:00Z'),
      detail: { leg: 'suite', policyId: PID, clusterId: AGENT_CLUSTER, retention: retentionBlock({ mean: 0.7 }), providerMode: 'mock' },
    });
    const newer = row({
      id: 'inc-new',
      kind: 'advisory',
      createdAt: new Date('2026-08-02T00:00:00Z'),
      resolvedAt: new Date('2026-08-03T00:00:00Z'),
      detail: {
        policyId: PID,
        clusterId: AGENT_CLUSTER,
        leg: 'serve',
        resolution: { verdict: 'all-clear', retention: retentionBlock({ mean: 0.97 }), providerMode: 'mock' },
      },
    });
    const h = latestRetentionHeadline([older, newer], PID, AGENT_CLUSTER)!;
    expect(h.verdict).toBe('all-clear');
    expect(h.mean).toBe(0.97);
    expect(h.providerMode).toBe('mock');
    // Wrong tuple → no headline.
    expect(latestRetentionHeadline([older, newer], PID, 'other-cluster')).toBeNull();
  });
});

describe('GET /api/reports/guarantee (G2.1)', () => {
  /** A REAL certification through the real path (post-capstone item 3 —
   * never a seeded row): corpus-task sessions (the one content the mock
   * judge is discriminative on), frontier incumbent, real certify job. */
  async function seedCertifiedCluster(): Promise<string> {
    const fakeEmbedder = {
      async embed(texts: string[]): Promise<number[][]> {
        return texts.map(() => new Array<number>(384).fill(0.05));
      },
    };
    const jobCtx: JobContext = {
      db: db(),
      dbHandle: app.potion.db,
      pricesPath: fileURLToPath(new URL('../../../prices.json', import.meta.url)),
      embedder: fakeEmbedder,
    };
    for (let i = 1; i <= 6; i++) {
      const task = evalTaskById(`ex-0${i}`)!;
      const t = `tr_gr_cert${i}`;
      const spans: NewTraceSpan[] = [
        {
          orgId: ORG, traceId: t, spanId: `${t}_root`, name: 'agent.root', model: 'mock-cheap',
          usage: { input_tokens: 10, output_tokens: 5 }, costUsd: 0,
          attrs: { 'gen_ai.prompt': `Reconcile the ledger batch and answer the embedded record task. EVAL: ${task.id}`, 'gen_ai.completion': task.reference },
          ts: new Date(FIXTURE_BASE_MS + i * 60_000),
        },
        {
          orgId: ORG, traceId: t, spanId: `${t}_tool`, name: 'tool.grledger', model: 'mock-cheap',
          usage: { input_tokens: 1, output_tokens: 1 }, costUsd: 0,
          attrs: { 'gen_ai.operation.name': 'execute_tool' },
          ts: new Date(FIXTURE_BASE_MS + i * 60_000 + 30_000),
        },
      ];
      await insertTraceSpans(db(), spans);
    }
    await tracesClusterHandler({ orgId: ORG }, jobCtx);
    const clusterId = `agent-${orgHashOf(ORG)}-${toolSignatureSlug(['grledger'])}`;
    const CFG_FRONTIER = { type: 'single', model: 'mock-frontier' } as const;
    await upsertStrategyConfig(db(), strategyHash(CFG_FRONTIER), CFG_FRONTIER);
    await designateIncumbent(db(), ORG, clusterId, strategyHash(CFG_FRONTIER));
    const cert = await certify({ orgId: ORG, clusterId }, jobCtx);
    expect(cert.status).toBe('certified'); // real measurement
    return clusterId;
  }

  async function seedCertifiedCluster2(): Promise<string> {
    for (let i = 1; i <= 6; i++) {
      const task = evalTaskById(`ex-0${i}`)!;
      await insertTraceSpans(db(), [
        { orgId: ORG, traceId: `tr_gr2_${i}`, spanId: `tr_gr2_${i}_r`, name: 'agent.root', model: 'mock-cheap', usage: { input_tokens: 10, output_tokens: 5 }, costUsd: 0,
          attrs: { 'gen_ai.prompt': `Reconcile the audit batch and answer the embedded record task. EVAL: ${task.id}`, 'gen_ai.completion': task.reference }, ts: new Date(FIXTURE_BASE_MS + 3_600_000 + i * 60_000) },
        { orgId: ORG, traceId: `tr_gr2_${i}`, spanId: `tr_gr2_${i}_t`, name: 'tool.graudit', model: 'mock-cheap', usage: { input_tokens: 1, output_tokens: 1 }, costUsd: 0,
          attrs: { 'gen_ai.operation.name': 'execute_tool' }, ts: new Date(FIXTURE_BASE_MS + 3_600_000 + i * 60_000 + 30_000) },
      ] as NewTraceSpan[]);
    }
    const fakeEmbedder2 = { async embed(texts: string[]): Promise<number[][]> { return texts.map(() => new Array<number>(384).fill(0.05)); } };
    const jobCtx2: JobContext = {
      db: db(),
      dbHandle: app.potion.db,
      pricesPath: fileURLToPath(new URL('../../../prices.json', import.meta.url)),
      embedder: fakeEmbedder2,
    };
    await tracesClusterHandler({ orgId: ORG }, jobCtx2);
    const clusterId = `agent-${orgHashOf(ORG)}-${toolSignatureSlug(['graudit'])}`;
    const CFG_F = { type: 'single', model: 'mock-frontier' } as const;
    await upsertStrategyConfig(db(), strategyHash(CFG_F), CFG_F);
    await designateIncumbent(db(), ORG, clusterId, strategyHash(CFG_F));
    const cert = await certify({ orgId: ORG, clusterId }, jobCtx2);
    expect(cert.status).toBe('certified');
    return clusterId;
  }

  it('renders entries with retention headline for a CERTIFIED cluster; uncertified clusters are gated; html variant', async () => {
    const certCluster = await seedCertifiedCluster();
    // Evidence: samples today for BOTH clusters + suite verdicts.
    for (const clusterId of [certCluster, AGENT_CLUSTER]) {
      for (const q of [0.8, 0.85, 0.9]) {
        await insertQualitySample(db(), {
          orgId: ORG,
          strategyHash: H_MID,
          quality: q,
          createdAt: new Date(),
          policyId: PID,
          clusterId,
        });
      }
      await insertIncident(db(), {
        orgId: ORG,
        kind: 'quality_breach',
        detail: {
          leg: 'suite',
          policyId: PID,
          clusterId,
          fromStrategy: H_MID,
          retention: retentionBlock({ mean: 0.82, ci95: [0.75, 0.88] }),
          providerMode: 'mock',
        },
      });
    }
    const res = await app.inject({
      method: 'GET',
      url: `/api/reports/guarantee?from=${today}&to=${today}`,
      headers: { authorization: `Bearer ${KEY}` },
    });
    expect(res.statusCode).toBe(200);
    const report = res.json();
    expect(report.orgId).toBe(ORG);
    type Entry = { policyId: string; clusterId: string } & Record<string, unknown>;
    const entry = report.entries.find(
      (e: Entry) => e.policyId === PID && e.clusterId === certCluster,
    );
    expect(entry).toBeTruthy();
    // HEADLINE renders for the CERTIFIED cluster: retention, never raw scores.
    expect(entry.retention.verdict).toBe('contractual-breach');
    expect(entry.retention.mean).toBe(0.82);
    expect(entry.retention.confidence).toBe('low'); // 8 pairs
    expect(entry.certification.certified).toBe(true);
    expect(entry.certification.selfRetentionMean).toBeGreaterThanOrEqual(0.9);
    expect(entry.incumbent).not.toBeNull();
    expect(report.legacyPath).toBe(false);
    // Gap-filled single-day series with the seeded samples.
    expect(entry.qualitySeries).toHaveLength(1);
    expect(entry.qualitySeries[0].day).toBe(today);
    expect(entry.qualitySeries[0].samples).toBeGreaterThanOrEqual(3);
    // Legs labeled on every incident.
    for (const i of entry.incidents) {
      expect(['serve', 'suite', 'legacy']).toContain(i.leg);
    }
    // THE GATE (owner requirement): the UNCERTIFIED agent cluster has the
    // same-shaped verdict evidence but renders NO number — reason instead.
    const gated = report.entries.find(
      (e: Entry) => e.policyId === PID && e.clusterId === AGENT_CLUSTER,
    );
    expect(gated).toBeTruthy();
    expect(gated.retention).toBeNull();
    expect(gated.retentionUnavailableReason).toContain('suite not certified');
    expect(gated.certification.certified).toBe(false);
    // HTML artifact variant.
    const html = await app.inject({
      method: 'GET',
      url: `/api/reports/guarantee?from=${today}&to=${today}&format=html`,
      headers: { authorization: `Bearer ${KEY}` },
    });
    expect(html.statusCode).toBe(200);
    expect(html.headers['content-type']).toContain('text/html');
    expect(html.body).toContain('Baseline retention');
    expect(html.body).toContain(certCluster); // certified headline in the artifact
    expect(html.body).toContain('suite not certified'); // gated reason visible too
  });

  it('NO-CLAIM PIN (post-capstone item 2): an agentic cluster with an incumbent but NO verdict renders null retention + a reason — never a number', async () => {
    // The cluster class step-level synthesis creates volume for: designated,
    // sampled, but no suite-verify verdict has ever rendered. The contract
    // (owner requirement 4): the report says "no claim yet", it does not
    // fabricate or approximate a retention figure.
    const cluster2 = 'agent-grtest-noverdict';
    await db()
      .insert(clusters)
      .values({ id: cluster2, name: 'noverdict', description: 'agentic, unverified', orgId: ORG });
    await designateIncumbent(db(), ORG, cluster2, H_CHEAP);
    await insertQualitySample(db(), {
      orgId: ORG,
      strategyHash: H_MID,
      quality: 0.9,
      createdAt: new Date(),
      policyId: PID,
      clusterId: cluster2,
    });
    const res = await app.inject({
      method: 'GET',
      url: `/api/reports/guarantee?from=${today}&to=${today}`,
      headers: { authorization: `Bearer ${KEY}` },
    });
    expect(res.statusCode).toBe(200);
    const entry = res.json().entries.find((e: { clusterId: string }) => e.clusterId === cluster2);
    expect(entry).toBeTruthy();
    expect(entry.retention).toBeNull();
    expect(entry.retentionUnavailableReason).toContain('no suite-verify verdict');
  });

  it('INSTRUMENT IDENTITY (swarm): a certified cluster does NOT publish a verdict measured on a DIFFERENT suite version', async () => {
    // The gate composed two differently-keyed facts: certification is keyed to
    // (suiteId, suiteVersion); latestVerdictForTuple is keyed to
    // (org, policy, cluster) with no suite constraint. So a number measured
    // while the cluster was uncertified — its contractual effects WITHHELD —
    // was published as the headline the moment any later suite version
    // certified. A certification vouches for an instrument, not a cluster.
    const clusterId = await seedCertifiedCluster2();
    // A verdict stamped with a DIFFERENT (earlier) suite generation.
    await insertGuaranteeVerdict(db(), {
      orgId: ORG, policyId: PID, clusterId, candidateHash: H_MID,
      suiteId: `${clusterId}-replays-v0-legacy`, suiteVersion: '0.9.0',
      providerMode: 'mock', outcome: 'contractual-breach',
      retention: retentionBlock({ mean: 0.27 }) as unknown as Record<string, unknown>,
    });
    await insertQualitySample(db(), { orgId: ORG, strategyHash: H_MID, quality: 0.9, createdAt: new Date(), policyId: PID, clusterId });

    const res = await app.inject({ method: 'GET', url: `/api/reports/guarantee?from=${today}&to=${today}`, headers: { authorization: `Bearer ${KEY}` } });
    const entry = res.json().entries.find((e: { clusterId: string }) => e.clusterId === clusterId);
    expect(entry).toBeTruthy();
    expect(entry.certification.certified).toBe(true); // the CLUSTER is certified…
    expect(entry.retention).toBeNull(); // …but this number's instrument is not
    expect(entry.retentionUnavailableReason).toContain("verdict's instrument");
  });

  async function seedCertifiedCluster3(): Promise<string> {
    const jc: JobContext = {
      db: db(), dbHandle: app.potion.db,
      pricesPath: fileURLToPath(new URL('../../../prices.json', import.meta.url)),
      embedder: { async embed(t: string[]): Promise<number[][]> { return t.map(() => new Array<number>(384).fill(0.05)); } },
    };
    for (let i = 1; i <= 6; i++) {
      const task = evalTaskById(`ex-0${i}`)!;
      await insertTraceSpans(db(), [
        { orgId: ORG, traceId: `tr_f11_${i}`, spanId: `tr_f11_${i}_r`, name: 'agent.root', model: 'mock-cheap', usage: { input_tokens: 10, output_tokens: 5 }, costUsd: 0,
          attrs: { 'gen_ai.prompt': `Settle the f11 batch and answer the embedded record task. EVAL: ${task.id}`, 'gen_ai.completion': task.reference }, ts: new Date(FIXTURE_BASE_MS + 7_200_000 + i * 60_000) },
        { orgId: ORG, traceId: `tr_f11_${i}`, spanId: `tr_f11_${i}_t`, name: 'tool.f11settle', model: 'mock-cheap', usage: { input_tokens: 1, output_tokens: 1 }, costUsd: 0,
          attrs: { 'gen_ai.operation.name': 'execute_tool' }, ts: new Date(FIXTURE_BASE_MS + 7_200_000 + i * 60_000 + 30_000) },
      ] as NewTraceSpan[]);
    }
    await tracesClusterHandler({ orgId: ORG }, jc);
    const clusterId = `agent-${orgHashOf(ORG)}-${toolSignatureSlug(['f11settle'])}`;
    const CFG_F = { type: 'single', model: 'mock-frontier' } as const;
    await upsertStrategyConfig(db(), strategyHash(CFG_F), CFG_F);
    await designateIncumbent(db(), ORG, clusterId, strategyHash(CFG_F));
    const cert = await certify({ orgId: ORG, clusterId }, jc);
    expect(cert.status).toBe('certified'); // a REAL measurement, never stubbed
    await insertQualitySample(db(), { orgId: ORG, strategyHash: H_MID, quality: 0.9, createdAt: new Date(), policyId: PID, clusterId });
    return clusterId;
  }

  it('AGREEMENT INVARIANT (F11): the certifications badge and the guarantee gate can never disagree', async () => {
    // The review surface derived `active` from the ROW's status while the
    // report derived withholding from the GATE (current suite + version).
    // They diverged the moment a suite was re-derived — CERTIFIED on one
    // screen, "not certified" on the other, in the same second.
    const clusterId = await seedCertifiedCluster3();

    const listOf = async () => {
      const r = await app.inject({ method: 'GET', url: '/api/certifications', headers: { cookie: 'potion_session=ps_gr_admin' } });
      expect(r.statusCode).toBe(200);
      return (r.json().certifications as Array<Record<string, unknown>>).filter((c) => c.clusterId === clusterId);
    };
    const gateOf = async () => {
      const r = await app.inject({ method: 'GET', url: `/api/reports/guarantee?from=${today}&to=${today}`, headers: { authorization: `Bearer ${KEY}` } });
      const e = r.json().entries.find((x: { clusterId: string }) => x.clusterId === clusterId);
      return e?.certification as { certified: boolean } | undefined;
    };

    // Freshly certified: the badge vouches and the gate agrees.
    const before = await listOf();
    expect(before.filter((c) => c.status === 'certified')).toHaveLength(1);
    expect(before.find((c) => c.status === 'certified')!.active).toBe(true);
    expect((await gateOf())?.certified).toBe(true);

    // Re-derive the suite: one new item bumps derived_suites.version, which
    // invalidates the certification BY KEY. Nothing about the row changes.
    const suiteId = await derivedSuiteIdFor(db(), clusterId);
    await upsertDerivedSuite(db(), {
      suiteId, clusterId, orgId: ORG,
      manifest: { suiteId },
      items: [{
        id: `${suiteId}-f11-extra`, clusterId,
        prompt: [{ role: 'user', content: 'a new item that moves the suite' }],
        reference: 'x',
        scoring: { kind: 'llm-judge', rubric: 'r', judgeModel: 'mock-judge', scale: [0, 1] },
      }],
      itemCap: 500,
    });

    // THE INVARIANT: both surfaces move together.
    const after = await listOf();
    const stillCertifiedRow = after.find((c) => c.status === 'certified')!;
    expect(stillCertifiedRow.status).toBe('certified'); // the ROW is unchanged…
    expect(stillCertifiedRow.active).toBe(false); // …but it no longer vouches
    expect(String(stillCertifiedRow.staleReason)).toContain('re-certify');
    expect((await gateOf())?.certified).toBe(false);
    // And the surface can say WHAT moved, without re-deriving the rule.
    expect(stillCertifiedRow.currentSuiteId).toBe(suiteId);
    expect(stillCertifiedRow.currentSuiteVersion).not.toBe(stillCertifiedRow.suiteVersion);
  });

  it('RETRACTED VERDICT (swarm): a superseded breach must not resurface through the pre-0029 incident fallback', async () => {
    // The incident scan cannot see supersession. Whenever the ACTIVE verdict
    // carries no headline — every recorded refusal outcome — the fallback
    // republished the retracted number as the customer-facing headline.
    const cl = 'agent-grtest-retracted';
    await db().insert(clusters).values({ id: cl, name: 'retracted', description: 'x', orgId: ORG });
    await designateIncumbent(db(), ORG, cl, H_CHEAP);
    await insertQualitySample(db(), { orgId: ORG, strategyHash: H_MID, quality: 0.9, createdAt: new Date(), policyId: PID, clusterId: cl });
    // A breach verdict + its incident (the shape the fallback scans for)…
    const inc = await insertIncident(db(), {
      orgId: ORG, kind: 'quality_breach',
      detail: { leg: 'suite', policyId: PID, clusterId: cl, fromStrategy: H_MID, retention: retentionBlock({ mean: 0.31 }), providerMode: 'mock' },
    });
    const breachId = await insertGuaranteeVerdict(db(), {
      orgId: ORG, policyId: PID, clusterId: cl, candidateHash: H_MID,
      providerMode: 'mock', outcome: 'contractual-breach',
      retention: retentionBlock({ mean: 0.31 }) as unknown as Record<string, unknown>,
      verdictIncidentId: inc,
    });
    // …then it is RETRACTED, and the newest active verdict is a refusal.
    const refusalId = await insertGuaranteeVerdict(db(), {
      orgId: ORG, policyId: PID, clusterId: cl, candidateHash: H_MID,
      providerMode: 'mock', outcome: 'mode-mismatch', detail: 'mock verify on a live-evidence cluster',
    });
    await supersedeVerdict(db(), { orgId: ORG, priorIds: [breachId], newId: refusalId, reason: 'measurement retracted' });

    const res = await app.inject({ method: 'GET', url: `/api/reports/guarantee?from=${today}&to=${today}`, headers: { authorization: `Bearer ${KEY}` } });
    const entry = res.json().entries.find((e: { clusterId: string }) => e.clusterId === cl);
    expect(entry).toBeTruthy();
    expect(entry.retention).toBeNull(); // NOT 0.31
    expect(entry.retentionUnavailableReason).toBeTruthy();
  });

  it('401 without credentials; 400 on malformed window', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/reports/guarantee', headers: { authorization: 'Bearer pk_nope' } })).statusCode).toBe(401);
    const bad = await app.inject({
      method: 'GET',
      url: '/api/reports/guarantee?from=nope&to=2026-08-07',
      headers: { authorization: `Bearer ${KEY}` },
    });
    expect(bad.statusCode).toBe(400);
  });
});

describe('GET /api/guarantee/status (G2.1 fields)', () => {
  it('surfaces incumbents, openAdvisories, retentionFloor, legacyPath', async () => {
    await insertIncident(db(), {
      orgId: ORG,
      kind: 'advisory',
      detail: { leg: 'serve', policyId: PID, clusterId: AGENT_CLUSTER, fromStrategy: H_MID },
    });
    const res = await app.inject({
      method: 'GET',
      url: '/api/guarantee/status',
      headers: { authorization: `Bearer ${KEY}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.incumbents.length).toBeGreaterThanOrEqual(1);
    // Find by cluster, not index — the no-claim-pin test designates a second
    // incumbent and designation order is not part of this contract.
    expect(
      body.incumbents.some((i: { clusterId: string }) => i.clusterId === AGENT_CLUSTER),
    ).toBe(true);
    expect(body.openAdvisories).toBeGreaterThanOrEqual(1);
    const pol = body.policies.find((p: { policyId: string }) => p.policyId === PID);
    expect(pol.retentionFloor).toBe(0.9);
    expect(pol.legacyPath).toBe(false);
  });
});
