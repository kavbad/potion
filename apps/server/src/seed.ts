// Demo seed (SPEC §8 boot sequence): when the tables are EMPTY, create
//   · the demo TENANT (M2 Wave 1, ROADMAP #13): org 'org_demo' (created by
//     migration 0003), demo user 'usr_demo' with an ADMIN membership,
//   · one demo api key (`pk_demo_…`) bound to org_demo + a max_quality policy,
//   · three named policies — one of each type (bindable via POST
//     /v1/policies or POST /api/policies), all org_demo-scoped,
//   · current frontiers for code-gen + extraction, computed for real via the
//     harness (runEval on the mock provider) + pareto (computeFrontier /
//     saveFrontier), CAPPED at 4 candidate strategies under a $5 budget.
//     Frontiers are shared-global by design (ROADMAP #13) — NOT org-scoped.
// Zero network: everything runs against the mock provider.
import { randomUUID } from 'node:crypto';
import type { ClusterId, Policy, StrategyConfig } from '@potion/core';
import { sha256 } from '@potion/core';
import {
  DEFAULT_ORG_ID,
  createMembership,
  createOrg,
  createUser,
  insertApiKey,
  insertPolicy,
  listPolicies,
} from '@potion/db';
import { runEval } from '@potion/harness';
import { computeFrontier, saveFrontier } from '@potion/pareto';
import { DEFAULT_PRICES_PATH, type PotionContext } from './context.js';

/** Well-known demo key (documented; deterministic so the quickstart works on
 * any fresh boot). Only its sha256 is stored.
 *
 * G2.4: minting it is GATED behind POTION_SEED_DEMO — a deterministic,
 * published credential that seeded on every empty boot was a standing
 * production credential under the operator-only posture (the same
 * router-era species as the self-serve hole G2.7 closed). */
export const DEMO_API_KEY = 'pk_demo_3f1a9c27b4e84d56a0c2e7f1953bd681';

/**
 * Demo-credential gate (G2.4), matching the POTION_SELF_SERVE polarity: OFF
 * unless explicitly set. Dev, tests and the walkthrough set it deliberately;
 * there are no implicit exceptions (no NODE_ENV sniffing). The org_demo ROW
 * still seeds keylessly — it is the unauthenticated-request-log fallback and
 * is undeletable by design — but it carries no usable credential.
 */
export function demoSeedEnabled(): boolean {
  return process.env.POTION_SEED_DEMO === '1' || process.env.POTION_SEED_DEMO === 'true';
}

/** Demo tenant (M2 #13): the default org is created by migration 0003 (it is
 * the backfill target); the seed adds the demo user + admin membership. */
export const DEMO_ORG_ID = DEFAULT_ORG_ID; // 'org_demo'
export const DEMO_USER_ID = 'usr_demo';
export const DEMO_USER_EMAIL = 'demo@potion.dev';

export const DEMO_POLICY_ID = 'pol-demo-max-quality';

/** The three seeded policies — one of each Policy type (SPEC §1). */
export const DEMO_POLICIES: Array<{ id: string; name: string; config: Policy }> = [
  {
    id: DEMO_POLICY_ID,
    name: 'demo-max-quality',
    config: { type: 'max_quality', costCeilingPer1K: 1.0 },
  },
  {
    id: 'pol-demo-min-cost',
    name: 'demo-min-cost',
    config: { type: 'min_cost', qualityFloor: 0.8 },
  },
  {
    id: 'pol-demo-latency-bound',
    name: 'demo-latency-bound',
    config: { type: 'latency_bound', p95Ms: 1000 },
  },
];

/** Clusters whose frontiers are computed at seed time (SPEC §8). */
export const SEED_CLUSTERS: ClusterId[] = ['code-gen', 'extraction'];

/** Capped candidate set: three singles across the price/latency tiers plus
 * one cascade (cheap → frontier). Enough to draw a real 3-point frontier per
 * cluster while keeping the seed eval small ($0.23 observed spend). */
export const SEED_STRATEGIES: StrategyConfig[] = [
  { type: 'single', model: 'gpt-mini-class' },
  { type: 'single', model: 'sonnet-class' },
  { type: 'single', model: 'frontier-class' },
  {
    type: 'cascade',
    stages: [
      { model: 'gpt-mini-class', escalateIf: { confidenceBelow: 0.7 } },
      { model: 'frontier-class' },
    ],
    confidenceMethod: 'self-report-calibrated',
  },
];

/**
 * Preflight cap for the demo-seed eval. The seed runs on the MOCK provider
 * (zero real spend) but with PRICED aliases so demo frontiers show non-zero
 * costs — the cap only exercises the preflight gate. Re-sized $5 → $15 when
 * the estimator became an honest worst-case bound (M1b fix: answer output at
 * the enforced max_tokens ceiling instead of an 80-token guess; the seed's
 * projection is ~$10.49).
 */
export const SEED_BUDGET_CAP_USD = 15;

/**
 * Seed the demo dataset when (and only when) it has not been seeded yet.
 * Returns true when seeding happened. Idempotent across boots.
 *
 * G2.4: the "already seeded" marker is the demo POLICIES, not the demo api
 * key — the key is now gated behind POTION_SEED_DEMO, so keying idempotency
 * off it would re-run the whole seed on every boot in the default
 * (credential-free) posture.
 */
export async function seedIfEmpty(
  ctx: PotionContext,
  opts: { log?: (msg: string) => void } = {},
): Promise<boolean> {
  const log = opts.log ?? (() => {});
  const existingPolicies = await listPolicies(ctx.db.db, DEMO_ORG_ID);
  if (existingPolicies.length > 0) return false;

  // ---- demo tenant: org (idempotent — migration 0003 already created it),
  // demo user + admin membership ----
  await createOrg(ctx.db.db, { id: DEMO_ORG_ID, name: 'Demo Org' });
  await createUser(ctx.db.db, { id: DEMO_USER_ID, email: DEMO_USER_EMAIL, name: 'Demo User' });
  await createMembership(ctx.db.db, { orgId: DEMO_ORG_ID, userId: DEMO_USER_ID, role: 'admin' });
  log(`seeded demo tenant (${DEMO_ORG_ID} + ${DEMO_USER_ID} as admin)`);

  // ---- policies + demo key (all org_demo-scoped) ----
  for (const p of DEMO_POLICIES) {
    await insertPolicy(ctx.db.db, { id: p.id, orgId: DEMO_ORG_ID, name: p.name, config: p.config });
  }
  if (demoSeedEnabled()) {
    await insertApiKey(ctx.db.db, {
      id: `key-${randomUUID().slice(0, 8)}`,
      keyHash: sha256(DEMO_API_KEY),
      name: 'demo',
      orgId: DEMO_ORG_ID,
      policyId: DEMO_POLICY_ID,
    });
    log(`seeded demo api key (${DEMO_API_KEY.slice(0, 12)}…) + ${DEMO_POLICIES.length} policies`);
  } else {
    log(
      `seeded ${DEMO_POLICIES.length} demo policies; demo API KEY withheld ` +
        '(set POTION_SEED_DEMO=1 for the quickstart credential — G2.4)',
    );
  }

  // ---- frontiers via harness + pareto on the mock provider (capped) ----
  // M1a quarantine: code-gen/extraction now resolve under suites/simulated/
  // (mock-corpus-derived). The demo seed is itself a simulation — opt in
  // explicitly; seeded demo frontiers are never real-world quality evidence.
  const summary = await runEval(
    {
      suiteIds: SEED_CLUSTERS,
      strategies: SEED_STRATEGIES,
      budgetCapUsd: SEED_BUDGET_CAP_USD,
      provider: 'mock',
      resume: true,
      simulatedOk: true,
    },
    { db: ctx.db, pricesPath: DEFAULT_PRICES_PATH },
  );
  for (const clusterId of SEED_CLUSTERS) {
    const aggs = summary.aggregates.filter((a) => a.clusterId === clusterId);
    const points = computeFrontier(aggs);
    const saved = await saveFrontier(ctx.db.db, clusterId, points, 'manual', ctx.prices.version);
    log(`seeded ${clusterId} frontier v${saved.version} (${points.length} points)`);
  }
  return true;
}
