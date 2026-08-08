// guarantee:suite-verify tests (G2.1 trust hierarchy) — PGlite, zero
// network, mock provider mode throughout (the handler stamps providerMode
// on every verdict; a mock deployment renders mock-LABELED verdicts, which
// is exactly what these tests pin). The full advisory → enqueue → verify →
// resolution chain runs e2e; retention arithmetic is pinned via the pure
// computeRetention; live-only rails (budget refusal) are pinned to refuse
// BEFORE any provider access.
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { strategyHash, type Policy, type StrategyConfig } from '@potion/core';
import {
  createDb,
  createOrg,
  designateIncumbent,
  evalRuns,
  getIncidentByIdForOrg,
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
  type DbHandle,
  type NewTraceSpan,
} from '@potion/db';
import { eq } from 'drizzle-orm';
import {
  computeRetention,
  createGuaranteeEvaluateHandler,
  guaranteeSuiteVerifyHandler,
  orgHashOf,
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
    const clusterId = await seedCluster();
    // retentionFloor far above any possible CI upper — forces the breach
    // branch deterministically (mock scores are seeded).
    await seedPolicyAndStrategies(guaranteeWith({ retentionFloor: 5 }));
    await designateIncumbent(db.db, ORG, clusterId, H_INCUMBENT);
    const r = await verify(clusterId);
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
    expect((detail.incumbent as Record<string, unknown>).hash).toBe(H_INCUMBENT);
    expect(detail.runId).toBe(r.runId);
    expect(detail.providerMode).toBe('mock');
  });

  it('live mode: hard-stop budget refuses BEFORE any provider access, recorded not thrown', async () => {
    const clusterId = await seedCluster();
    await seedPolicyAndStrategies(guaranteeWith());
    await designateIncumbent(db.db, ORG, clusterId, H_INCUMBENT);
    await upsertBudget(db.db, { orgId: ORG, monthlyCapUsd: 0.01, hardStop: true });
    process.env.POTION_EVAL_PROVIDER = 'live';
    const r = await verify(clusterId);
    expect(r.outcome).toBe('budget-refused');
    expect(r.spendUsd).toBe(0);
    expect(r.detail).toContain('no spend occurred');
  });

  it('e2e chain: advisory crossing → suite-verify enqueue → verify resolves the advisory', async () => {
    const clusterId = await seedCluster();
    const policy = guaranteeWith({ retentionFloor: 0 });
    await seedPolicyAndStrategies(policy);
    await designateIncumbent(db.db, ORG, clusterId, H_INCUMBENT);
    // Incumbent serve-path baseline high, serving window confidently low.
    for (const [hash, qs] of [
      [H_INCUMBENT, [0.8, 0.82, 0.78, 0.81, 0.79, 0.8, 0.8, 0.81]],
      [H_SERVING, [0.3, 0.32, 0.28, 0.31, 0.29, 0.3]],
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
      { orgId: ORG, policyId: PID, clusterId, strategyHash: H_SERVING, policy },
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
    await upsertBudget(db.db, { orgId: ORG, monthlyCapUsd: 0.01, hardStop: true });
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
    const clusterId = await seedCluster();
    await seedPolicyAndStrategies(guaranteeWith({ retentionFloor: 5 })); // unreachable → breach
    await designateIncumbent(db.db, ORG, clusterId, H_INCUMBENT);
    const first = await verify(clusterId);
    expect(first.outcome).toBe('contractual-breach');
    const advisoryId = await backdatedAdvisory(clusterId, 1);
    const second = await verify(clusterId, { advisoryIncidentId: advisoryId });
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
    const clusterId = await seedCluster();
    await seedPolicyAndStrategies(guaranteeWith({ retentionFloor: 0, autoRestore: true }));
    await designateIncumbent(db.db, ORG, clusterId, H_INCUMBENT);
    const rollbackId = await insertIncident(db.db, {
      orgId: ORG,
      kind: 'rollback',
      createdAt: new Date(Date.now() - 1 * HOURS),
      detail: { policyId: PID, clusterId, fromStrategy: H_SERVING, toStrategy: H_INCUMBENT },
    });
    const { enqueued, queue } = captureQueue();
    const r = (await guaranteeSuiteVerifyHandler(
      { orgId: ORG, policyId: PID, clusterId, servingStrategyHash: H_SERVING, restoreForIncidentId: rollbackId },
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
    const clusterId = await seedCluster();
    await seedPolicyAndStrategies(guaranteeWith({ retentionFloor: 0, autoRestore: true }));
    await designateIncumbent(db.db, ORG, clusterId, H_INCUMBENT);
    // Probe verify (floor 0) to learn the deterministic retention CI, then
    // pin the floor INSIDE it: all-clear (upper ≥ floor) but NOT confident
    // (lower < floor).
    const probe = await verify(clusterId);
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
      detail: { policyId: PID, clusterId, fromStrategy: H_SERVING, toStrategy: H_INCUMBENT },
    });
    let unconfirmedAlerts = 0;
    for (let i = 1; i <= RECOVERY_UNCONFIRMED_AFTER + 1; i++) {
      const { enqueued, queue } = captureQueue();
      const r = (await guaranteeSuiteVerifyHandler(
        { orgId: ORG, policyId: PID, clusterId, servingStrategyHash: H_SERVING, restoreForIncidentId: rollbackId },
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
