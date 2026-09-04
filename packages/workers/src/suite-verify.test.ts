// guarantee:suite-verify tests (G2.1 trust hierarchy) — PGlite, zero
// network, mock provider mode throughout (the handler stamps providerMode
// on every verdict; a mock deployment renders mock-LABELED verdicts, which
// is exactly what these tests pin). The full advisory → enqueue → verify →
// resolution chain runs e2e; retention arithmetic is pinned via the pure
// computeRetention; live-only rails (budget refusal) are pinned to refuse
// BEFORE any provider access.
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { strategyHash, type EvalResult, type Policy, type StrategyConfig } from '@potion/core';
import {
  createDb,
  createOrg,
  designateIncumbent,
  evalRuns,
  getIncidentByIdForOrg,
  insertEvalResult,
  insertIncident,
  insertPolicy,
  insertQualitySample,
  insertTraceSpans,
  latestActiveRollback,
  listIncidents,
  migrate,
  openAdvisoryForTuple,
  policies,
  strategyConfigs,
  upsertBudget,
  upsertStrategyConfig,
  listGuaranteeVerdicts,
  loadDerivedSuite,
  listSuiteCertifications,
  type DbHandle,
  type NewTraceSpan,
} from '@potion/db';
import { eq } from 'drizzle-orm';
import { evalTaskById } from '@potion/providers';
import {
  computeRetention,
  createGuaranteeEvaluateHandler,
  guaranteeSuiteVerifyHandler,
  orgHashOf,
  suiteCertifyHandler,
  toolSignatureSlug,
  tracesClusterHandler,
  SUITE_VERIFY_EPSILON,
  RECOVERY_UNCONFIRMED_AFTER,
  type GuaranteeSuiteVerifyResult,
  type JobContext,
} from './handlers.js';

const REPO_PRICES = fileURLToPath(new URL('../../../prices.json', import.meta.url));

const ORG = 'org_sv';
const PID = 'pol-sv';
const CFG_SERVING: StrategyConfig = { type: 'single', model: 'mock-frontier' };
const CFG_INCUMBENT: StrategyConfig = { type: 'single', model: 'mock-cheap' };
const H_SERVING = strategyHash(CFG_SERVING);
const H_INCUMBENT = strategyHash(CFG_INCUMBENT);

let root: string;
let pricesPath: string;
let db: DbHandle;

function wordHash(word: string): number {
  let h = 0;
  for (let i = 0; i < word.length; i++) h = (Math.imul(h, 31) + word.charCodeAt(i)) | 0;
  return Math.abs(h);
}
const fakeEmbedder = {
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => {
      const v = new Array<number>(384).fill(0);
      for (const w of t.toLowerCase().split(/[^a-z0-9]+/)) if (w.length > 0) v[wordHash(w) % 384]! += 1;
      const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
      return v.map((x) => x / norm);
    });
  },
};

function ctx(queue?: { enqueue(kind: string, payload: unknown): Promise<void> }): JobContext {
  return {
    db: db.db,
    dbHandle: db,
    pricesPath,
    embedder: fakeEmbedder,
    ...(queue !== undefined ? { queue: queue as never } : {}),
  };
}

// Fixture times are RELATIVE to the test run (base = 24h ago): clustering
// windows `sinceDays: 7` back from now, so hardcoded calendar dates rot out
// of the window as real time advances (the '2026-08-06T…' literals these
// replace expired on 2026-08-13).
//
// F21 — THIS RULE WAS BROKEN A SECOND TIME, and nothing noticed. After the
// 2026-08-13 fix, two step-suite fixtures were added carrying fresh
// `new Date('2026-08-10T09:00:00Z')` literals. They passed for four days and
// began failing on 2026-08-17, when wall-clock crossed that date plus the
// 7-day window, with messages that named the symptom and nothing else:
// `unknown cluster 'agent-a1605b-acd14c'` and a null `-replays-v2` suite.
// That reads exactly like a real defect in the step-level flip, which is what
// makes this failure mode expensive — it burns an investigation each time.
//
// A comment did not hold the line, because a comment is not a check. The
// meta-test at the bottom of this file re-greps this source for date literals
// and fails by name, so the third occurrence is caught at authoring time.
const FIXTURE_BASE_MS = Date.now() - 24 * 60 * 60 * 1000;
const fixtureTs = (minutes = 0): string => new Date(FIXTURE_BASE_MS + minutes * 60_000).toISOString();

function span(over: Partial<NewTraceSpan>): NewTraceSpan {
  return {
    orgId: ORG,
    traceId: 'tr',
    spanId: 'sp',
    name: 'agent.root',
    model: 'mock-cheap',
    usage: { input_tokens: 10, output_tokens: 5 },
    costUsd: 0,
    attrs: {},
    ts: new Date(),
    ...over,
  };
}

/** Six near-identical traces (digit runs collapse post-redaction) → one
 * cluster with a 6-item derived suite: enough for the 5-pair floor. */
async function seedCluster(): Promise<string> {
  for (let i = 1; i <= 6; i++) {
    const t = `tr_sv${i}`;
    await insertTraceSpans(db.db, [
      span({
        traceId: t,
        spanId: `${t}_root`,
        attrs: {
          'gen_ai.prompt': `Audit the payment retries for account 1000200${i}`,
          'gen_ai.completion': `Fixed retries for account 1000200${i}.`,
        },
      }),
      span({
        traceId: t,
        spanId: `${t}_tool`,
        name: 'tool.billing',
        attrs: { 'gen_ai.operation.name': 'execute_tool' },
        ts: new Date(Date.now() + 60_000),
      }),
    ]);
  }
  await tracesClusterHandler({ orgId: ORG }, ctx());
  return `agent-${orgHashOf(ORG)}-${toolSignatureSlug(['billing'])}`;
}

/**
 * An HONESTLY certifiable cluster (post-capstone item 3 — the owner rule:
 * fixtures reconstruct REAL certifications, never stub the gate). The mock
 * judge is only discriminative on CORPUS content (base 0.5 otherwise), so a
 * cluster whose sessions are corpus tasks — recorded completion = the corpus
 * reference — is the one construction where a frontier-class incumbent can
 * genuinely score ≥ the certification floor through the real path.
 * Six identical-prompt traces → one cluster (tool 'ledger'), 6-item v1 suite.
 */
async function seedCertifiableCluster(): Promise<string> {
  // Six DISTINCT corpus tasks (ratio spread for CI-sensitive tests) whose
  // prompts differ only in the EVAL id — the mock answers and judges by TASK
  // ID, not prompt text, so the near-identical prompts guarantee one cluster
  // while the qualities stay per-task.
  for (let i = 1; i <= 6; i++) {
    const task = evalTaskById(`ex-0${i}`)!;
    const prompt = `Reconcile the ledger batch and answer the embedded record task. EVAL: ${task.id}`;
    const t = `tr_cert${i}`;
    await insertTraceSpans(db.db, [
      span({
        traceId: t,
        spanId: `${t}_root`,
        attrs: { 'gen_ai.prompt': prompt, 'gen_ai.completion': task.reference },
        ts: new Date(FIXTURE_BASE_MS + i * 60_000),
      }),
      span({
        traceId: t,
        spanId: `${t}_tool`,
        name: 'tool.ledger',
        attrs: { 'gen_ai.operation.name': 'execute_tool' },
        ts: new Date(FIXTURE_BASE_MS + i * 60_000 + 30_000),
      }),
    ]);
  }
  await tracesClusterHandler({ orgId: ORG }, ctx());
  return `agent-${orgHashOf(ORG)}-${toolSignatureSlug(['ledger'])}`;
}

/** Run the REAL certification job and require it to pass — a measurement,
 * never a seeded row. The incumbent must be designated first. */
async function certifyForReal(clusterId: string): Promise<void> {
  const r = await suiteCertifyHandler({ orgId: ORG, clusterId }, ctx());
  expect(r.status).toBe('certified');
  expect(r.certificationId).not.toBeNull();
}

function guaranteeWith(over: Partial<NonNullable<Policy['guarantee']>> = {}): Policy {
  return {
    type: 'min_cost',
    qualityFloor: 0,
    guarantee: { minQuality: 0.6, windowMin: 60, sampleRate: 1, action: 'alert', ...over },
  };
}

async function seedPolicyAndStrategies(policy: Policy): Promise<void> {
  await insertPolicy(db.db, { id: PID, orgId: ORG, name: 'sv', config: policy });
  await upsertStrategyConfig(db.db, H_SERVING, CFG_SERVING);
  await upsertStrategyConfig(db.db, H_INCUMBENT, CFG_INCUMBENT);
}

function verify(clusterId: string, over: Record<string, unknown> = {}): Promise<GuaranteeSuiteVerifyResult> {
  return guaranteeSuiteVerifyHandler(
    { orgId: ORG, policyId: PID, clusterId, servingStrategyHash: H_SERVING, ...over },
    ctx(),
  ) as Promise<GuaranteeSuiteVerifyResult>;
}

beforeEach(async () => {
  root = mkdtempSync(path.join(tmpdir(), 'potion-suiteverify-'));
  pricesPath = path.join(root, 'prices.json');
  copyFileSync(REPO_PRICES, pricesPath);
  db = await createDb();
  await migrate(db.db);
  await createOrg(db.db, { id: ORG, name: 'SV' });
  delete process.env.POTION_EVAL_PROVIDER;
});

afterEach(async () => {
  delete process.env.POTION_EVAL_PROVIDER;
  await db.close();
  rmSync(root, { recursive: true, force: true });
});

describe('computeRetention (pure)', () => {
  const pair = (i: number, c: number, inc: number) => ({ itemId: `it${i}`, candidateQuality: c, incumbentQuality: inc });

  it('epsilon-excludes incumbent-failed items and reports the count', () => {
    const pairs = [pair(1, 0.8, 0.9), pair(2, 0.7, 0.8), pair(3, 0.9, 0.85), pair(4, 0.6, 0.7), pair(5, 0.8, 0.9), pair(6, 0.5, 0.01)];
    const r = computeRetention(pairs, { seedKey: 'k', floor: 0.9 });
    expect(r.retention).not.toBeNull();
    expect(r.retention!.pairs).toBe(5);
    expect(r.retention!.excludedPairs).toBe(1);
    expect(r.retention!.epsilon).toBe(SUITE_VERIFY_EPSILON);
    // The excluded item's fabricated 50× ratio must not inflate the mean.
    expect(r.retention!.mean).toBeLessThan(1.5);
  });

  it('guards: under 5 usable pairs, or excluded majority → insufficient', () => {
    const four = [pair(1, 0.8, 0.9), pair(2, 0.7, 0.8), pair(3, 0.9, 0.85), pair(4, 0.6, 0.7)];
    expect(computeRetention(four, { seedKey: 'k', floor: 0.9 }).retention).toBeNull();
    const majorityExcluded = [
      pair(1, 0.8, 0.9), pair(2, 0.7, 0.8), pair(3, 0.9, 0.85), pair(4, 0.6, 0.7), pair(5, 0.8, 0.9),
      pair(6, 0.5, 0.01), pair(7, 0.5, 0.01), pair(8, 0.5, 0.01), pair(9, 0.5, 0.01), pair(10, 0.5, 0.01), pair(11, 0.5, 0.01),
    ];
    const r = computeRetention(majorityExcluded, { seedKey: 'k', floor: 0.9 });
    expect(r.retention).toBeNull();
    expect(r.insufficient).toContain('6 excluded');
  });

  it('is seeded-deterministic: same pairs → identical mean/ci/seed', () => {
    const pairs = Array.from({ length: 8 }, (_, i) => pair(i, 0.5 + i * 0.05, 0.7 + i * 0.02));
    const a = computeRetention(pairs, { seedKey: 'det', floor: 0.9 });
    const b = computeRetention(pairs, { seedKey: 'det', floor: 0.9 });
    expect(a.retention).toEqual(b.retention);
    // A different seed key re-seeds the bootstrap.
    const c = computeRetention(pairs, { seedKey: 'other', floor: 0.9 });
    expect(c.retention!.seed).not.toBe(a.retention!.seed);
  });
});

describe('guarantee:suite-verify handler (mock mode)', () => {
  it('no incumbent → recorded outcome, no spend, advisory untouched', async () => {
    const clusterId = await seedCluster();
    await seedPolicyAndStrategies(guaranteeWith());
    const r = await verify(clusterId);
    expect(r.outcome).toBe('no-incumbent');
    expect(r.spendUsd).toBe(0);
    expect(r.runId).toBeNull();
  });

  it('incumbent strategy missing from strategy_configs → incumbent-unresolvable', async () => {
    const clusterId = await seedCluster();
    await seedPolicyAndStrategies(guaranteeWith());
    await designateIncumbent(db.db, ORG, clusterId, H_INCUMBENT);
    await db.db.delete(strategyConfigs).where(eq(strategyConfigs.hash, H_INCUMBENT));
    const r = await verify(clusterId);
    expect(r.outcome).toBe('incumbent-unresolvable');
    expect(r.detail).toContain('re-designate');
  });

  it('serving IS the incumbent → all-clear by identity, no eval spend', async () => {
    const clusterId = await seedCluster();
    await seedPolicyAndStrategies(guaranteeWith());
    await designateIncumbent(db.db, ORG, clusterId, H_SERVING);
    const r = await verify(clusterId);
    expect(r.outcome).toBe('self-incumbent');
    expect(r.runId).toBeNull();
    expect(r.spendUsd).toBe(0);
  });

  it('floor 0 → all-clear with full mock-stamped retention evidence + run row', async () => {
    const clusterId = await seedCluster();
    await seedPolicyAndStrategies(guaranteeWith({ retentionFloor: 0 }));
    await designateIncumbent(db.db, ORG, clusterId, H_INCUMBENT);
    const r = await verify(clusterId);
    expect(r.outcome).toBe('all-clear');
    expect(r.providerMode).toBe('mock');
    expect(r.retention).not.toBeNull();
    expect(r.retention!.pairs).toBeGreaterThanOrEqual(5);
    expect(r.retention!.floor).toBe(0);
    expect(r.retention!.seed).toBeTypeOf('number');
    expect(r.verdictIncidentId).toBeNull();
    const runRows = await db.db.select().from(evalRuns).where(eq(evalRuns.id, r.runId!));
    expect(runRows).toHaveLength(1);
    expect(runRows[0]!.orgId).toBe(ORG);
    expect(runRows[0]!.provider).toBe('mock');
  });

  it('unreachable floor → CONTRACTUAL breach: quality_breach with the full evidence block', async () => {
    const clusterId = await seedCertifiableCluster();
    // retentionFloor far above any possible CI upper — forces the breach
    // branch deterministically (mock scores are seeded). Incumbent is the
    // FRONTIER class (the certifiable one); the cheap strategy is on trial.
    await seedPolicyAndStrategies(guaranteeWith({ retentionFloor: 5 }));
    await designateIncumbent(db.db, ORG, clusterId, H_SERVING);
    await certifyForReal(clusterId);
    const r = await verify(clusterId, { servingStrategyHash: H_INCUMBENT });
    expect(r.outcome).toBe('contractual-breach');
    expect(r.verdictIncidentId).not.toBeNull();
    const incidents = await listIncidents(db.db, ORG);
    const verdict = incidents.find((i) => i.id === r.verdictIncidentId)!;
    expect(verdict.kind).toBe('quality_breach');
    const detail = verdict.detail as Record<string, unknown>;
    // A verdict without provenance is a test failure.
    expect(detail.leg).toBe('suite');
    expect(detail.retention).toBeTruthy();
    expect(detail.suiteId).toBe(`${clusterId}-replays-v1`);
    expect(detail.suiteVersion).toBeTruthy(); // '1.0.0' — semver string
    expect((detail.incumbent as Record<string, unknown>).hash).toBe(H_SERVING);
    expect(detail.runId).toBe(r.runId);
    expect(detail.providerMode).toBe('mock');
  });

  it('live mode: hard-stop budget refuses BEFORE any provider access, recorded not thrown', async () => {
    const clusterId = await seedCluster();
    await seedPolicyAndStrategies(guaranteeWith());
    await designateIncumbent(db.db, ORG, clusterId, H_INCUMBENT);
    await upsertBudget(db.db, { orgId: ORG, monthlyCapUsd: 0.01, hardStop: true, warnPct: 80 });
    process.env.POTION_EVAL_PROVIDER = 'live';
    const r = await verify(clusterId);
    expect(r.outcome).toBe('budget-refused');
    expect(r.spendUsd).toBe(0);
    expect(r.detail).toContain('no spend occurred');
  });

  it('e2e chain: advisory crossing → suite-verify enqueue → verify resolves the advisory', async () => {
    const clusterId = await seedCertifiableCluster();
    const policy = guaranteeWith({ retentionFloor: 0 });
    await seedPolicyAndStrategies(policy);
    await designateIncumbent(db.db, ORG, clusterId, H_SERVING); // frontier — certifiable
    await certifyForReal(clusterId);
    // Incumbent serve-path baseline high, serving window confidently low.
    for (const [hash, qs] of [
      [H_SERVING, [0.8, 0.82, 0.78, 0.81, 0.79, 0.8, 0.8, 0.81]],
      [H_INCUMBENT, [0.3, 0.32, 0.28, 0.31, 0.29, 0.3]],
    ] as const) {
      for (const q of qs) {
        await insertQualitySample(db.db, {
          orgId: ORG,
          strategyHash: hash,
          quality: q,
          createdAt: new Date(),
          policyId: PID,
          clusterId,
        });
      }
    }
    const enqueued: Array<{ kind: string; payload: Record<string, unknown> }> = [];
    const evalHandler = createGuaranteeEvaluateHandler({});
    const result = (await evalHandler(
      { orgId: ORG, policyId: PID, clusterId, strategyHash: H_INCUMBENT, policy },
      ctx({ enqueue: async (kind, payload) => void enqueued.push({ kind, payload: payload as Record<string, unknown> }) }),
    )) as { advisories: Array<{ incidentId: string; suiteVerifyEnqueued: boolean }> };
    expect(result.advisories).toHaveLength(1);
    expect(result.advisories[0]!.suiteVerifyEnqueued).toBe(true);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]!.kind).toBe('guarantee:suite-verify');
    expect(enqueued[0]!.payload.advisoryIncidentId).toBe(result.advisories[0]!.incidentId);

    // Run the enqueued verify: all-clear (floor 0) must RESOLVE the
    // advisory with the verdict recorded on the row.
    const r = (await guaranteeSuiteVerifyHandler(enqueued[0]!.payload as never, ctx())) as GuaranteeSuiteVerifyResult;
    expect(r.outcome).toBe('all-clear');
    expect(r.advisoryResolved).toBe(true);
    expect(
      await openAdvisoryForTuple(db.db, { orgId: ORG, policyId: PID, clusterId, fromStrategy: H_SERVING }),
    ).toBeNull();
    const incidents = await listIncidents(db.db, ORG);
    const advisory = incidents.find((i) => i.id === result.advisories[0]!.incidentId)!;
    expect(advisory.resolvedAt).not.toBeNull();
    expect((advisory.detail as Record<string, unknown>).resolution).toMatchObject({ verdict: 'all-clear' });
  });
});


// ---------------------------------------------------------------------------
// G2.2: starved verification, escalation, contractual dedupe, auto-restore
// ---------------------------------------------------------------------------

describe('G2.2 incident SLAs', () => {
  const HOURS = 3_600_000;

  function captureQueue() {
    const enqueued: Array<{ kind: string; payload: Record<string, unknown> }> = [];
    return {
      enqueued,
      queue: {
        enqueue: async (kind: string, payload: unknown) =>
          void enqueued.push({ kind, payload: payload as Record<string, unknown> }),
      },
    };
  }

  async function backdatedAdvisory(clusterId: string, hoursAgo: number): Promise<string> {
    return insertIncident(db.db, {
      orgId: ORG,
      kind: 'advisory',
      createdAt: new Date(Date.now() - hoursAgo * HOURS),
      detail: {
        leg: 'serve',
        policyId: PID,
        clusterId,
        fromStrategy: H_SERVING,
        ci95: [0.28, 0.32],
      },
    });
  }

  it('budget-refused verify appends a DURABLE attempt to the advisory ledger', async () => {
    const clusterId = await seedCluster();
    await seedPolicyAndStrategies(guaranteeWith());
    await designateIncumbent(db.db, ORG, clusterId, H_INCUMBENT);
    const advisoryId = await backdatedAdvisory(clusterId, 1);
    await upsertBudget(db.db, { orgId: ORG, monthlyCapUsd: 0.01, hardStop: true, warnPct: 80 });
    process.env.POTION_EVAL_PROVIDER = 'live';
    const r = await verify(clusterId, { advisoryIncidentId: advisoryId });
    expect(r.outcome).toBe('budget-refused');
    const advisory = await getIncidentByIdForOrg(db.db, ORG, advisoryId);
    expect(advisory!.resolvedAt).toBeNull(); // clock keeps running
    const detail = advisory!.detail as Record<string, unknown>;
    const attempts = detail.verifyAttempts as Array<{ outcome: string; detail: string }>;
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.outcome).toBe('budget-refused');
    expect(attempts[0]!.detail).toContain('no spend occurred');
    expect(detail.lastVerifyAttemptAt).toBeTruthy();
  });

  it('sweep retry pass re-enqueues stale open advisories WITH the advisory id; fresh stamps throttle', async () => {
    const clusterId = await seedCluster();
    await seedPolicyAndStrategies(guaranteeWith());
    const staleId = await backdatedAdvisory(clusterId, 2); // 120min > VERIFY_RETRY_MIN
    const { enqueued, queue } = captureQueue();
    const handler = createGuaranteeEvaluateHandler({});
    const result = (await handler({}, ctx(queue))) as { retriedVerifies: Array<{ incidentId: string }> };
    expect(result.retriedVerifies.map((r) => r.incidentId)).toEqual([staleId]);
    const verifies = enqueued.filter((e) => e.kind === 'guarantee:suite-verify');
    expect(verifies).toHaveLength(1);
    expect(verifies[0]!.payload.advisoryIncidentId).toBe(staleId);
    expect(verifies[0]!.payload.servingStrategyHash).toBe(H_SERVING);
    // The enqueue stamped verifyEnqueuedAt — the NEXT sweep throttles even
    // though no attempt has landed yet (H3: memory queue is serial).
    const again = (await handler({}, ctx(captureQueue().queue))) as { retriedVerifies: unknown[] };
    expect(again.retriedVerifies).toHaveLength(0);
  });

  it('escalation: advisory past verifySlaMin emits guarantee_unverifiable ONCE with the advisory clock', async () => {
    const clusterId = await seedCluster();
    await seedPolicyAndStrategies(guaranteeWith());
    const advisoryId = await backdatedAdvisory(clusterId, 5); // 300min > 240 default
    const unverifiable: string[] = [];
    const meter = { observeGuaranteeUnverifiable: (o: { orgId: string }) => void unverifiable.push(o.orgId) };
    const handler = createGuaranteeEvaluateHandler({ meter });
    const first = captureQueue();
    const r1 = (await handler({}, ctx(first.queue))) as { escalated: Array<{ incidentId: string }> };
    expect(r1.escalated.map((e) => e.incidentId)).toEqual([advisoryId]);
    expect(unverifiable).toEqual([ORG]);
    const alerts = first.enqueued.filter((e) => e.kind === 'alerts:dispatch');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.payload.event).toBe('guarantee_unverifiable');
    expect(alerts[0]!.payload.incidentId).toBe(advisoryId);
    const advisory = await getIncidentByIdForOrg(db.db, ORG, advisoryId);
    // The clock IS the advisory's createdAt — it kept running while starved.
    expect(alerts[0]!.payload.clockStartAt).toBe(advisory!.createdAt.toISOString());
    expect((advisory!.detail as Record<string, unknown>).escalation).toMatchObject({ verifySlaMin: 240 });
    // Second sweep: CAS already stamped → no re-emit, no double count.
    const second = captureQueue();
    const r2 = (await handler({}, ctx(second.queue))) as { escalated: unknown[] };
    expect(r2.escalated).toHaveLength(0);
    expect(second.enqueued.filter((e) => e.kind === 'alerts:dispatch')).toHaveLength(0);
    expect(unverifiable).toHaveLength(1);
  });

  it('contractual dedupe: a second breach verify resolves to the EXISTING incident, no duplicate', async () => {
    const clusterId = await seedCertifiableCluster();
    await seedPolicyAndStrategies(guaranteeWith({ retentionFloor: 5 })); // unreachable → breach
    await designateIncumbent(db.db, ORG, clusterId, H_SERVING); // frontier — certifiable
    await certifyForReal(clusterId);
    const first = await verify(clusterId, { servingStrategyHash: H_INCUMBENT });
    expect(first.outcome).toBe('contractual-breach');
    const advisoryId = await backdatedAdvisory(clusterId, 1);
    const second = await verify(clusterId, { servingStrategyHash: H_INCUMBENT, advisoryIncidentId: advisoryId });
    expect(second.outcome).toBe('contractual-breach');
    expect(second.verdictIncidentId).toBe(first.verdictIncidentId); // deduped
    expect(second.detail).toContain('deduped');
    expect(second.advisoryResolved).toBe(true); // advisory still resolves, pointing at the existing incident
    const incidents = await listIncidents(db.db, ORG);
    expect(incidents.filter((i) => i.kind === 'quality_breach')).toHaveLength(1);
    const advisory = incidents.find((i) => i.id === advisoryId)!;
    expect((advisory.detail as Record<string, unknown>).resolution).toMatchObject({
      escalatedTo: first.verdictIncidentId,
      deduped: true,
    });
  });

  it('auto-restore: CONFIDENT recovery (floor 0) resolves the rollback and emits guarantee_restored', async () => {
    const clusterId = await seedCertifiableCluster();
    await seedPolicyAndStrategies(guaranteeWith({ retentionFloor: 0, autoRestore: true }));
    await designateIncumbent(db.db, ORG, clusterId, H_SERVING); // frontier — certifiable
    await certifyForReal(clusterId);
    const rollbackId = await insertIncident(db.db, {
      orgId: ORG,
      kind: 'rollback',
      createdAt: new Date(Date.now() - 1 * HOURS),
      detail: { policyId: PID, clusterId, fromStrategy: H_INCUMBENT, toStrategy: H_SERVING },
    });
    const { enqueued, queue } = captureQueue();
    const r = (await guaranteeSuiteVerifyHandler(
      { orgId: ORG, policyId: PID, clusterId, servingStrategyHash: H_INCUMBENT, restoreForIncidentId: rollbackId },
      ctx(queue),
    )) as GuaranteeSuiteVerifyResult;
    expect(r.outcome).toBe('all-clear');
    expect(r.restoredIncidentId).toBe(rollbackId);
    expect(await latestActiveRollback(db.db, ORG, clusterId)).toBeNull(); // override lifted
    const restored = await getIncidentByIdForOrg(db.db, ORG, rollbackId);
    expect((restored!.detail as Record<string, unknown>).resolution).toMatchObject({
      resolvedBy: 'auto-restore',
      verdict: 'confident-recovery',
    });
    const alerts = enqueued.filter((e) => e.kind === 'alerts:dispatch');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.payload.event).toBe('guarantee_restored');
    // time-to-restore clock = the rollback's createdAt
    expect(alerts[0]!.payload.clockStartAt).toBe(restored!.createdAt.toISOString());
  });

  it('non-confident all-clears never restore; the Nth consecutive escalates recovery-unconfirmed ONCE', async () => {
    const clusterId = await seedCertifiableCluster();
    await seedPolicyAndStrategies(guaranteeWith({ retentionFloor: 0, autoRestore: true }));
    await designateIncumbent(db.db, ORG, clusterId, H_SERVING); // frontier — certifiable
    await certifyForReal(clusterId);
    // Probe verify (floor 0) to learn the deterministic retention CI, then
    // pin the floor INSIDE it: all-clear (upper ≥ floor) but NOT confident
    // (lower < floor).
    const probe = await verify(clusterId, { servingStrategyHash: H_INCUMBENT });
    expect(probe.outcome).toBe('all-clear');
    const [lo, hi] = probe.retention!.ci95;
    expect(lo).toBeLessThan(hi); // mock ratios have spread — floor fits between
    const floor = (lo + hi) / 2;
    await db.db
      .update(policies)
      .set({ config: guaranteeWith({ retentionFloor: floor, autoRestore: true }) })
      .where(eq(policies.id, PID));
    const rollbackId = await insertIncident(db.db, {
      orgId: ORG,
      kind: 'rollback',
      createdAt: new Date(Date.now() - 1 * HOURS),
      detail: { policyId: PID, clusterId, fromStrategy: H_INCUMBENT, toStrategy: H_SERVING },
    });
    let unconfirmedAlerts = 0;
    for (let i = 1; i <= RECOVERY_UNCONFIRMED_AFTER + 1; i++) {
      const { enqueued, queue } = captureQueue();
      const r = (await guaranteeSuiteVerifyHandler(
        { orgId: ORG, policyId: PID, clusterId, servingStrategyHash: H_INCUMBENT, restoreForIncidentId: rollbackId },
        ctx(queue),
      )) as GuaranteeSuiteVerifyResult;
      expect(r.outcome).toBe('all-clear');
      expect(r.restoredIncidentId).toBeNull(); // uncertainty NEVER auto-restores
      unconfirmedAlerts += enqueued.filter(
        (e) => e.kind === 'alerts:dispatch' && e.payload.event === 'guarantee_recovery_unconfirmed',
      ).length;
      if (i < RECOVERY_UNCONFIRMED_AFTER) expect(r.recoveryUnconfirmed).toBe(false);
      if (i === RECOVERY_UNCONFIRMED_AFTER) expect(r.recoveryUnconfirmed).toBe(true);
    }
    expect(unconfirmedAlerts).toBe(1); // CAS: once, even past N
    const rollback = await getIncidentByIdForOrg(db.db, ORG, rollbackId);
    expect(rollback!.resolvedAt).toBeNull(); // never silently restored
    expect((rollback!.detail as Record<string, unknown>).recoveryEscalation).toMatchObject({
      consecutiveNonConfident: RECOVERY_UNCONFIRMED_AFTER,
    });
    const attempts = (rollback!.detail as Record<string, unknown>).verifyAttempts as Array<{ outcome: string }>;
    expect(attempts.every((a) => a.outcome === 'all-clear-not-confident')).toBe(true);
  });

  it('legacy autoRestore is an honest no-op: active rollback + samples but NO incumbent → no restore verify', async () => {
    const clusterId = await seedCluster();
    await seedPolicyAndStrategies(guaranteeWith({ autoRestore: true }));
    await insertIncident(db.db, {
      orgId: ORG,
      kind: 'rollback',
      createdAt: new Date(Date.now() - 2 * HOURS),
      detail: { policyId: PID, clusterId, fromStrategy: H_SERVING, toStrategy: H_INCUMBENT },
    });
    await insertQualitySample(db.db, {
      orgId: ORG,
      strategyHash: H_INCUMBENT,
      quality: 0.8,
      createdAt: new Date(),
      policyId: PID,
      clusterId,
    });
    const { enqueued, queue } = captureQueue();
    const handler = createGuaranteeEvaluateHandler({});
    const r = (await handler({}, ctx(queue))) as { restoreVerifies: unknown[] };
    expect(r.restoreVerifies).toHaveLength(0);
    expect(enqueued.filter((e) => e.kind === 'guarantee:suite-verify')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 0029 — the verdict is DURABLE, whatever the outcome (post-G2.8 P1 fix).
// ---------------------------------------------------------------------------

describe('guarantee_verdicts durability (0029)', () => {
  it('an ALL-CLEAR with NO advisory persists a full verdict row — the P1 fix', async () => {
    // Pre-0029 this exact case wrote NOTHING: G2.8's contradictory 1.0645
    // all-clear left no inputs, no seed, no pairing, and could never be
    // root-caused. The manual verify with no advisory is the hole itself.
    const clusterId = await seedCluster();
    await seedPolicyAndStrategies(guaranteeWith({ retentionFloor: 0 }));
    await designateIncumbent(db.db, ORG, clusterId, H_INCUMBENT);
    const r = await verify(clusterId);
    expect(r.outcome).toBe('all-clear');
    expect(r.verdictId).not.toBeNull();

    const rows = await listGuaranteeVerdicts(db.db, ORG);
    expect(rows).toHaveLength(1);
    const v = rows[0]!;
    expect(v.id).toBe(r.verdictId);
    expect(v.outcome).toBe('all-clear');
    expect(v.advisoryIncidentId).toBeNull(); // no advisory — and STILL durable
    expect(v.incumbentHash).toBe(H_INCUMBENT);
    expect(v.candidateHash).toBe(H_SERVING);
    expect(v.providerMode).toBe('mock');
    expect(v.suiteId).toBe(`${clusterId}-replays-v1`);
    expect(v.supersededBy).toBeNull();
    // The diffable per-item record — the thing whose absence made G2.8's
    // disagreement unexplainable.
    const ret = v.retention as { pairEvidence?: Array<{ itemId: string; ratio: number }> } | null;
    expect(ret?.pairEvidence?.length).toBeGreaterThanOrEqual(5);
    const ids = ret!.pairEvidence!.map((x) => x.itemId);
    expect(ids).toEqual([...ids].sort());
  });

  it('a CONTRACTUAL BREACH writes the verdict row AND keeps its incident, linked', async () => {
    const clusterId = await seedCluster();
    await seedPolicyAndStrategies(guaranteeWith({ retentionFloor: 5 }));
    await designateIncumbent(db.db, ORG, clusterId, H_INCUMBENT);
    const r = await verify(clusterId);
    expect(r.outcome).toBe('contractual-breach');
    const v = (await listGuaranteeVerdicts(db.db, ORG))[0]!;
    expect(v.outcome).toBe('contractual-breach');
    // The alarm (incident) and the lab notebook (verdict) reference each other.
    expect(v.verdictIncidentId).toBe(r.verdictIncidentId);
  });

  it('recorded refusals write verdict rows too — no-incumbent and self-incumbent', async () => {
    const clusterId = await seedCluster();
    await seedPolicyAndStrategies(guaranteeWith({ retentionFloor: 0 }));
    // No designation → no-incumbent.
    const r1 = await verify(clusterId);
    expect(r1.outcome).toBe('no-incumbent');
    expect(r1.verdictId).not.toBeNull();
    // Designate, then verify the incumbent AGAINST ITSELF → self-incumbent.
    await designateIncumbent(db.db, ORG, clusterId, H_INCUMBENT);
    const r2 = await verify(clusterId, { servingStrategyHash: H_INCUMBENT });
    expect(r2.outcome).toBe('self-incumbent');
    const rows = await listGuaranteeVerdicts(db.db, ORG);
    expect(rows.map((x) => x.outcome).sort()).toEqual(['no-incumbent', 'self-incumbent']);
    // A refusal has no retention block — the row records the outcome + detail.
    expect(rows.find((x) => x.outcome === 'no-incumbent')!.retention).toBeNull();
    expect(rows.find((x) => x.outcome === 'no-incumbent')!.detail).toMatch(/no active incumbent/);
  });

  it('RUN-TWICE-DIFF on the full handler path: two verifies over identical evidence render byte-identical retention', async () => {
    // The whole-path application of the promoted lesson: not just
    // computeRetention in isolation, but pairing + retention through the
    // real handler, twice, against the same stored rows.
    const clusterId = await seedCluster();
    await seedPolicyAndStrategies(guaranteeWith({ retentionFloor: 0 }));
    await designateIncumbent(db.db, ORG, clusterId, H_INCUMBENT);
    const a = await verify(clusterId);
    const b = await verify(clusterId);
    expect(JSON.stringify(b.retention)).toBe(JSON.stringify(a.retention));
    // …and both runs are separately durable: two rows, same evidence.
    const rows = await listGuaranteeVerdicts(db.db, ORG);
    expect(rows).toHaveLength(2);
    expect(JSON.stringify(rows[0]!.retention)).toBe(JSON.stringify(rows[1]!.retention));
  });
});

describe('mode-mismatch guard (post-capstone item 1 — the leg-5c false-live lock)', () => {
  /** One live-provenance eval row is all hasLiveEvidence needs. */
  function liveEvalRow(clusterId: string): EvalResult {
    return {
      runId: 'run-live-ev',
      itemId: 'item-live-1',
      clusterId,
      strategyHash: H_SERVING,
      strategyConfig: CFG_SERVING,
      quality: 0.8,
      scorer: 'llm-judge',
      usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.01, latencyMs: 1 },
      latencyMs: { p50: 1, p95: 1, mean: 1 },
      modelVersions: {},
      pricesVersion: 'pv-live',
      providerMode: 'live',
      orgId: ORG,
      cacheKey: `ck-live-${clusterId}`,
      createdAt: fixtureTs(),
    };
  }

  it('a MOCK verify on a LIVE-evidence cluster refuses with a DURABLE verdict row — never stamps-and-proceeds', async () => {
    const clusterId = await seedCluster();
    await seedPolicyAndStrategies(guaranteeWith());
    await designateIncumbent(db.db, ORG, clusterId, H_INCUMBENT);
    await insertEvalResult(db.db, liveEvalRow(clusterId));
    // POTION_EVAL_PROVIDER deliberately unset (beforeEach) — the exact leg-5c
    // operator error: the handler would silently degrade to mock and render
    // a mock 1.0645 "all-clear" against a live contract.
    const r = await verify(clusterId);
    expect(r.outcome).toBe('mode-mismatch');
    expect(r.detail).toContain('POTION_EVAL_PROVIDER=live');
    expect(r.detail).toContain('false-live event');
    expect(r.spendUsd).toBe(0);
    expect(r.runId).toBeNull(); // refused BEFORE any eval run
    // The refusal is a measurement: durable 0029 row, honest mock stamp.
    expect(r.verdictId).not.toBeNull();
    const rows = await listGuaranteeVerdicts(db.db, ORG);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.outcome).toBe('mode-mismatch');
    expect(rows[0]!.providerMode).toBe('mock');
  });

  it('appends the refusal to an attached advisory ledger — the advisory stays open for a live retry', async () => {
    const clusterId = await seedCluster();
    await seedPolicyAndStrategies(guaranteeWith());
    await designateIncumbent(db.db, ORG, clusterId, H_INCUMBENT);
    await insertEvalResult(db.db, liveEvalRow(clusterId));
    const advisoryId = await insertIncident(db.db, {
      orgId: ORG,
      kind: 'advisory',
      detail: { leg: 'serve', policyId: PID, clusterId, fromStrategy: H_SERVING, ci95: [0.28, 0.32] },
    });
    const r = await verify(clusterId, { advisoryIncidentId: advisoryId });
    expect(r.outcome).toBe('mode-mismatch');
    const advisory = await getIncidentByIdForOrg(db.db, ORG, advisoryId);
    expect(advisory!.resolvedAt).toBeNull();
    const attempts = (advisory!.detail as Record<string, unknown>).verifyAttempts as Array<{ outcome: string }>;
    expect(attempts.map((a) => a.outcome)).toEqual(['mode-mismatch']);
  });

  it('resolves the STEP-LEVEL suite when one exists: the verdict is rendered over -replays-v2 (post-capstone item 2)', async () => {
    // A converter-v2 session: 6 llm.call steps → 6 step items (≥ the 5-pair
    // floor), so the whole retention pipeline runs over the step suite.
    const t0 = FIXTURE_BASE_MS;
    const spans = [
      span({ traceId: 'tr_step', spanId: 'tr_step_root', attrs: { 'gen_ai.prompt': 'Audit the payment retries for account <num>' }, ts: new Date(t0) }),
      ...Array.from({ length: 6 }, (_, i) =>
        span({
          traceId: 'tr_step',
          spanId: `tr_step_s${i + 1}`,
          name: 'llm.call',
          attrs: {
            'gen_ai.operation.name': 'llm_call',
            'gen_ai.completion': `step ${i + 1}: checked retry batch ${i + 1}`,
            'potion.step_index': i + 1,
          },
          ts: new Date(t0 + (i + 1) * 60_000),
        }),
      ),
      span({
        traceId: 'tr_step',
        spanId: 'tr_step_tool',
        name: 'tool.billing',
        attrs: { 'gen_ai.operation.name': 'execute_tool' },
        ts: new Date(t0 + 60_000),
      }),
      span({ traceId: 'tr_step', spanId: 'tr_step_chat', name: 'chat', attrs: { 'gen_ai.completion': 'step 6: checked retry batch 6' }, ts: new Date(t0 + 360_000) }),
    ];
    await insertTraceSpans(db.db, spans);
    await tracesClusterHandler({ orgId: ORG }, ctx());
    const clusterId = `agent-${orgHashOf(ORG)}-${toolSignatureSlug(['billing'])}`;
    await seedPolicyAndStrategies(guaranteeWith({ retentionFloor: 0 }));
    await designateIncumbent(db.db, ORG, clusterId, H_INCUMBENT);
    const r = await verify(clusterId);
    expect(r.outcome).toBe('all-clear');
    expect(r.retention!.pairs).toBe(6); // 6 step items paired, not 1 session
    const rows = await listGuaranteeVerdicts(db.db, ORG);
    expect(rows[0]!.suiteId).toBe(`${clusterId}-replays-v2`);
  });

  it('SUITE SCOPING: after the v1→v2 flip the verdict is measured on the suite it STAMPS, not the whole cluster', async () => {
    // Found by the invariant sweep. pairedQualities is cluster-scoped and
    // eval_results has no suite column, so a cluster that owns two suite
    // GENERATIONS was pairing both into one contractual number: more pairs
    // than the stamped suite has items, and a mean belonging to neither
    // suite. Reachable only since the step-level flip made two generations
    // possible — the defect arrived with that feature, not before it.
    const clusterId = await seedCluster(); // 6 sessions → v1 session suite
    await seedPolicyAndStrategies(guaranteeWith({ retentionFloor: 0 }));
    await designateIncumbent(db.db, ORG, clusterId, H_INCUMBENT);

    // Verdict #1 lays down v1 evidence on the cluster.
    const first = await verify(clusterId);
    expect(first.outcome).toBe('all-clear');
    const v1Items = (await loadDerivedSuite(db.db, `${clusterId}-replays-v1`))!.items.length;
    expect(first.retention!.pairs).toBe(v1Items);

    // The cluster flips to step-level synthesis: same tool signature, so the
    // SAME cluster id, now resolving to a v2 suite with its own roster.
    const t0 = FIXTURE_BASE_MS;
    await insertTraceSpans(db.db, [
      span({ traceId: 'tr_flip', spanId: 'tr_flip_root', attrs: { 'gen_ai.prompt': 'Audit the payment retries for account <num>' }, ts: new Date(t0) }),
      ...Array.from({ length: 6 }, (_, i) =>
        span({
          traceId: 'tr_flip',
          spanId: `tr_flip_s${i + 1}`,
          name: 'llm.call',
          attrs: { 'gen_ai.operation.name': 'llm_call', 'gen_ai.completion': `step ${i + 1}: checked batch ${i + 1}`, 'potion.step_index': i + 1 },
          ts: new Date(t0 + (i + 1) * 60_000),
        }),
      ),
      span({ traceId: 'tr_flip', spanId: 'tr_flip_tool', name: 'tool.billing', attrs: { 'gen_ai.operation.name': 'execute_tool' }, ts: new Date(t0 + 60_000) }),
      span({ traceId: 'tr_flip', spanId: 'tr_flip_chat', name: 'chat', attrs: { 'gen_ai.completion': 'step 6: checked batch 6' }, ts: new Date(t0 + 360_000) }),
    ]);
    await tracesClusterHandler({ orgId: ORG }, ctx());
    const v2 = (await loadDerivedSuite(db.db, `${clusterId}-replays-v2`))!;
    expect(v2.items.length).toBeGreaterThanOrEqual(5);

    const second = await verify(clusterId);
    const row = (await listGuaranteeVerdicts(db.db, ORG)).find((r) => r.id === second.verdictId)!;
    expect(row.suiteId).toBe(`${clusterId}-replays-v2`);

    // Every item behind the number belongs to the stamped suite, and the
    // count cannot exceed that suite's roster.
    const v2Ids = new Set(v2.items.map((i) => i.id));
    const evidenceIds = second.retention!.pairEvidence.map((p) => p.itemId);
    expect(evidenceIds.filter((id) => !v2Ids.has(id))).toEqual([]);
    expect(second.retention!.pairs).toBeLessThanOrEqual(v2Ids.size);
    // …and coverage is reported against THAT roster: a retired generation's
    // items are not gaps in the current suite.
    expect((row.unpairable as Array<{ itemId: string }>).filter((u) => !v2Ids.has(u.itemId))).toEqual([]);
  }, 60_000);

  it('mock-on-MOCK is untouched: the same cluster without live evidence verifies normally', async () => {
    const clusterId = await seedCluster();
    await seedPolicyAndStrategies(guaranteeWith({ retentionFloor: 0 }));
    await designateIncumbent(db.db, ORG, clusterId, H_INCUMBENT);
    const r = await verify(clusterId);
    expect(r.outcome).toBe('all-clear'); // the walkthrough world keeps working
    expect(r.providerMode).toBe('mock');
  });
});

describe('suite:certify + contractual gating (post-capstone item 3, Decision 2)', () => {
  it('the certifiable cluster CERTIFIES through the real path — measurement, evidence, durable row', async () => {
    const clusterId = await seedCertifiableCluster();
    await seedPolicyAndStrategies(guaranteeWith());
    await designateIncumbent(db.db, ORG, clusterId, H_SERVING); // frontier
    const r = await suiteCertifyHandler({ orgId: ORG, clusterId }, ctx());
    expect(r.status).toBe('certified');
    expect(r.outcome).toBe('certified');
    expect(r.selfRetentionMean).toBeGreaterThanOrEqual(0.9);
    expect(r.suiteVersion).toBe('1.0.0');
    const rows = await listSuiteCertifications(db.db, ORG);
    expect(rows[0]!.status).toBe('certified');
    const evidence = rows[0]!.evidence as Record<string, unknown>;
    expect(evidence.selfRetentionMean).toBe(r.selfRetentionMean);
    expect(evidence.floor).toBe(0.9);
    expect(evidence.executed).toBe(6);
    expect((evidence.perItem as unknown[]).length).toBe(6);
    expect(evidence.providerMode).toBe('mock');
  });

  it('a cheap-class incumbent honestly FAILS certification — the number is in the reason', async () => {
    const clusterId = await seedCertifiableCluster();
    await seedPolicyAndStrategies(guaranteeWith());
    await designateIncumbent(db.db, ORG, clusterId, H_INCUMBENT); // mock-cheap, 45% corruption
    const r = await suiteCertifyHandler({ orgId: ORG, clusterId }, ctx());
    expect(r.status).toBe('failed');
    expect(r.outcome).toBe('not-certified');
    expect(r.selfRetentionMean).not.toBeNull();
    expect(r.selfRetentionMean!).toBeLessThan(0.9);
    const rows = await listSuiteCertifications(db.db, ORG);
    expect(rows[0]!.status).toBe('failed');
    expect(rows[0]!.statusReason).toContain('below floor');
  });

  it('refusals are durable rows: no-incumbent, budget-refused (live), mode-mismatch', async () => {
    const clusterId = await seedCertifiableCluster();
    await seedPolicyAndStrategies(guaranteeWith());
    // no incumbent yet
    const r1 = await suiteCertifyHandler({ orgId: ORG, clusterId }, ctx());
    expect(r1.status).toBe('failed');
    expect(r1.outcome).toBe('no-incumbent');
    // budget refusal (live, fail-closed, recorded)
    await designateIncumbent(db.db, ORG, clusterId, H_SERVING);
    await upsertBudget(db.db, { orgId: ORG, monthlyCapUsd: 0.01, hardStop: true, warnPct: 80 });
    process.env.POTION_EVAL_PROVIDER = 'live';
    const r2 = await suiteCertifyHandler({ orgId: ORG, clusterId }, ctx());
    expect(r2.outcome).toBe('budget-refused');
    expect(r2.detail).toContain('no spend occurred');
    delete process.env.POTION_EVAL_PROVIDER;
    // mode-mismatch: live evidence + mock certification run
    await insertEvalResult(db.db, {
      runId: 'run-live-cert', itemId: 'it-live', clusterId, strategyHash: H_SERVING,
      strategyConfig: CFG_SERVING, quality: 0.8, scorer: 'llm-judge',
      usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.01, latencyMs: 1 },
      latencyMs: { p50: 1, p95: 1, mean: 1 }, modelVersions: {}, pricesVersion: 'pv',
      providerMode: 'live', orgId: ORG, cacheKey: `ck-live-cert-${clusterId}`,
      createdAt: fixtureTs(),
    });
    const r3 = await suiteCertifyHandler({ orgId: ORG, clusterId }, ctx());
    expect(r3.outcome).toBe('mode-mismatch');
    const rows = await listSuiteCertifications(db.db, ORG);
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.status).toBe('failed');
      expect(row.statusReason).toMatch(/^refused-/);
      expect((row.evidence as Record<string, unknown>).refused).toBe(true);
    }
  });

  it('UNCERTIFIED breach: verdict measured + durable, but NO incident, NO advisory resolution — the withholding is recorded', async () => {
    const clusterId = await seedCluster(); // the payment-retries cluster: honestly uncertifiable in mock
    await seedPolicyAndStrategies(guaranteeWith({ retentionFloor: 5 }));
    await designateIncumbent(db.db, ORG, clusterId, H_INCUMBENT);
    const advisoryId = await insertIncident(db.db, {
      orgId: ORG,
      kind: 'advisory',
      detail: { leg: 'serve', policyId: PID, clusterId, fromStrategy: H_SERVING, ci95: [0.28, 0.32] },
    });
    const r = await verify(clusterId, { advisoryIncidentId: advisoryId });
    expect(r.outcome).toBe('contractual-breach'); // measured honestly
    expect(r.contractualEffects).toBe('withheld-uncertified');
    expect(r.detail).toContain('contractual effects withheld');
    expect(r.verdictIncidentId).toBeNull(); // no incident opened
    // The verdict row is durable (0029 chokepoint) with the withholding named.
    const verdicts = await listGuaranteeVerdicts(db.db, ORG);
    expect(verdicts[0]!.outcome).toBe('contractual-breach');
    expect(verdicts[0]!.detail).toContain('uncertified-suite');
    // No quality_breach incident; the advisory stays OPEN with the attempt on its ledger.
    const incidents = await listIncidents(db.db, ORG);
    expect(incidents.filter((i) => i.kind === 'quality_breach')).toHaveLength(0);
    const advisory = incidents.find((i) => i.id === advisoryId)!;
    expect(advisory.resolvedAt).toBeNull();
    const attempts = (advisory.detail as Record<string, unknown>).verifyAttempts as Array<{ outcome: string; detail: string }>;
    expect(attempts[0]!.outcome).toBe('contractual-breach');
    expect(attempts[0]!.detail).toContain('withheld');
  });

  it('re-derivation invalidates certification: the next verify WITHHOLDS until re-certified', async () => {
    const clusterId = await seedCertifiableCluster();
    await seedPolicyAndStrategies(guaranteeWith({ retentionFloor: 0 }));
    await designateIncumbent(db.db, ORG, clusterId, H_SERVING);
    await certifyForReal(clusterId);
    const before = await verify(clusterId, { servingStrategyHash: H_INCUMBENT });
    expect(before.contractualEffects).toBe('applied');
    // A new session re-derives the suite → version bump → certification stale.
    const task = evalTaskById('ex-07')!;
    await insertTraceSpans(db.db, [
      span({ traceId: 'tr_cert7', spanId: 'tr_cert7_root', attrs: { 'gen_ai.prompt': `Reconcile the ledger batch and answer the embedded record task. EVAL: ${task.id}`, 'gen_ai.completion': task.reference }, ts: new Date(FIXTURE_BASE_MS + 7 * 60_000) }),
      span({ traceId: 'tr_cert7', spanId: 'tr_cert7_tool', name: 'tool.ledger', attrs: { 'gen_ai.operation.name': 'execute_tool' }, ts: new Date(FIXTURE_BASE_MS + 7 * 60_000 + 30_000) }),
    ]);
    await tracesClusterHandler({ orgId: ORG }, ctx());
    const after = await verify(clusterId, { servingStrategyHash: H_INCUMBENT });
    expect(after.contractualEffects).toBe('withheld-uncertified');
    expect(after.detail).toContain('re-derivation invalidates certification');
    // Re-certify against the new version → effects restored.
    await certifyForReal(clusterId);
    const again = await verify(clusterId, { servingStrategyHash: H_INCUMBENT });
    expect(again.contractualEffects).toBe('applied');
  });

  it('certification is byte-identical run-to-run (evidence determinism, the item-(0) discipline)', async () => {
    const clusterId = await seedCertifiableCluster();
    await seedPolicyAndStrategies(guaranteeWith());
    await designateIncumbent(db.db, ORG, clusterId, H_SERVING);
    const a = await suiteCertifyHandler({ orgId: ORG, clusterId }, ctx());
    const b = await suiteCertifyHandler({ orgId: ORG, clusterId }, ctx());
    expect(a.selfRetentionMean).toBe(b.selfRetentionMean);
    const rows = await listSuiteCertifications(db.db, ORG);
    const stripVolatile = (r: (typeof rows)[number]) => {
      const e = { ...(r.evidence as Record<string, unknown>) };
      delete e.runId; // fresh uuid per run — everything else must match
      return JSON.stringify({ status: r.status === 'superseded' ? 'certified' : r.status, e });
    };
    expect(stripVolatile(rows[0]!)).toBe(stripVolatile(rows[1]!));
  });
});

describe('F21 meta: no fixture may carry a calendar date literal', () => {
  // The check the two previous occurrences needed and did not have. Trace
  // fixtures feed `tracesClusterHandler`, which filters on a ROLLING window
  // (TRACES_CLUSTER_DEFAULT_SINCE_DAYS back from now). A literal date in one
  // of them is a timer: the suite keeps passing until wall-clock walks past
  // it, then fails for a reason that has nothing to do with any change
  // anybody made. It has now cost two investigations — 2026-08-13 and
  // 2026-08-17 — so it gets a test instead of a third comment.
  it('greps its own source and finds no YYYY-MM-DD literal', () => {
    const source = readFileSync(fileURLToPath(new URL('./suite-verify.test.ts', import.meta.url)), 'utf8');
    const offenders = source
      .split('\n')
      .map((line, i) => ({ line, n: i + 1 }))
      // Skip the prose that explains the rule (which necessarily quotes dates)
      // — only real code is a timer.
      .filter(({ line }) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .filter(({ line }) => /\d{4}-\d{2}-\d{2}/.test(line))
      .map(({ line, n }) => `  line ${n}: ${line.trim()}`);

    expect(
      offenders,
      'calendar-date literals in fixtures rot out of the clustering window as real time ' +
        'advances — use FIXTURE_BASE_MS (relative to now) instead:\n' + offenders.join('\n'),
    ).toEqual([]);
  });
});
