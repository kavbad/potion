// The learning period's surface (operator, 2026-08-22).
//
//   GET  /api/incumbents/options        the roster a customer can name
//   GET  /api/incumbents                what this org uses today + consent
//   PUT  /api/incumbents                set it (admin)
//   GET  /api/learning                  state: consent, samples per kind of work, proposals
//   POST /api/learning/proposals/:id/apply   (admin) set the bar: a new
//        min_cost policy at the proposed floor, bound to every live key
//
// Nothing here spends money. Sampling happens on the serving path under
// consent; measuring happens in the learning:period job under a cap.
import { loadCurrentFrontier } from '@potion/pareto';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  getLearningProposal,
  getOrgIncumbents,
  insertPolicy,
  latestProposalsByCluster,
  listApiKeys,
  markProposalApplied,
  updateApiKeyPolicy,
  upsertOrgIncumbents,
  getFirstApiKeyWithPolicy,
  getPolicyById,
  listLearningProposals,
  getOrgById,
  setOrgRouteAllModels,
} from '@potion/db';
import { openAiError, requireRole } from '../auth.js';
import type { Policy } from '@potion/core';
import { floorFor, mintFloor, withClusterFloor } from '../routing/floors.js';
import { floorFeasibility, infeasibleOnly } from '../routing/feasibility.js';
import type { PotionContext } from '../context.js';
import type { PotionQueue } from '@potion/queue';
import { incumbentRoster, resolveTypedModel } from '../incumbents/roster.js';
import { OBSERVED_WINDOW_DAYS, observedIncumbentsFor } from '../incumbents/observed.js';
import { learningSampleCounts } from '../learning/sampling.js';

const IncumbentsBody = z
  .object({
    models: z.array(z.string().min(1).max(120)).max(8),
    other: z.string().max(200).nullable().optional(),
    samplingConsent: z.boolean().optional(),
  })
  .strict();

export function registerLearningRoutes(app: FastifyInstance, ctx: PotionContext, opts: { queue?: PotionQueue } = {}): void {
  const db = ctx.db.db;

  app.get('/api/incumbents/options', async (req, reply) => {
    if (!req.potionOrg) return reply.code(401).send(openAiError('authentication required', 'invalid_request_error', 'authentication_required'));
    return reply.send({ roster: incumbentRoster(ctx.prices) });
  });

  // ---- model-field semantics (migration 0058, external review 2026-08-25) --
  // GET reflects the org's current mode; PUT flips it (admin). Label-blind
  // routing (route_all_models=true) is the migration escape hatch for apps
  // that cannot change their model strings yet — an explicit, visible choice.
  app.get('/api/org-settings', async (req, reply) => {
    const org = req.potionOrg!;
    const row = await getOrgById(db, org.orgId);
    return reply.send({ routeAllModels: row?.routeAllModels === true });
  });
  app.put('/api/org-settings', { preHandler: [requireRole('admin')] }, async (req, reply) => {
    const org = req.potionOrg!;
    const parsed = z.object({ routeAllModels: z.boolean() }).safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send(openAiError('routeAllModels must be a boolean', 'invalid_request_error'));
    }
    await setOrgRouteAllModels(db, org.orgId, parsed.data.routeAllModels);
    return reply.send({ routeAllModels: parsed.data.routeAllModels });
  });

  // WHAT YOUR TRAFFIC SAYS YOU USE (2026-09-16): per kind of work, the model
  // labels this org's requests named in the last 30 days, ranked by volume,
  // resolved to the roster where possible. The picker shows it and offers
  // it as the answer; the receipts already use it as the comparator when
  // nothing was named.
  app.get('/api/incumbents/observed', async (req, reply) => {
    const org = req.potionOrg;
    if (!org) return reply.code(401).send(openAiError('authentication required', 'invalid_request_error', 'authentication_required'));
    const clusters = await observedIncumbentsFor(db, ctx.prices, org.orgId);
    return reply.send({ windowDays: OBSERVED_WINDOW_DAYS, clusters });
  });

  app.get('/api/incumbents', async (req, reply) => {
    const org = req.potionOrg;
    if (!org) return reply.code(401).send(openAiError('authentication required', 'invalid_request_error', 'authentication_required'));
    const row = await getOrgIncumbents(db, org.orgId);
    return reply.send(row ? dto(row) : { models: [], other: null, samplingConsent: false, sampleCapPerCluster: 40, designatedAt: null });
  });

  app.put('/api/incumbents', { preHandler: [requireRole('admin')] }, async (req, reply) => {
    const org = req.potionOrg!;
    const parsed = IncumbentsBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send(openAiError(parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; '), 'invalid_request_error'));
    const roster = incumbentRoster(ctx.prices);
    const known = new Set(roster.flatMap((r) => [r.alias, ...r.alternates]));
    const unknown = parsed.data.models.filter((m) => !known.has(m));
    if (unknown.length > 0) return reply.code(400).send(openAiError(`unknown model(s): ${unknown.join(', ')} — use 'other' for a model not on the roster`, 'invalid_request_error'));
    // A typed model that IS on the measured roster becomes a real incumbent —
    // the learning period can only measure what it can price (roster.ts
    // resolveTypedModel). One that is not stays recorded as 'other' and the
    // picker says so, rather than silently never measuring it.
    const typed = parsed.data.other?.trim() || null;
    const resolved = typed ? resolveTypedModel(typed, roster) : null;
    const models = resolved && !parsed.data.models.includes(resolved.alias) ? [...parsed.data.models, resolved.alias] : parsed.data.models;
    const prev = await getOrgIncumbents(db, org.orgId);
    const row = await upsertOrgIncumbents(db, {
      orgId: org.orgId,
      models,
      other: resolved ? null : typed,
      samplingConsent: parsed.data.samplingConsent ?? prev?.samplingConsent ?? false,
    });
    return reply.send({ ...dto(row), ...(resolved ? { resolvedOther: { typed, alias: resolved.alias, name: `${resolved.vendor} ${resolved.name}` } } : {}) });
  });

  app.get('/api/learning', async (req, reply) => {
    const org = req.potionOrg;
    if (!org) return reply.code(401).send(openAiError('authentication required', 'invalid_request_error', 'authentication_required'));
    const inc = await getOrgIncumbents(db, org.orgId);
    const samples = await learningSampleCounts(db, org.orgId);
    const proposals = [...(await latestProposalsByCluster(db, org.orgId)).values()].map(proposalDto);
    return reply.send({
      incumbents: inc ? dto(inc) : null,
      samplingConsent: inc?.samplingConsent ?? false,
      sampleCapPerCluster: inc?.sampleCapPerCluster ?? 40,
      samples,
      proposals,
    });
  });

  /** Measure now (admin): enqueue this org's learning period. */
  app.post('/api/learning/run', { preHandler: [requireRole('admin')] }, async (req, reply) => {
    const org = req.potionOrg!;
    if (!opts.queue) return reply.code(503).send(openAiError('no job queue on this server', 'server_error'));
    const jobId = await opts.queue.enqueue('learning:period', { orgId: org.orgId });
    return reply.code(202).send({ jobId });
  });

  app.post('/api/learning/proposals/:id/apply', { preHandler: [requireRole('admin')] }, async (req, reply) => {
    const org = req.potionOrg!;
    const { id } = req.params as { id: string };
    const p = await getLearningProposal(db, org.orgId, id);
    if (!p) return reply.code(404).send(openAiError(`unknown proposal '${id}'`, 'invalid_request_error', 'not_found'));
    if (p.status !== 'proposed') return reply.code(409).send(openAiError(`proposal is ${p.status}`, 'invalid_request_error', 'proposal_not_open'));
    const stale = await proposalStaleness(org.orgId, p);
    if (stale !== null) return reply.code(409).send(openAiError(`proposal is stale: ${stale} — measure again before applying`, 'invalid_request_error', 'proposal_stale'));
    const { policyId, policy, keysRebound } = await applyFloors(org.orgId, [p]);
    await markProposalApplied(db, org.orgId, id, policyId);
    return reply.send({ applied: true, policyId, qualityFloor: floorFor(policy, p.clusterId), clusterFloors: clusterFloorsOf(policy), keysRebound });
  });

  // Every open proposal at once: one new policy carrying a floor per kind of
  // work, every active key rebound to it.
  app.post('/api/learning/proposals/apply-all', { preHandler: [requireRole('admin')] }, async (req, reply) => {
    const org = req.potionOrg!;
    const candidates = (await listLearningProposals(db, org.orgId)).filter((p) => p.status === 'proposed');
    if (candidates.length === 0) return reply.code(409).send(openAiError('no open proposals', 'invalid_request_error', 'proposal_not_open'));
    const open: typeof candidates = [];
    const stale: Array<{ id: string; clusterId: string; why: string }> = [];
    for (const p of candidates) {
      const why = await proposalStaleness(org.orgId, p);
      if (why === null) open.push(p);
      else stale.push({ id: p.id, clusterId: p.clusterId, why });
    }
    if (open.length === 0) return reply.code(409).send(openAiError(`every open proposal is stale — measure again before applying (${stale.map((s) => `${s.clusterId}: ${s.why}`).join('; ')})`, 'invalid_request_error', 'proposal_stale'));
    const { policyId, policy, keysRebound } = await applyFloors(org.orgId, open);
    for (const p of open) await markProposalApplied(db, org.orgId, p.id, policyId);
    return reply.send({ applied: open.length, policyId, clusterFloors: clusterFloorsOf(policy), keysRebound, stale });
  });

  // The org-wide quality floor, settable from /settings/controls (P1-7).
  // Same shape as apply: a NEW policy row (policies are immutable history)
  // carrying the changed floor, every active key rebound. Per-kind floors
  // survive a default-floor change; a latency bound survives as compound;
  // max_quality has no floor, so setting one deliberately replaces it.
  // No invented lower bound: core PolicySchema allows 0-1, and an operator
  // explicitly setting a low bar is setting THEIR bar (same closure).
  const FloorBody = z.object({ qualityFloor: z.number().min(0).max(1) }).strict();
  // FEASIBILITY BEFORE COMMITMENT (2026-09-16): what this floor would mean
  // per kind of work, computed exactly as PUT /api/floor would bind it —
  // per-kind floors carried, latency bound kept — so the card can warn
  // before the click. Viewer-readable: it changes nothing.
  app.get('/api/floor/feasibility', async (req, reply) => {
    const org = req.potionOrg;
    if (!org) return reply.code(401).send(openAiError('authentication required', 'invalid_request_error', 'authentication_required'));
    const raw = Number((req.query as { floor?: string }).floor);
    const parsed = FloorBody.safeParse({ qualityFloor: raw });
    if (!parsed.success) return reply.code(400).send(openAiError('floor must be a number in [0, 1]', 'invalid_request_error'));
    const next = await floorPolicyFor(org.orgId, mintFloor(parsed.data.qualityFloor));
    const clusters = await floorFeasibility(db, org.orgId, next);
    return reply.send({ floor: mintFloor(parsed.data.qualityFloor), clusters, infeasible: infeasibleOnly(clusters) });
  });

  app.put('/api/floor', { preHandler: [requireRole('admin')] }, async (req, reply) => {
    const org = req.potionOrg!;
    const parsed = FloorBody.safeParse(req.body);
    if (!parsed.success) {
      const message = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
      return reply.code(400).send(openAiError(message, 'invalid_request_error'));
    }
    // One minting rule with apply and the plan binding (routing/floors.ts):
    // FLOOR to 2dp, never round up past what was asked for.
    const f = mintFloor(parsed.data.qualityFloor);
    const next = await floorPolicyFor(org.orgId, f);
    const current = await currentBoundPolicy(org.orgId);
    // The warning rides the response too (2026-09-16): the card asked
    // before saving, but an API caller did not — so the save names every
    // kind of work where this floor admits no measured point.
    const infeasible = infeasibleOnly(await floorFeasibility(db, org.orgId, next));
    const policyId = `pol-${randomUUID().slice(0, 8)}`;
    await insertPolicy(db, { id: policyId, orgId: org.orgId, name: `floor ${f.toFixed(2)}`, config: next });
    const keys = (await listApiKeys(db, org.orgId)).filter((k) => !k.revokedAt);
    for (const k of keys) await updateApiKeyPolicy(db, org.orgId, k.id, policyId);
    return reply.send({
      policyId,
      qualityFloor: f,
      clusterFloors: clusterFloorsOf(next),
      keysRebound: keys.length,
      previousType: current?.type ?? null,
      infeasible,
    });
  });

  /** The org's bound policy config, resolved as PUT /api/floor always has. */
  async function currentBoundPolicy(orgId: string): Promise<Policy | null> {
    const first = await getFirstApiKeyWithPolicy(db, orgId);
    return first?.policyId ? ((await getPolicyById(db, orgId, first.policyId))?.config ?? null) : null;
  }

  /** The policy PUT /api/floor would bind for floor `f`: per-kind floors
   * carried, a latency bound kept as compound, riders carried. Shared with
   * the feasibility read so the warning describes exactly what would bind. */
  async function floorPolicyFor(orgId: string, f: number): Promise<Policy> {
    const current = await currentBoundPolicy(orgId);
    const carried = { ...(current?.shadow ? { shadow: current.shadow } : {}), ...(current?.guarantee ? { guarantee: current.guarantee } : {}) };
    if (current && (current.type === 'min_cost' || current.type === 'compound')) return { ...current, qualityFloor: f };
    if (current && current.type === 'latency_bound') return { type: 'compound', qualityFloor: f, p95Ms: current.p95Ms, ...carried };
    return { type: 'min_cost', qualityFloor: f, ...carried };
  }

  /** Merge the proposals' floors into the org's bound policy (routing/floors.ts)
   * as a NEW policy row — policies are immutable history — and rebind keys. */
  /**
   * A PROPOSAL MAY ONLY BE APPLIED OVER THE WORLD IT MEASURED (2026-09-11).
   * The 2026-09-08 incident was a proposal applied over a frontier it had
   * never seen at prices it had never seen. The proposal records both the
   * frontier version and the prices version it measured against
   * (migrations 0095/0096); apply refuses when either has moved. Rows
   * written before tracking (NULL) cannot be checked and are let through —
   * the learning period re-measures them once, after which they carry both.
   */
  async function proposalStaleness(orgId: string, p: { clusterId: string; frontierVersion: number | null; pricesVersion: string | null }): Promise<string | null> {
    if (p.frontierVersion !== null) {
      const now = await loadCurrentFrontier(db, p.clusterId, orgId);
      if (now === null) return `no frontier serves ${p.clusterId} now (measured against v${p.frontierVersion})`;
      if (now.version !== p.frontierVersion) return `frontier moved v${p.frontierVersion} → v${now.version}`;
    }
    if (p.pricesVersion !== null && p.pricesVersion !== ctx.prices.version) return `prices moved ${p.pricesVersion} → ${ctx.prices.version}`;
    return null;
  }

  async function applyFloors(orgId: string, proposals: { clusterId: string; suggestedFloor: number }[]) {
    const first = await getFirstApiKeyWithPolicy(db, orgId);
    const current = first?.policyId ? ((await getPolicyById(db, orgId, first.policyId))?.config ?? null) : null;
    let policy: Policy | null = current;
    for (const p of proposals) {
      // Caption-vs-provenance, CLOSED end-to-end (2026-09-01; the 0.5 clamp
      // was removed proposal-side on 2026-08-31 but survived HERE): the
      // card says "set my bar at 0.38" — the write must be 0.38. FLOOR to
      // 2dp (the worker's own suggestedFloorFor semantics — conservative,
      // never rounded up past the measurement), bounded only by [0, 1],
      // which is all core PolicySchema requires.
      const floor = mintFloor(p.suggestedFloor);
      policy = withClusterFloor(policy, p.clusterId, floor);
    }
    const merged = policy as Policy;
    const n = Object.keys(clusterFloorsOf(merged)).length;
    const policyId = `pol-${randomUUID().slice(0, 8)}`;
    await insertPolicy(db, { id: policyId, orgId, name: `your bar · ${n} kind${n === 1 ? '' : 's'} of work`, config: merged });
    const keys = (await listApiKeys(db, orgId)).filter((k) => !k.revokedAt);
    for (const k of keys) await updateApiKeyPolicy(db, orgId, k.id, policyId);
    return { policyId, policy: merged, keysRebound: keys.length };
  }
}

function clusterFloorsOf(policy: Policy): Record<string, number> {
  return policy.type === 'min_cost' || policy.type === 'compound' ? (policy.clusterFloors ?? {}) : {};
}

function dto(r: { models: string[]; other: string | null; samplingConsent: boolean; sampleCapPerCluster: number; designatedAt: Date }) {
  return { models: r.models, other: r.other, samplingConsent: r.samplingConsent, sampleCapPerCluster: r.sampleCapPerCluster, designatedAt: r.designatedAt.toISOString() };
}

function proposalDto(p: Awaited<ReturnType<typeof getLearningProposal>>) {
  if (!p) return null;
  return {
    id: p.id,
    clusterId: p.clusterId,
    incumbentModel: p.incumbentModel,
    incumbentQuality: p.incumbentQuality,
    incumbentCostPer1K: p.incumbentCostPer1K,
    servingModel: p.servingModel,
    servingQuality: p.servingQuality,
    servingCostPer1K: p.servingCostPer1K,
    retention: p.retention,
    suggestedFloor: p.suggestedFloor,
    projectedSaving: p.projectedSaving,
    items: p.items,
    status: p.status,
    statusReason: p.statusReason,
    createdAt: p.createdAt.toISOString(),
    appliedAt: p.appliedAt ? p.appliedAt.toISOString() : null,
  };
}
