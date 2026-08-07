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
  listIncidents,
  listPoliciesWithGuarantee,
  resolveIncident,
  rollingQualityForPolicy,
  type IncidentRow,
} from '@potion/db';
import { openAiError, roleAtLeast } from '../auth.js';
import type { PotionContext } from '../context.js';

export interface IncidentDto {
  id: string;
  kind: 'quality_breach' | 'rollback';
  detail: Record<string, unknown>;
  createdAt: string;
  resolvedAt: string | null;
}

export interface GuaranteePolicyStatus {
  policyId: string;
  guarantee: GuaranteeConfig;
  rollingQuality: number | null;
  samples: number;
  breaches: IncidentDto[];
}

export interface GuaranteeStatus {
  orgId: string;
  policies: GuaranteePolicyStatus[];
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
    const [policies, incidents] = await Promise.all([
      listPoliciesWithGuarantee(ctx.db.db, org.orgId),
      listIncidents(ctx.db.db, org.orgId),
    ]);
    const breaches = incidents.map(incidentDto);
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
        return {
          policyId: p.id,
          guarantee,
          rollingQuality: rolling.mean,
          samples: rolling.samples,
          breaches,
        };
      }),
    );
    const body: GuaranteeStatus = { orgId: org.orgId, policies: statuses };
    return reply.send(body);
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
