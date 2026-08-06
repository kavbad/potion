// Share-link routes (M4, ROADMAP #31, SPEC §13.3).
//
//   POST /api/share                         mint a link (member+; the dashboard
//                                           auth hook enforces the write role)
//   GET  /api/share                         list the org's links (viewer+)
//   POST /api/share/:id/revoke              kill a link (admin role)
//   GET  /api/public/share/:token/frontier  PUBLIC read-only frontier payload
//   GET  /api/public/share/:token/report    PUBLIC read-only savings report
//
// Token discipline (same as sessions/magic-links): the raw token (`st_…`) is
// returned EXACTLY ONCE at mint time; only its sha256 (token_hash, globally
// unique) is stored. The public routes take no session — the token IS the
// credential. The dashboard auth hook exempts /api/public/* (see auth.ts).
//
// Unknown, revoked, and kind-mismatched tokens ALL 404 with the same body —
// no existence oracle. Revocation is atomic + org-scoped in the repo, so a
// token id from another org 404s identically.
//
// Redaction: redact_names (default true) strips org-identifying fields (org
// id/name — the payload never carries user emails or key names) from the
// PUBLIC responses. Cluster names + strategy labels are platform evidence
// (shared-global by design, ROADMAP #13) and always stay. Provenance is
// preserved per point: provider_mode 'mock'/'unknown' travels as-is so the
// share page can badge SIMULATED — a shared simulated frontier is never
// presented as live.
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sha256 } from '@potion/core';
import {
  findShareTokenByHash,
  getOrgById,
  insertShareToken,
  listShareTokens,
  revokeShareToken,
  type ShareTokenRow,
} from '@potion/db';
import { loadTaxonomy } from '@potion/cluster';
import { loadCurrentFrontier } from '@potion/pareto';
import { openAiError, roleAtLeast } from '../auth.js';
import type { PotionContext } from '../context.js';
import { loadReport, type SavingsReport } from './reports.js';

/** Raw-token prefix (shape parity with pk_/ps_/ml_). */
export const SHARE_TOKEN_PREFIX = 'st_';

/** Dashboard-relative public URL for a token (the dashboard serves /share/*). */
export function shareUrlPath(kind: 'frontier' | 'report', token: string): string {
  return kind === 'frontier' ? `/share/f/${token}` : `/share/r/${token}`;
}

export interface ShareTokenDto {
  id: string;
  kind: 'frontier' | 'report';
  payload: Record<string, unknown>;
  redactNames: boolean;
  /** Identification-only prefix of the sha256 hash — the raw token is never
   * stored, so the list can only mask it. */
  tokenHashPrefix: string;
  createdAt: string;
  revokedAt: string | null;
}

export function shareTokenDto(row: ShareTokenRow): ShareTokenDto {
  return {
    id: row.id,
    kind: row.kind,
    payload: row.payload,
    redactNames: row.redactNames,
    tokenHashPrefix: row.tokenHash.slice(0, 8),
    createdAt: row.createdAt.toISOString(),
    revokedAt: row.revokedAt?.toISOString() ?? null,
  };
}

const CreateShareSchema = z
  .object({
    kind: z.enum(['frontier', 'report']),
    /** Required for kind='frontier'; ignored for 'report'. */
    clusterId: z.string().min(1).max(200).optional(),
    /** kind='report': trailing window in days (default 30, max 366). */
    windowDays: z.number().int().min(1).max(366).optional(),
    /** Strip org-identifying fields from the public payload (default true). */
    redactNames: z.boolean().optional(),
  })
  .strict();

const DEFAULT_WINDOW_DAYS = 30;

/** Org block included in public responses ONLY when redact_names=false. */
async function organizationBlock(
  ctx: PotionContext,
  orgId: string,
  redactNames: boolean,
): Promise<{ organization: { id: string; name: string } | null }> {
  if (redactNames) return { organization: null };
  const org = await getOrgById(ctx.db.db, orgId);
  return { organization: org ? { id: org.id, name: org.name } : null };
}

/** Resolve + validate a public token for one kind. Returns the row, or sends
 * the uniform 404 and returns null. */
async function resolvePublicToken(
  ctx: PotionContext,
  reply: { code: (n: number) => { send: (b: unknown) => unknown } },
  rawToken: string,
  kind: 'frontier' | 'report',
): Promise<ShareTokenRow | null> {
  const row = rawToken.startsWith(SHARE_TOKEN_PREFIX)
    ? await findShareTokenByHash(ctx.db.db, sha256(rawToken))
    : null;
  if (!row || row.revokedAt !== null || row.kind !== kind) {
    void reply.code(404).send(openAiError('share link not found', 'invalid_request_error', 'not_found'));
    return null;
  }
  return row;
}

export function registerShareRoutes(app: FastifyInstance, ctx: PotionContext): void {
  // ---- POST /api/share — mint a link (member+ via the dashboard auth hook) ----
  app.post('/api/share', async (req, reply) => {
    const org = req.potionOrg;
    if (!org) {
      return reply
        .code(401)
        .send(openAiError('authentication required', 'invalid_request_error', 'authentication_required'));
    }
    const parsed = CreateShareSchema.safeParse(req.body);
    if (!parsed.success) {
      const message = parsed.error.issues
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ');
      return reply.code(400).send(openAiError(message, 'invalid_request_error'));
    }
    const { kind, clusterId, windowDays, redactNames } = parsed.data;

    let payload: Record<string, unknown>;
    if (kind === 'frontier') {
      if (!clusterId) {
        return reply
          .code(400)
          .send(openAiError("kind 'frontier' requires clusterId", 'invalid_request_error'));
      }
      // The link targets a CURRENT frontier — minting against a cluster with
      // no frontier would 404 every reader forever, so refuse up front.
      const frontier = await loadCurrentFrontier(ctx.db.db, clusterId);
      if (!frontier) {
        return reply
          .code(404)
          .send(openAiError(`no frontier for cluster '${clusterId}'`, 'invalid_request_error'));
      }
      payload = { clusterId };
    } else {
      payload = { windowDays: windowDays ?? DEFAULT_WINDOW_DAYS };
    }

    const token = `${SHARE_TOKEN_PREFIX}${randomUUID().replace(/-/g, '')}`;
    const row = await insertShareToken(ctx.db.db, {
      orgId: org.orgId,
      kind,
      payload,
      tokenHash: sha256(token), // hash-only storage — the raw token is never persisted
      redactNames: redactNames ?? true,
    });
    return reply.code(201).send({
      id: row.id,
      kind: row.kind,
      // Returned ONCE — it cannot be recovered later (hash-only storage).
      token,
      url: shareUrlPath(row.kind, token),
      createdAt: row.createdAt.toISOString(),
    });
  });

  // ---- GET /api/share — the org's links, masked (viewer+) ----
  app.get('/api/share', async (req, reply) => {
    const org = req.potionOrg;
    if (!org) {
      return reply
        .code(401)
        .send(openAiError('authentication required', 'invalid_request_error', 'authentication_required'));
    }
    const rows = await listShareTokens(ctx.db.db, org.orgId);
    return reply.send({ tokens: rows.map(shareTokenDto) });
  });

  // ---- POST /api/share/:id/revoke — admin role ----
  // Plain ROLE check (not requireRole's apiKey admin-SCOPE gate): revoking a
  // share link is a share workflow action, not key-lifecycle admin — same
  // reasoning as POST /api/incidents/:id/resolve (routes/guarantee.ts).
  app.post('/api/share/:id/revoke', async (req, reply) => {
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
            `role '${org.role}' may not revoke share links — requires 'admin'`,
            'invalid_request_error',
            'insufficient_role',
          ),
        );
    }
    const { id } = req.params as { id: string };
    const revoked = await revokeShareToken(ctx.db.db, org.orgId, id);
    if (!revoked) {
      // Unknown id FOR THIS ORG, or already revoked (both 404 — no oracle).
      return reply
        .code(404)
        .send(openAiError('share link not found', 'invalid_request_error', 'not_found'));
    }
    return reply.send({ token: shareTokenDto(revoked) });
  });

  // ---- GET /api/public/share/:token/frontier — PUBLIC (no session) ----
  app.get('/api/public/share/:token/frontier', async (req, reply) => {
    const { token } = req.params as { token: string };
    const row = await resolvePublicToken(ctx, reply, token, 'frontier');
    if (!row) return reply;
    const clusterId = typeof row.payload.clusterId === 'string' ? row.payload.clusterId : null;
    const frontier = clusterId ? await loadCurrentFrontier(ctx.db.db, clusterId) : null;
    if (!frontier || !clusterId) {
      return reply
        .code(404)
        .send(openAiError('share link not found', 'invalid_request_error', 'not_found'));
    }
    const taxonomyCluster = loadTaxonomy().clusters.find((c) => c.id === clusterId);
    const orgBlock = await organizationBlock(ctx, row.orgId, row.redactNames);
    return reply.send({
      kind: 'frontier',
      clusterId,
      /** Cluster names stay under redaction (platform evidence, ROADMAP #13). */
      clusterName: taxonomyCluster?.name ?? clusterId,
      frontier: {
        id: frontier.id,
        clusterId: frontier.clusterId,
        version: frontier.version,
        pricesVersion: frontier.pricesVersion,
        createdAt: frontier.createdAt,
        points: frontier.points.map((p) => ({
          strategyHash: p.strategyHash,
          strategyConfig: p.strategyConfig,
          quality: p.quality,
          costPer1K: p.costPer1K,
          latencyP95: p.latencyP95,
          // Provenance preserved per point — the share page badges SIMULATED.
          providerMode: p.providerMode ?? 'unknown',
        })),
      },
      provenance: {
        live: frontier.points.filter((p) => p.providerMode === 'live').length,
        simulated: frontier.points.filter((p) => p.providerMode !== 'live').length,
      },
      redacted: row.redactNames,
      sharedAt: row.createdAt.toISOString(),
      ...orgBlock,
    });
  });

  // ---- GET /api/public/share/:token/report — PUBLIC (no session) ----
  app.get('/api/public/share/:token/report', async (req, reply) => {
    const { token } = req.params as { token: string };
    const row = await resolvePublicToken(ctx, reply, token, 'report');
    if (!row) return reply;
    const windowDays =
      typeof row.payload.windowDays === 'number' && Number.isInteger(row.payload.windowDays)
        ? Math.min(Math.max(row.payload.windowDays, 1), 366)
        : DEFAULT_WINDOW_DAYS;
    const to = new Date();
    const from = new Date(to.getTime() - (windowDays - 1) * 24 * 3600 * 1000);
    const range = {
      fromDay: from.toISOString().slice(0, 10),
      toDay: to.toISOString().slice(0, 10),
    };
    // The SAME report builder as the authed route, scoped to the token's org.
    const report = await loadReport(ctx, row.orgId, range);
    const orgBlock = await organizationBlock(ctx, row.orgId, row.redactNames);
    const publicReport: SavingsReport = row.redactNames
      ? { ...report, orgId: 'shared' } // org id is org-identifying — strip it
      : report;
    return reply.send({
      kind: 'report',
      windowDays,
      from: range.fromDay,
      to: range.toDay,
      report: publicReport,
      redacted: row.redactNames,
      sharedAt: row.createdAt.toISOString(),
      ...orgBlock,
    });
  });
}
