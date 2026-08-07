// Quality-guarantee routes (M3, ROADMAP #22, SPEC §12.5).
//
//   GET  /api/guarantee/status        per-policy rolling quality + breaches (org-scoped)
//   POST /api/incidents/:id/resolve   resolve an incident (admin role only)
//
// Org scoping: the dashboard auth hook (server.ts, runs on every /api/*
// request) resolves Bearer api key → session cookie → dev bypass → 401 and
// attaches req.potionOrg — the handlers below read THAT context, so session
// roles (viewer/member/admin) are honored exactly like the other guarded
// routes. Every query filters org_id; cross-org reads/resolves are
// impossible by construction (resolveIncident is keyed (id, orgId)). The
// resolve route's admin check is a plain ROLE check (not requireRole's
// additional apiKey admin-SCOPE gate — resolving an incident is an incident
// workflow action, not key-lifecycle admin).
//
// Status shape (per the contract): one entry per guarantee-carrying policy
// of the org — { policyId, guarantee, rollingQuality, samples, breaches }.
// rollingQuality/samples are the org's rolling mean + count over the
// policy's OWN windowMin; breaches is the org's incident list (ALL
// unresolved + last 20 resolved, unresolved first — incidents carry their
// own cluster/strategy detail, so the list is shared across policies).
import type { FastifyInstance } from 'fastify';
import type { GuaranteeConfig } from '@potion/core';
import {
  activeIncumbent,
  designateIncumbent,
  getClusterByIdForOrg,
  latestJudgeCalibration,
  listIncidents,
  listIncumbents,
  listPoliciesWithGuarantee,
  resolveIncident,
  rollingQualityForPolicy,
  type ClusterIncumbentRow,
  type IncidentRow,
} from '@potion/db';
import { defaultServeJudgeModel } from '@potion/harness';
import { openAiError, roleAtLeast } from '../auth.js';
import type { PotionContext } from '../context.js';

export interface IncidentDto {
  id: string;
  /** 'advisory' (G2.1): serve-leg tripwire — shown labeled, never a
   * contractual breach and never an operating-point change. */
  kind: 'quality_breach' | 'rollback' | 'advisory';
  detail: Record<string, unknown>;
  createdAt: string;
  resolvedAt: string | null;
}

/** Judge-trust evidence surfaced per policy (G0.2) — the latest calibration
 * record for the policy's EFFECTIVE judge, matched to the serving provider
 * mode (a mock calibration never presents as live trust evidence). */
export interface JudgeCalibrationDto {
  judgeModel: string;
  pearsonVsTruth: number | null;
  n: number;
  flagged: boolean;
  providerMode: string;
  createdAt: string;
}

export interface GuaranteePolicyStatus {
  policyId: string;
  guarantee: GuaranteeConfig;
  rollingQuality: number | null;
  samples: number;
  breaches: IncidentDto[];
  /** null = this judge has never been calibrated (itself a trust signal). */
  judgeCalibration: JudgeCalibrationDto | null;
  /** G2.1: the contractual retention floor this policy evaluates under
   * (config or the 0.9 platform default — evaluation-time, never stored). */
  retentionFloor: number;
  /** G2.1 LEGACY MARKER: true when the org has NO active incumbent
   * designation — breach verdicts still use the absolute minQuality path,
   * and retention is unavailable until an incumbent is designated. */
  legacyPath: boolean;
}

/** Active designation surfaced org-wide (G2.1). */
export interface IncumbentDto {
  clusterId: string;
  strategyHash: string;
  designatedAt: string;
  status: string;
  statusReason: string | null;
}

export interface GuaranteeStatus {
  orgId: string;
  policies: GuaranteePolicyStatus[];
  /** G2.1: the org's ACTIVE incumbent designations — the trust-hierarchy
   * switch. Empty = every cluster is on the labeled legacy path. */
  incumbents: IncumbentDto[];
  /** Open serve-leg advisories (tripwires whose suite-verify is pending). */
  openAdvisories: number;
}

/** Platform default retention floor (G2.1) — evaluation-time only. */
export const PLATFORM_RETENTION_FLOOR = 0.9;

export function incumbentDto(row: ClusterIncumbentRow): IncumbentDto {
  return {
    clusterId: row.clusterId,
    strategyHash: row.strategyHash,
    designatedAt: row.designatedAt.toISOString(),
    status: row.status,
    statusReason: row.statusReason,
  };
}

export function incidentDto(row: IncidentRow): IncidentDto {
  return {
    id: row.id,
    kind: row.kind,
    detail: row.detail,
    createdAt: row.createdAt.toISOString(),
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
  };
}

export function registerGuaranteeRoutes(app: FastifyInstance, ctx: PotionContext): void {
  // ---- GET /api/guarantee/status — org-scoped per-policy rolling quality ----
  app.get('/api/guarantee/status', async (req, reply) => {
    const org = req.potionOrg;
    if (!org) {
      return reply
        .code(401)
        .send(openAiError('authentication required', 'invalid_request_error', 'authentication_required'));
    }
    const [policies, incidents, designations] = await Promise.all([
      listPoliciesWithGuarantee(ctx.db.db, org.orgId),
      listIncidents(ctx.db.db, org.orgId),
      listIncumbents(ctx.db.db, org.orgId),
    ]);
    const breaches = incidents.map(incidentDto);
    const incumbents = designations.filter((d) => d.status === 'active').map(incumbentDto);
    const openAdvisories = incidents.filter(
      (i) => i.kind === 'advisory' && i.resolvedAt === null,
    ).length;
    const statuses: GuaranteePolicyStatus[] = await Promise.all(
      policies.map(async (p) => {
        const guarantee = p.config.guarantee!;
        // G0.3: the rolling number is the POLICY's keyed evidence — the same
        // population its breach windows evaluate — not an org-wide pool.
        const rolling = await rollingQualityForPolicy(ctx.db.db, {
          orgId: org.orgId,
          policyId: p.id,
          windowMin: guarantee.windowMin,
        });
        // G0.2: the policy's effective judge + its latest calibration for
        // THIS provider mode. null = never calibrated — a trust signal.
        const judgeModel = guarantee.judgeModel ?? defaultServeJudgeModel(ctx.providerMode);
        const calibration = await latestJudgeCalibration(ctx.db.db, {
          judgeModel,
          providerMode: ctx.providerMode,
        });
        return {
          policyId: p.id,
          guarantee,
          rollingQuality: rolling.mean,
          samples: rolling.samples,
          breaches,
          judgeCalibration: calibration
            ? {
                judgeModel,
                pearsonVsTruth: calibration.pearsonVsTruth,
                n: calibration.n,
                flagged: calibration.flagged,
                providerMode: calibration.providerMode,
                createdAt: calibration.createdAt.toISOString(),
              }
            : null,
          retentionFloor: guarantee.retentionFloor ?? PLATFORM_RETENTION_FLOOR,
          legacyPath: incumbents.length === 0,
        };
      }),
    );
    const body: GuaranteeStatus = { orgId: org.orgId, policies: statuses, incumbents, openAdvisories };
    return reply.send(body);
  });

  // ---- G2.1 incumbent designation (the retention baseline) ----
  // Designation is per (org, cluster) and admin-only: the incumbent is the
  // denominator of every contractual verdict. Restricted to ORG-OWNED agent
  // clusters — the contractual leg re-evaluates on the org's derived suite,
  // which only exists for its own workloads. NO silent default anywhere: an
  // undesignated cluster stays on the labeled legacy path.
  app.post('/api/guarantee/clusters/:clusterId/incumbent', async (req, reply) => {
    const org = req.potionOrg;
    if (!org) {
      return reply
        .code(401)
        .send(openAiError('authentication required', 'invalid_request_error', 'authentication_required'));
    }
    if (!roleAtLeast(org.role, 'admin')) {
      return reply
        .code(403)
        .send(
          openAiError(
            `role '${org.role}' may not designate incumbents — requires 'admin'`,
            'invalid_request_error',
            'insufficient_role',
          ),
        );
    }
    const { clusterId } = req.params as { clusterId: string };
    const body = (req.body ?? {}) as { strategyHash?: unknown };
    if (typeof body.strategyHash !== 'string' || body.strategyHash.length === 0) {
      return reply
        .code(400)
        .send(openAiError('strategyHash (string) is required', 'invalid_request_error', 'invalid_request_error'));
    }
    const cluster = await getClusterByIdForOrg(ctx.db.db, clusterId, org.orgId);
    if (!cluster || cluster.orgId !== org.orgId) {
      // Unknown, foreign, or platform cluster — all 404 (retention verdicts
      // need the org's OWN derived suite; platform clusters have none).
      return reply
        .code(404)
        .send(openAiError('cluster not found for this org', 'invalid_request_error', 'not_found'));
    }
    try {
      const row = await designateIncumbent(ctx.db.db, org.orgId, clusterId, body.strategyHash);
      return reply.send({ incumbent: incumbentDto(row) });
    } catch (err) {
      // Unknown strategy hash — a designation pointing at nothing would
      // render every later verdict unexplainable.
      return reply
        .code(400)
        .send(openAiError((err as Error).message, 'invalid_request_error', 'invalid_request_error'));
    }
  });

  // ---- POST manual suite-verify (G2.1 contractual leg, admin) ----
  // The advisory serve leg enqueues this automatically; the manual route
  // exists for operator-driven verification and the walkthrough. 202 + the
  // jobId (the job result carries the providerMode-stamped verdict).
  app.post('/api/guarantee/clusters/:clusterId/verify', async (req, reply) => {
    const org = req.potionOrg;
    if (!org) {
      return reply
        .code(401)
        .send(openAiError('authentication required', 'invalid_request_error', 'authentication_required'));
    }
    if (!roleAtLeast(org.role, 'admin')) {
      return reply
        .code(403)
        .send(
          openAiError(
            `role '${org.role}' may not launch suite verification — requires 'admin'`,
            'invalid_request_error',
            'insufficient_role',
          ),
        );
    }
    const { clusterId } = req.params as { clusterId: string };
    const body = (req.body ?? {}) as { policyId?: unknown; servingStrategyHash?: unknown; capUsd?: unknown };
    if (typeof body.policyId !== 'string' || typeof body.servingStrategyHash !== 'string') {
      return reply
        .code(400)
        .send(openAiError('policyId and servingStrategyHash (strings) are required', 'invalid_request_error', 'invalid_request_error'));
    }
    const cluster = await getClusterByIdForOrg(ctx.db.db, clusterId, org.orgId);
    if (!cluster || cluster.orgId !== org.orgId) {
      return reply
        .code(404)
        .send(openAiError('cluster not found for this org', 'invalid_request_error', 'not_found'));
    }
    if (!ctx.queue) {
      return reply
        .code(503)
        .send(openAiError('job queue unavailable', 'server_error', 'queue_unavailable'));
    }
    const jobId = await ctx.queue.enqueue('guarantee:suite-verify', {
      orgId: org.orgId,
      policyId: body.policyId,
      clusterId,
      servingStrategyHash: body.servingStrategyHash,
      ...(typeof body.capUsd === 'number' ? { capUsd: body.capUsd } : {}),
    });
    return reply.code(202).send({ jobId });
  });

  // ---- GET designation history (superseded rows kept, reasons attached) ----
  app.get('/api/guarantee/clusters/:clusterId/incumbent', async (req, reply) => {
    const org = req.potionOrg;
    if (!org) {
      return reply
        .code(401)
        .send(openAiError('authentication required', 'invalid_request_error', 'authentication_required'));
    }
    const { clusterId } = req.params as { clusterId: string };
    const cluster = await getClusterByIdForOrg(ctx.db.db, clusterId, org.orgId);
    if (!cluster || cluster.orgId !== org.orgId) {
      return reply
        .code(404)
        .send(openAiError('cluster not found for this org', 'invalid_request_error', 'not_found'));
    }
    const [active, history] = await Promise.all([
      activeIncumbent(ctx.db.db, org.orgId, clusterId),
      listIncumbents(ctx.db.db, org.orgId, clusterId),
    ]);
    return reply.send({
      active: active ? incumbentDto(active) : null,
      history: history.map(incumbentDto),
    });
  });

  // ---- POST /api/incidents/:id/resolve — admin role only ----
  // Resolving a kind='rollback' incident LIFTS the operating-point override
  // (the serving path honors only unresolved rollback incidents) — i.e. this
  // is the "restore normal policy routing" button, hence admin-only.
  app.post('/api/incidents/:id/resolve', async (req, reply) => {
    const org = req.potionOrg;
    if (!org) {
      return reply
        .code(401)
        .send(openAiError('authentication required', 'invalid_request_error', 'authentication_required'));
    }
    if (!roleAtLeast(org.role, 'admin')) {
      return reply
        .code(403)
        .send(
          openAiError(
            `role '${org.role}' may not resolve incidents — requires 'admin'`,
            'invalid_request_error',
            'insufficient_role',
          ),
        );
    }
    const { id } = req.params as { id: string };
    const resolved = await resolveIncident(ctx.db.db, org.orgId, id);
    if (!resolved) {
      // Unknown id FOR THIS ORG, or already resolved (both 404 — neither
      // leaks the incident's existence across tenants).
      return reply
        .code(404)
        .send(openAiError('incident not found', 'invalid_request_error', 'not_found'));
    }
    return reply.send({ incident: incidentDto(resolved) });
  });
}
