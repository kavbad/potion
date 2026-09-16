// G1 challenger promotion (ROADMAP §G1: identify → measure → prove →
// proposal → PROMOTE).
//
//   GET  /api/challengers            viewer — proposals, newest first
//   POST /api/challengers/:id/apply  admin  — promote: mint the ORG frontier
//
// THE PROMOTION MECHANISM, and why it cannot force a bad route: apply does
// not pin the challenger. It aggregates the org's OWN suite measurements
// (org-scoped, provenance-pure, one instrument — the same run that proved
// the proposal) into an org frontier for the cluster and saves it. Serving
// already prefers org frontiers, and selection still runs the lower-bound
// law over the measured points — so routing changes through the measured
// field, never by fiat, and a challenger whose org-measured quality cannot
// clear the floor simply does not serve. The response says what NOW serves,
// fallback flags included; the router narrates the change on its next
// compile as a new version.
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { PolicySchema, strategyHash, type Policy, type StrategyConfig } from '@potion/core';
import {
  getChallengerProposal,
  getOrgIncumbents,
  getStrategyConfigs,
  listChallengerProposals,
  getCurrentServingPolicy,
  markChallengerApplied,
} from '@potion/db';
import {
  DEFAULT_ORG_POLICY,
  aggregatesFromEvalResults,
  computeFrontier,
  loadCurrentFrontier,
  saveFrontier,
  servingDecisionFor,
} from '@potion/pareto';
import { openAiError, requireRole } from '../auth.js';
import { strategyModelLabel } from './chat.js';
import type { PotionContext } from '../context.js';

export function registerChallengerRoutes(app: FastifyInstance, ctx: PotionContext): void {
  const db = ctx.db.db;

  // ---- GET /api/challengers (viewer) ----
  app.get('/api/challengers', async (req, reply) => {
    const orgId = req.potionOrg!.orgId;
    const rows = await listChallengerProposals(db, orgId);
    return reply.send({
      proposals: rows.map((p) => ({
        id: p.id,
        clusterId: p.clusterId,
        status: p.status,
        servingModel: p.servingModel,
        servingQuality: p.servingQuality,
        challengerModel: p.challengerModel,
        challengerQuality: p.challengerQuality,
        retention: p.retention,
        shadow: p.shadow,
        items: p.items,
        createdAt: p.createdAt.toISOString(),
        appliedAt: p.appliedAt?.toISOString() ?? null,
        appliedFrontierId: p.appliedFrontierId,
      })),
    });
  });

  // ---- POST /api/challengers/:id/apply (admin) ----
  app.post('/api/challengers/:id/apply', { preHandler: [requireRole('admin')] }, async (req, reply) => {
    const orgId = req.potionOrg!.orgId;
    const { id } = req.params as { id: string };
    const p = await getChallengerProposal(db, orgId, id);
    if (!p) return reply.code(404).send(openAiError(`unknown challenger proposal '${id}'`, 'invalid_request_error', 'not_found'));
    if (p.status !== 'proposed') return reply.code(409).send(openAiError(`proposal is ${p.status}`, 'invalid_request_error', 'proposal_not_open'));

    // The strategies whose org measurements build the frontier: serving +
    // challenger, plus the org's named incumbents when they were measured
    // (aggregation naturally drops anything without rows).
    const frontierNow = await loadCurrentFrontier(db, p.clusterId, orgId);
    const byHash = new Map((frontierNow?.points ?? []).map((pt) => [pt.strategyHash, pt.strategyConfig] as const));
    const stored = new Map((await getStrategyConfigs(db, [p.servingHash, p.challengerHash])).map((r) => [r.hash, r.config] as const));
    const configFor = (hash: string): StrategyConfig | undefined => byHash.get(hash) ?? stored.get(hash);
    const servingCfg = configFor(p.servingHash);
    const challengerCfg = configFor(p.challengerHash);
    if (servingCfg === undefined || challengerCfg === undefined) {
      return reply.code(409).send(
        openAiError('serving or challenger strategy config is no longer resolvable — re-measure before applying', 'invalid_request_error', 'config_unresolvable'),
      );
    }
    const incumbents = (await getOrgIncumbents(db, orgId))?.models ?? [];
    const strategies: StrategyConfig[] = [servingCfg, challengerCfg];
    for (const m of incumbents) {
      const cfg: StrategyConfig = { type: 'single', model: m };
      if (!strategies.some((s) => strategyHash(s) === strategyHash(cfg))) strategies.push(cfg);
    }

    // Org-scoped, provenance-pure, one-instrument aggregation (the G1.8
    // rule the research cycle follows): the org's rows at the CURRENT
    // prices version, in this server's provider mode.
    const aggregates = await aggregatesFromEvalResults(db, p.clusterId, strategies, ctx.prices.version, {
      orgId,
      providerMode: ctx.providerMode,
    });
    if (!aggregates.some((a) => a.strategyHash === p.challengerHash)) {
      return reply.code(409).send(
        openAiError(
          `no org-scoped ${ctx.providerMode} measurements for the challenger at prices ${ctx.prices.version} — re-run the learning period before applying`,
          'invalid_request_error',
          'evidence_missing',
        ),
      );
    }
    const points = computeFrontier(aggregates);
    const saved = await saveFrontier(db, p.clusterId, points, 'recompute', ctx.prices.version, {
      orgId,
      provenance: { suiteId: p.suiteId },
    });
    const applied = await markChallengerApplied(db, orgId, id, saved.id);
    if (!applied) return reply.code(409).send(openAiError('proposal was applied concurrently', 'invalid_request_error', 'proposal_not_open'));

    // What NOW serves, through the one resolver — fallback flags included,
    // because the honest answer to "apply" is what production will do next.
    // The org's CURRENT rule, not its oldest (2026-09-16; see @potion/db).
    const currentPolicy = await getCurrentServingPolicy(db, orgId);
    const parsed = currentPolicy !== null ? PolicySchema.safeParse(currentPolicy.config) : null;
    const policy: Policy = parsed?.success ? parsed.data : DEFAULT_ORG_POLICY;
    const d = await servingDecisionFor(db, {
      orgId,
      clusterId: p.clusterId,
      policy,
      providerMode: ctx.providerMode,
      prices: ctx.prices,
    });
    return reply.send({
      applied: true,
      frontierId: saved.id,
      frontierVersion: saved.version,
      points: points.length,
      nowServes:
        d.op.config === null
          ? null
          : {
              model: strategyModelLabel(d.op.config),
              strategy: strategyHash(d.op.config).slice(0, 8),
              fallback: d.op.fallback,
              ...(d.op.fallbackReason !== undefined ? { fallbackReason: d.op.fallbackReason } : {}),
            },
      requestId: `apply-${randomUUID().slice(0, 8)}`,
    });
  });
}
