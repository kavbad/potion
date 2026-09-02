// R1/R2 (Router direction, 2026-08-27) — the router compiler, extracted so
// EVERY surface that names a router version runs the same assembly:
// GET /api/router (the artifact page) and GET /api/routing-activity (the
// receipts, which attribute each request to the version whose assignment it
// actually rode). One compiler, one truth.
//
// The document is assembled by the SERVE PATH'S OWN functions —
// loadCurrentFrontier (org-preferred) → guardFrontierProvenance →
// bindServingLatency → resolveOperatingPoint under policyForCluster — so
// the artifact a customer reads is the router their requests actually get.
//
// Versions are lazily minted: the identity hash covers the DECISION inputs
// (policy config + per-cluster frontier id/version + chosen strategy +
// fallback posture) and excludes volatile display fields (bound latency),
// so a version means "the routing changed", never "a latency sample
// wiggled". Changes are narrated in plain language — including, when the
// org has traffic, the R2 line: the estimated monthly impact at the org's
// own recent mix.
import {
  sha256,
  canonicalJson,
  strategyHash,
  PolicySchema,
  type Policy,
  type StrategyConfig,
} from '@potion/core';
import {
  appendRouterVersion,
  getOrgById,
  getRouterInterpretation,
  listAdoptedWorkloads,
  listClusters,
  listServingPolicies,
  listRequestLogs,
  listRouterVersions,
  type PotionDb,
  measuredSinglePoint,
  getOrgIncumbents,
} from '@potion/db';
import { loadTaxonomy } from '@potion/cluster';
import {
  clusterOutcomeEvidence,
  clusterShadowEvidence,
  loadCurrentFrontier,
  orgOutcomeRows,
  orgShadowEvidenceInputs,
  policyForCluster,
  servingDecisionFor,
  type ClusterOutcomeEvidence,
  type ClusterShadowEvidence,
} from '@potion/pareto';
import { parseTraceHeader } from '../routes/chat.js';
import { describePolicy } from '../routes/connection.js';
import { type PotionContext } from '../context.js';
import { routerModelName } from './router-slug.js';
import { bustRouterStampCache } from './router-stamp.js';

export interface RouterAssignment {
  clusterId: string;
  /** G2 rung 3: present when this assignment is an ADOPTED WORKLOAD — the
   * taxonomy cluster it sub-assigns within. Display + narration only. */
  parentCluster?: string;
  frontierId: string;
  frontierVersion: number;
  provenance: 'live' | 'mock' | 'blocked';
  strategyHash: string;
  strategy: { type: string; label: string };
  quality: number | null;
  costPer1K: number | null;
  latencyP95: number | null;
  evidenceN: number | null;
  alternatives: number;
  fallback: string | null;
  /** SHADOW → ORG EVIDENCE (2026-09-01): what the shadow plane has MEASURED
   * on this org's own traffic — serve-judge scores (its own instrument,
   * never mixed with the suite-measured quality above) and measured costs
   * on both sides of the compare. Display evidence, absent when the window
   * holds nothing; EXCLUDED from routerHash by construction (the hash reads
   * enumerated decision fields), so evidence drift never mints a version. */
  shadow?: ClusterShadowEvidence;
  /** G1 Outcome API: the customer's OWN application's verdicts on this
   * assignment's served answers — ground truth, on its own instrument,
   * never blended with the serve-judge or suite numbers. Same display-only
   * rules as `shadow`: absent when the window holds nothing, excluded from
   * routerHash by construction. */
  outcomes?: ClusterOutcomeEvidence;
}

export interface ExpectedProjection {
  quality: number;
  costPer1K: number;
  baselineCostPer1K: number;
  baselineQuality: number;
  savingsPct: number;
  incumbent: { model: string; quality: number; costPer1K: number; coverage: number } | null;
}

export interface RouterDocument {
  name: string;
  policy: { config: Policy; description: string } | null;
  assignments: RouterAssignment[];
  pricesVersion: string;
  changes: string[];
  /** O1: what the org said it is building, interpreted into a mix. */
  interpreted?: { summary: string; mix: Array<{ clusterId: string; share: number }> };
  /** O1: mix-weighted projections FROM PLATFORM EVIDENCE — labeled expected,
   * corrected by real traffic; baseline = best scorer per kind of work,
   * incumbent = the org's NAMED model, measured (2026-08-28). */
  expected?: ExpectedProjection | null;
}

export interface CompiledRouter {
  name: string;
  version: number;
  routerHash: string;
  mintedAt: Date;
  document: RouterDocument;
  history: Array<{ version: number; createdAt: Date; changes: string[]; document: unknown }>;
}

export async function compileAndMintRouter(
  ctx: PotionContext,
  db: PotionDb,
  orgId: string,
  warn: (msg: string) => void,
): Promise<CompiledRouter> {
  const orgRow = await getOrgById(db, orgId);
  const name = routerModelName(orgRow?.name ?? 'org');

  // The org's bound policy — connection.ts's exact resolution.
  let policy: Policy | null = null;
  // Serving policies only (2026-08-28): the operator's own router page read
  // the Lab's internal lab-io row — floor 0.00 — as the org's rule.
  const firstPolicy = (await listServingPolicies(db, orgId))[0];
  if (firstPolicy) {
    const parsed = PolicySchema.safeParse(firstPolicy.config);
    if (parsed.success) policy = parsed.data;
  }

  const assignments: RouterAssignment[] =
    policy === null ? [] : await assignmentsUnderPolicy(ctx, db, orgId, policy, warn);
  // SHADOW → ORG EVIDENCE (2026-09-01): decorate each assignment with the
  // org's own measured challenger field. Three windowed reads per compile;
  // `qualifies` is confidence-gated (Jeffreys lower bound vs the cluster's
  // floor) and read-only — Potion proposes, the user reacts.
  if (assignments.length > 0 && policy !== null) {
    const [shadowInputs, outcomeRows] = await Promise.all([
      orgShadowEvidenceInputs(db, orgId),
      orgOutcomeRows(db, orgId),
    ]);
    for (const a of assignments) {
      const clusterPolicy = policyForCluster(policy, a.clusterId);
      const clusterFloor =
        clusterPolicy.type === 'min_cost' || clusterPolicy.type === 'compound'
          ? clusterPolicy.qualityFloor
          : null;
      const ev = clusterShadowEvidence(shadowInputs, {
        clusterId: a.clusterId,
        servingHash: a.strategyHash,
        clusterFloor,
      });
      if (ev !== null) a.shadow = ev;
      const oc = clusterOutcomeEvidence(outcomeRows, {
        clusterId: a.clusterId,
        servingHash: a.strategyHash,
      });
      if (oc !== null) a.outcomes = oc;
    }
  }
  const interpretation = await getRouterInterpretation(db, orgId);

  const routerHash = sha256(
    canonicalJson({
      name,
      policy: policy ?? null,
      interpreted: interpretation === null ? null : { summary: interpretation.summary, mix: interpretation.mix },
      assignments: assignments.map((a) => ({
        clusterId: a.clusterId,
        frontierId: a.frontierId,
        frontierVersion: a.frontierVersion,
        strategyHash: a.strategyHash,
        fallback: a.fallback,
      })),
    }),
  );

  const history = await listRouterVersions(db, orgId, 12);
  const latest = history[0] ?? null;
  let changes: string[] = [];
  if (latest === null) {
    changes = ['first compilation'];
  } else if (latest.routerHash === routerHash) {
    // Unchanged router: the CURRENT version's stored change list is the
    // truth — recomputing against itself would erase "what changed".
    changes = (latest.document as { changes?: string[] }).changes ?? [];
  } else if (latest.routerHash !== routerHash) {
    const prev = latest.document as { policy?: { description?: string } | null; assignments?: RouterAssignment[] };
    const prevAssignments = prev.assignments ?? [];
    const prevBy = new Map(prevAssignments.map((a) => [a.clusterId, a]));
    const nowBy = new Map(assignments.map((a) => [a.clusterId, a]));
    const prevDesc = prev.policy?.description ?? null;
    const nowDesc = policy ? describePolicy(policy) : null;
    if (prevDesc !== nowDesc) changes.push(`your rule changed: ${prevDesc ?? 'none'} → ${nowDesc ?? 'none'}`);
    const prevSummary = (latest.document as { interpreted?: { summary?: string } }).interpreted?.summary ?? null;
    if (interpretation !== null && interpretation.summary !== prevSummary) {
      changes.push(`built for: ${interpretation.summary}`);
    }
    // Per-request cost deltas for the R2 mix-weighted estimate below.
    const deltas: Array<{ clusterId: string; perRequestUsd: number }> = [];
    for (const a of assignments) {
      const p = prevBy.get(a.clusterId);
      if (!p) { changes.push(`${a.clusterId}: newly routed → ${a.strategy.label}`); continue; }
      if (p.strategyHash !== a.strategyHash) {
        const money = (v: number | null) => (v === null ? '—' : `$${v.toFixed(4)}`);
        changes.push(
          `${a.clusterId}: ${p.strategy.label} → ${a.strategy.label}` +
          ` (quality ${p.quality?.toFixed(3) ?? '—'} → ${a.quality?.toFixed(3) ?? '—'},` +
          ` ${money(p.costPer1K)} → ${money(a.costPer1K)} per 1K requests)`,
        );
        if (p.costPer1K !== null && a.costPer1K !== null) {
          deltas.push({ clusterId: a.clusterId, perRequestUsd: (a.costPer1K - p.costPer1K) / 1000 });
        }
      } else if (p.frontierVersion !== a.frontierVersion) {
        changes.push(`${a.clusterId}: re-measured (frontier v${p.frontierVersion} → v${a.frontierVersion}), assignment held`);
      }
    }
    for (const p of prevAssignments) {
      if (!nowBy.has(p.clusterId)) changes.push(`${p.clusterId}: no longer routed`);
    }
    // R2: the impact line, at the org's OWN recent mix — an estimate,
    // labeled as one, computed from the org's real request rate per
    // cluster over its recent window. Only rendered when there is enough
    // traffic to mean anything.
    if (deltas.length > 0) {
      const rows = await listRequestLogs(db, orgId, 500);
      if (rows.length >= 20) {
        const oldest = rows[rows.length - 1]!.ts;
        const spanDays = Math.max(1, (Date.now() - new Date(oldest).getTime()) / 86_400_000);
        const perCluster = new Map<string, number>();
        for (const r of rows) {
          const cid = parseTraceHeader(r.trace).clusterId;
          if (cid) perCluster.set(cid, (perCluster.get(cid) ?? 0) + 1);
        }
        let monthlyUsd = 0;
        for (const d of deltas) {
          const n = perCluster.get(d.clusterId) ?? 0;
          monthlyUsd += (n / spanDays) * 30 * d.perRequestUsd;
        }
        if (Math.abs(monthlyUsd) >= 0.01) {
          changes.push(
            monthlyUsd < 0
              ? `estimated at your recent traffic mix: saves ~$${Math.abs(monthlyUsd).toFixed(2)}/month`
              : `estimated at your recent traffic mix: ~$${monthlyUsd.toFixed(2)}/month more, bought as measured quality`,
          );
        }
      }
    }
    if (changes.length === 0) changes = ['routing inputs changed'];
  }

  const document: RouterDocument = {
    name,
    policy: policy ? { config: policy, description: describePolicy(policy) } : null,
    assignments,
    pricesVersion: ctx.prices.version,
    changes,
    ...(interpretation === null
      ? {}
      : {
          interpreted: { summary: interpretation.summary, mix: interpretation.mix },
          expected: await expectedForMix(db, orgId, assignments, interpretation.mix, (await getOrgIncumbents(db, orgId))?.models[0]),
        }),
  };
  const minted = await appendRouterVersion(db, { orgId, routerHash, document });
  const mintedNew = minted.routerHash === routerHash && latest?.routerHash !== routerHash;
  // G0 (0082): a new mint must reach serve-time stamping immediately.
  if (mintedNew) bustRouterStampCache(orgId);
  const fullHistory = mintedNew
    ? [{ version: minted.version, createdAt: minted.createdAt, changes, document }, ...history.map((h) => ({
        version: h.version, createdAt: h.createdAt,
        changes: (h.document as { changes?: string[] }).changes ?? [],
        document: h.document,
      }))]
    : history.map((h) => ({
        version: h.version, createdAt: h.createdAt,
        changes: (h.document as { changes?: string[] }).changes ?? [],
        document: h.document,
      }));

  return {
    name,
    version: minted.version,
    routerHash: minted.routerHash,
    mintedAt: minted.createdAt,
    document: minted.routerHash === routerHash ? document : (minted.document as RouterDocument),
    history: fullHistory.slice(0, 12),
  };
}


/** The per-cluster assignment loop, shared by the compiler and the O1
 * onboarding reveal — delegated to @potion/pareto's servingDecisionFor,
 * THE serve chain (2026-08-31, one-resolver P0): the same function the
 * learning period measures against, so the artifact, the reveal, and the
 * learning comparison can never disagree about what production serves. */
export async function assignmentsUnderPolicy(
  ctx: PotionContext,
  db: PotionDb,
  orgId: string,
  policy: Policy,
  warn: (msg: string) => void,
): Promise<RouterAssignment[]> {
  const assignments: RouterAssignment[] = [];
  const clusterIds: string[] = [];
  const seen = new Set<string>();
  for (const c of loadTaxonomy().clusters) {
    if (!seen.has(c.id)) { seen.add(c.id); clusterIds.push(c.id); }
  }
  for (const c of await listClusters(db, { orgId })) {
    if (!seen.has(c.id)) { seen.add(c.id); clusterIds.push(c.id); }
  }
  // G2 rung 3: ADOPTED workloads are routing surface — their assignments
  // belong in the artifact (adopt/retire narrates as newly/no-longer
  // routed on the next compile), and they are what serve-time stamping
  // matches a sub-assigned request against.
  const parentOf = new Map<string, string>();
  for (const w of await listAdoptedWorkloads(db, orgId)) {
    if (!seen.has(w.id)) { seen.add(w.id); clusterIds.push(w.id); parentOf.set(w.id, w.parentCluster); }
  }
  for (const cid of clusterIds.sort()) {
    const d = await servingDecisionFor(db, {
      orgId,
      clusterId: cid,
      policy,
      providerMode: ctx.providerMode,
      prices: ctx.prices,
      warn,
    });
    if (!d.loaded || d.loaded.points.length === 0) continue;
    const op = d.op;
    if (op.config === null) continue;
    const hash = strategyHash(op.config as StrategyConfig);
    const served = (d.binding.frontier?.points ?? []).find((p) => p.strategyHash === hash) ?? null;
    const cfg = op.config as StrategyConfig & { model?: string };
    assignments.push({
      clusterId: cid,
      ...(parentOf.has(cid) ? { parentCluster: parentOf.get(cid)! } : {}),
      frontierId: d.loaded.id,
      frontierVersion: d.loaded.version,
      provenance: d.provenance,
      strategyHash: hash,
      strategy: { type: cfg.type, label: cfg.type === 'single' && cfg.model !== undefined ? cfg.model : cfg.type },
      quality: served?.quality ?? null,
      costPer1K: served?.costPer1K ?? null,
      latencyP95: served?.latencyP95 ?? null,
      evidenceN: served?.evidence?.n ?? null,
      alternatives: d.loaded.points.length,
      fallback: op.fallbackReason ?? null,
    });
  }
  return assignments;
}

/** O1: mix-weighted projections. Baseline = the BEST SCORER per kind of
 * work (the house comparison: "always the top-quality point") — an honest
 * premium counterfactual, never a strawman. Returns null when the mix has
 * no priced coverage. */
export async function expectedForMix(
  db: PotionDb,
  orgId: string,
  assignments: RouterAssignment[],
  mix: Array<{ clusterId: string; share: number }>,
  /** The org's NAMED incumbent model, when it named one at onboarding —
   * the personal counterfactual (2026-08-28, operator: the comparison
   * should be what they'd actually run, not the premium ceiling). */
  incumbentModel?: string,
): Promise<ExpectedProjection | null> {
  let q = 0, cost = 0, base = 0, baseQ = 0, covered = 0;
  let incQ = 0, incCost = 0, incCovered = 0;
  const incHash = incumbentModel !== undefined ? strategyHash({ type: 'single', model: incumbentModel }) : null;
  for (const m of mix) {
    const a = assignments.find((x) => x.clusterId === m.clusterId);
    if (!a || a.quality === null || a.costPer1K === null) continue;
    const loaded = await loadCurrentFrontier(db, m.clusterId, orgId);
    const best = loaded?.points.reduce<{ q: number; c: number } | null>(
      (acc, p) => (acc === null || p.quality > acc.q ? { q: p.quality, c: p.costPer1K } : acc),
      null,
    ) ?? null;
    if (best === null) continue;
    covered += m.share;
    q += m.share * a.quality;
    cost += m.share * a.costPer1K;
    base += m.share * best.c;
    baseQ += m.share * best.q;
    if (incHash !== null) {
      const inc = await measuredSinglePoint(db, m.clusterId, incHash);
      if (inc !== null) {
        incCovered += m.share;
        incQ += m.share * inc.quality;
        incCost += m.share * inc.costPer1K;
      }
    }
  }
  if (covered <= 0 || base <= 0) return null;
  return {
    quality: q / covered,
    costPer1K: cost / covered,
    baselineCostPer1K: base / covered,
    // The baseline's own quality (2026-08-28, operator: "how the hell are
    // we saving 99.7%"): a cost comparison against the premium
    // counterfactual is only honest with BOTH qualities on the table — the
    // trade must be visible, never implied away.
    baselineQuality: baseQ / covered,
    savingsPct: Math.max(0, 1 - cost / base),
    incumbent:
      incumbentModel !== undefined && incCovered > 0 && incCost > 0
        ? {
            model: incumbentModel,
            quality: incQ / incCovered,
            costPer1K: incCost / incCovered,
            coverage: incCovered / covered,
          }
        : null,
  };
}

/** R2 — receipts attribution: the version whose recorded assignment this
 * request actually rode, by CONTENT (cluster + strategy prefix + frontier
 * version), never by timestamp guesswork. Newest match wins; no match is an
 * honest null (routing the ledger never minted). */
export function routerVersionForRequest(
  history: Array<{ version: number; document: unknown }>,
  row: { clusterId: string | null; strategy8: string | null; frontierVersion: number | null },
): number | null {
  if (row.clusterId === null || row.strategy8 === null) return null;
  for (const v of history) {
    const doc = v.document as { assignments?: RouterAssignment[] };
    const hit = (doc.assignments ?? []).find(
      (a) =>
        a.clusterId === row.clusterId &&
        a.strategyHash.startsWith(row.strategy8!) &&
        (row.frontierVersion === null || a.frontierVersion === row.frontierVersion),
    );
    if (hit) return v.version;
  }
  return null;
}
