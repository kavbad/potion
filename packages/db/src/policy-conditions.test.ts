// G2.6 — the standing policy-level condition (owner refinement: "persistent
// infeasibility escalates as a standing policy-level condition on the
// guarantee status, deduped, like advisories, not just per-request labels").
//
// It reuses the G2.2 advisory machinery rather than inventing a second one, so
// the tests that matter most are the SEPARATION tests: a policy-leg row must
// never enter the serve-leg advisory dedupe or the sweep's verification work
// set, and vice versa.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  POLICY_INFEASIBLE,
  clearPolicyCondition,
  createDb,
  insertIncident,
  listOpenAdvisories,
  listOpenPolicyConditions,
  migrate,
  openAdvisoryForTuple,
  openPolicyCondition,
  raisePolicyCondition,
  type DbHandle,
  type PolicyInfeasibleDetail,
} from './index.js';
import { ORG_A, ORG_B, seedIsolationOrgs } from './test-fixtures/orgs.js';

let handle: DbHandle;
const db = (): DbHandle['db'] => handle.db;

beforeEach(async () => {
  handle = await createDb();
  await migrate(handle.db);
  await seedIsolationOrgs(handle.db);
});

afterEach(async () => {
  await handle.close();
});

const detail = (over: Partial<PolicyInfeasibleDetail> = {}): PolicyInfeasibleDetail => ({
  leg: 'policy',
  condition: POLICY_INFEASIBLE,
  policyId: 'pol-a',
  clusterId: 'code-gen',
  boundMs: 1500,
  qualityFloor: 0.8,
  servedStrategy: 'h-strong',
  servedP95Ms: 3400,
  latencySource: 'serving',
  relaxLatencyToMs: 2100,
  relaxQualityToFloor: 0.72,
  ...over,
});

describe('raisePolicyCondition — dedupe', () => {
  it('mints ONE row however many violating requests are served', async () => {
    const first = await raisePolicyCondition(db(), detail(), ORG_A);
    expect(first.created).toBe(true);
    for (let i = 0; i < 25; i++) {
      const again = await raisePolicyCondition(db(), detail(), ORG_A);
      expect(again.created).toBe(false);
      expect(again.incident.id).toBe(first.incident.id);
    }
    expect(await listOpenPolicyConditions(db(), ORG_A)).toHaveLength(1);
  });

  it('dedupes per (org, policy, cluster) — a second cluster is its own condition', async () => {
    await raisePolicyCondition(db(), detail(), ORG_A);
    const other = await raisePolicyCondition(db(), detail({ clusterId: 'extraction' }), ORG_A);
    expect(other.created).toBe(true);
    expect(await listOpenPolicyConditions(db(), ORG_A)).toHaveLength(2);
  });

  it('is org-scoped: two tenants with the same policy id do not share a condition', async () => {
    await raisePolicyCondition(db(), detail(), ORG_A);
    const b = await raisePolicyCondition(db(), detail(), ORG_B);
    expect(b.created).toBe(true);
    expect(await listOpenPolicyConditions(db(), ORG_A)).toHaveLength(1);
    expect(await listOpenPolicyConditions(db(), ORG_B)).toHaveLength(1);
  });

  it('carries BOTH relaxation directions and the latency source on the row', async () => {
    const { incident } = await raisePolicyCondition(db(), detail(), ORG_A);
    const d = incident.detail as PolicyInfeasibleDetail;
    expect(d.relaxLatencyToMs).toBe(2100);
    expect(d.relaxQualityToFloor).toBe(0.72);
    // A provisional (harness) number must not read as a measured violation.
    expect(d.latencySource).toBe('serving');
    expect(d.boundMs).toBe(1500);
    expect(d.servedP95Ms).toBe(3400);
  });
});

describe('clearPolicyCondition — auto-resolution with evidence', () => {
  it('resolves the open condition and RECORDS what made the policy feasible', async () => {
    await raisePolicyCondition(db(), detail(), ORG_A);
    const cleared = await clearPolicyCondition(
      db(),
      { orgId: ORG_A, policyId: 'pol-a', clusterId: 'code-gen' },
      { reason: 'feasible', selectedStrategy: 'h-strong', servedP95Ms: 1200 },
    );
    expect(cleared).not.toBeNull();
    expect(cleared!.resolvedAt).not.toBeNull();
    const d = cleared!.detail as Record<string, unknown>;
    // The row survives as the durable record that the policy WAS infeasible —
    // the monthly report reads it. Resolution is evidence, not deletion.
    expect((d.resolution as Record<string, unknown>).selectedStrategy).toBe('h-strong');
    expect(d.boundMs).toBe(1500); // original detail preserved
    expect(await listOpenPolicyConditions(db(), ORG_A)).toHaveLength(0);
  });

  it('is a no-op returning null when nothing is open', async () => {
    expect(
      await clearPolicyCondition(
        db(),
        { orgId: ORG_A, policyId: 'pol-a', clusterId: 'code-gen' },
        { reason: 'feasible' },
      ),
    ).toBeNull();
  });

  it('a re-raise after a clear mints a NEW row (a second episode, not a revival)', async () => {
    const first = await raisePolicyCondition(db(), detail(), ORG_A);
    await clearPolicyCondition(
      db(),
      { orgId: ORG_A, policyId: 'pol-a', clusterId: 'code-gen' },
      { reason: 'feasible' },
    );
    const second = await raisePolicyCondition(db(), detail(), ORG_A);
    expect(second.created).toBe(true);
    expect(second.incident.id).not.toBe(first.incident.id);
  });

  it('cannot be cleared across orgs', async () => {
    await raisePolicyCondition(db(), detail(), ORG_A);
    expect(
      await clearPolicyCondition(
        db(),
        { orgId: ORG_B, policyId: 'pol-a', clusterId: 'code-gen' },
        { reason: 'feasible' },
      ),
    ).toBeNull();
    expect(await listOpenPolicyConditions(db(), ORG_A)).toHaveLength(1);
  });
});

describe('separation from the SERVE-leg advisory machinery', () => {
  it('a policy condition never enters the sweep’s verification work set', async () => {
    // listOpenAdvisories IS the G2.2 sweep's work set: each row gets a
    // suite-verify retry and a verifyAttempts increment. A policy condition
    // has no fromStrategy to verify, so including it would burn an attempt
    // every pass and eventually escalate a starved-verification incident for
    // something that was never verifiable.
    await raisePolicyCondition(db(), detail(), ORG_A);
    expect(await listOpenAdvisories(db(), ORG_A)).toEqual([]);
    expect(await listOpenAdvisories(db())).toEqual([]);
  });

  it('a serve-leg advisory still appears in the work set alongside it', async () => {
    await raisePolicyCondition(db(), detail(), ORG_A);
    await insertIncident(db(), {
      orgId: ORG_A,
      kind: 'advisory',
      detail: {
        leg: 'serve',
        policyId: 'pol-a',
        clusterId: 'code-gen',
        fromStrategy: 'h-cascade',
      },
    });
    const work = await listOpenAdvisories(db(), ORG_A);
    expect(work).toHaveLength(1);
    expect((work[0]!.detail as Record<string, unknown>).leg).toBe('serve');
  });

  it('a policy condition never satisfies the serve-leg advisory DEDUPE', async () => {
    // If it did, a standing latency condition would suppress a real quality
    // tripwire on the same policy+cluster — a silent loss of the guarantee.
    await raisePolicyCondition(db(), detail(), ORG_A);
    expect(
      await openAdvisoryForTuple(db(), {
        orgId: ORG_A,
        policyId: 'pol-a',
        clusterId: 'code-gen',
        fromStrategy: 'h-cascade',
      }),
    ).toBeNull();
  });

  it('a serve-leg advisory never satisfies the POLICY-condition dedupe', async () => {
    await insertIncident(db(), {
      orgId: ORG_A,
      kind: 'advisory',
      detail: { leg: 'serve', policyId: 'pol-a', clusterId: 'code-gen', fromStrategy: 'h-x' },
    });
    expect(
      await openPolicyCondition(db(), { orgId: ORG_A, policyId: 'pol-a', clusterId: 'code-gen' }),
    ).toBeNull();
    // …so the condition is still raisable.
    expect((await raisePolicyCondition(db(), detail(), ORG_A)).created).toBe(true);
  });

  it('pre-G2.6 advisories with NO leg field stay in the work set', async () => {
    // The IS DISTINCT FROM predicate must treat a missing leg as serve-leg,
    // not silently drop every advisory written before this migration.
    await insertIncident(db(), {
      orgId: ORG_A,
      kind: 'advisory',
      detail: { policyId: 'pol-legacy', clusterId: 'code-gen', fromStrategy: 'h-old' },
    });
    expect(await listOpenAdvisories(db(), ORG_A)).toHaveLength(1);
  });
});
