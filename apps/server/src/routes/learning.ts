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
import { floorFor, withClusterFloor } from '../routing/floors.js';
import type { PotionContext } from '../context.js';
import type { PotionQueue } from '@potion/queue';
import { incumbentRoster, resolveTypedModel } from '../incumbents/roster.js';
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
    const { policyId, policy, keysRebound } = await applyFloors(org.orgId, [p]);
    await markProposalApplied(db, org.orgId, id, policyId);
    return reply.send({ applied: true, policyId, qualityFloor: floorFor(policy, p.clusterId), clusterFloors: clusterFloorsOf(policy), keysRebound });
  });

  // Every open proposal at once: one new policy carrying a floor per kind of
  // work, every active key rebound to it.
  app.post('/api/learning/proposals/apply-all', { preHandler: [requireRole('admin')] }, async (req, reply) => {
    const org = req.potionOrg!;
    const open = (await listLearningProposals(db, org.orgId)).filter((p) => p.status === 'proposed');
    if (open.length === 0) return reply.code(409).send(openAiError('no open proposals', 'invalid_request_error', 'proposal_not_open'));
    const { policyId, policy, keysRebound } = await applyFloors(org.orgId, open);
    for (const p of open) await markProposalApplied(db, org.orgId, p.id, policyId);
    return reply.send({ applied: open.length, policyId, clusterFloors: clusterFloorsOf(policy), keysRebound });
  });

  // The org-wide quality floor, settable from /settings/controls (P1-7).
  // Same shape as apply: a NEW policy row (policies are immutable history)
  // carrying the changed floor, every active key rebound. Per-kind floors
  // survive a default-floor change; a latency bound survives as compound;
  // max_quality has no floor, so setting one deliberately replaces it.
  const FloorBody = z.object({ qualityFloor: z.number().min(0.5).max(1) }).strict();
  app.put('/api/floor', { preHandler: [requireRole('admin')] }, async (req, reply) => {
    const org = req.potionOrg!;
    const parsed = FloorBody.safeParse(req.body);
    if (!parsed.success) {
      const message = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
      return reply.code(400).send(openAiError(message, 'invalid_request_error'));
    }
    const f = Math.round(parsed.data.qualityFloor * 100) / 100;
    const first = await getFirstApiKeyWithPolicy(db, org.orgId);
    const current = first?.policyId ? ((await getPolicyById(db, org.orgId, first.policyId))?.config ?? null) : null;
    const carried = { ...(current?.shadow ? { shadow: current.shadow } : {}), ...(current?.guarantee ? { guarantee: current.guarantee } : {}) };
    let next: Policy;
    if (current && (current.type === 'min_cost' || current.type === 'compound')) next = { ...current, qualityFloor: f };
    else if (current && current.type === 'latency_bound') next = { type: 'compound', qualityFloor: f, p95Ms: current.p95Ms, ...carried };
    else next = { type: 'min_cost', qualityFloor: f, ...carried };
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
    });
  });

  /** Merge the proposals' floors into the org's bound policy (routing/floors.ts)
   * as a NEW policy row — policies are immutable history — and rebind keys. */
  async function applyFloors(orgId: string, proposals: { clusterId: string; suggestedFloor: number }[]) {
    const first = await getFirstApiKeyWithPolicy(db, orgId);
    const current = first?.policyId ? ((await getPolicyById(db, orgId, first.policyId))?.config ?? null) : null;
    let policy: Policy | null = current;
    for (const p of proposals) {
      const floor = Math.max(0.5, Math.min(1, Math.round(p.suggestedFloor * 100) / 100));
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
