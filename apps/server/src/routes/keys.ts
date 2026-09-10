// Key lifecycle routes (M2 Wave 2, ROADMAP #15/#16) — REAL custody edition.
// Supersedes the M1a masked-only POST /api/keys honesty stub: raw provider
// keys are now envelope-encrypted (AES-256-GCM, per-key data key wrapped by
// the master key — see ../custody/) and actually SERVE via the per-org
// provider resolution in context.ts.
//
//   POST   /api/keys                    register a provider key (member+):
//                                       encrypt → store ciphertext →
//                                       servingEnabled: true. Idempotent on
//                                       the same raw key (per-org sha256
//                                       dedup) — never re-encrypted twice.
//   GET    /api/keys                    list (masked display only; the raw
//                                       key is never returned anywhere).
//   GET    /api/keys/:id/audit          per-key custody audit trail.
//   POST   /api/keys/:id/rotate         ADMIN. {apiKey} → re-encrypt new raw
//                                       key (new data key), key_version bump,
//                                       old ciphertext destroyed, audit
//                                       'rotate'. Serving switches on the
//                                       next request (cache busted).
//   POST   /api/keys/:id/revoke         ADMIN. status → 'revoked', audit
//                                       'revoke', cache busted — serving
//                                       stops IMMEDIATELY.
//   POST   /api/keys/:id/validate       ADMIN. Test call through the provider
//                                       with the DECRYPTED key (a real
//                                       complete() probe against the cheapest
//                                       price-table alias for that provider);
//                                       records last_validated_at + audit
//                                       'validate'.
//
// api_keys lifecycle (#15):
//   POST   /api/api-keys                ADMIN. Mint a named key {name,
//                                       scopes?, env?, expiresAt?, policyId?}
//                                       — the RAW key is returned exactly
//                                       once (only its sha256 is stored).
//   GET    /api/api-keys                list (never the raw key).
//   POST   /api/api-keys/:id/revoke     ADMIN. revoked_at set — the auth hot
//                                       path 401s immediately. Expiry
//                                       (expires_at) is enforced in the same
//                                       place (apps/server/src/auth.ts).
//
// Scopes v1 (documented in auth.ts): 'serve' (default — chat + Wave-1
// dashboard behavior) vs 'serve+admin' (adds key-lifecycle admin mutations).
// env 'live'|'test' is a label (badgeable in dashboard/billing).
//
// RBAC: mutations are admin via requireRole (sessions: membership role;
// api-key credentials additionally need the 'admin' scope); POST /api/keys
// stays member+ per the Wave-2 RBAC matrix (connecting a key is a member
// action); reads are viewer+ via the dashboard auth hook.
import { DEFAULT_ORG_POLICY } from '../routing/default-policy.js';
import {
  randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { sha256, type ProviderId } from '@potion/core';
import {
  getApiKeyById,
  getPolicyById,
  getProviderKeyByHash,
  getProviderKeyById,
  insertApiKey,
  insertProviderKey,
  listApiKeys,
  listCustodyAudit,
  listProviderKeys,
  revokeApiKey,
  rotateProviderKey,
  setProviderKeyStatus,
  touchProviderKeyValidation,
  type ProviderKeyRow, listServingPolicies, insertPolicy, insertCustodyAudit, updateApiKeyLimits } from '@potion/db';
import { openAiError, requireRole } from '../auth.js';
import type { PotionContext } from '../context.js';

// ---------- shared helpers ----------

/** Display-safe mask: first 3 chars + last 4, nothing else. (Moved from
 * routes/dashboard.ts with the M1a stub.) */
export function maskProviderKey(raw: string): string {
  if (raw.length <= 8) return '••••••••';
  return `${raw.slice(0, 3)}…${raw.slice(-4)}`;
}

/** Audit actor for the request: user id (sessions), api-key id (bearer
 * keys), or the dev bypass marker. */
export function actorOf(req: FastifyRequest): string {
  const auth = req.potionAuth;
  if (!auth) return 'unknown';
  if (auth.kind === 'session') return auth.org.userId ?? auth.session.userId;
  if (auth.kind === 'apiKey') return auth.key.id;
  return 'dev-bypass';
}

/** A provider key serves when it is active AND has a ciphertext (legacy
 * masked-only rows from before migration 0005 can never serve). */
export function providerKeyServingEnabled(row: ProviderKeyRow): boolean {
  return row.status === 'active' && row.ciphertext !== null;
}

function keyDto(row: ProviderKeyRow) {
  return {
    id: row.id,
    provider: row.provider as ProviderId,
    name: row.name,
    maskedKey: row.maskedKey,
    status: row.status,
    keyVersion: row.keyVersion,
    lastValidatedAt: row.lastValidatedAt,
    createdAt: row.createdAt,
    // Custody is REAL (M2 #16): active custodied keys serve their org.
    servingEnabled: providerKeyServingEnabled(row),
    encryption: 'aes-256-gcm-envelope',
  };
}

// ---------- provider keys ----------

const PostKeyBodySchema = z.object({
  // G2.4: 'mock' is NOT a BYOK provider. Pre-G2.4 a customer could register
  // a mock provider key and have it validate ok:true under a live server
  // (createProviders always carries a working mock transport), producing a
  // custody-audited "verified" key that serves nothing real. The mock
  // transport stays reachable only through the test-only providerFactory.
  provider: z.enum(['anthropic', 'openai', 'google', 'openrouter']),
  apiKey: z.string().min(8),
  name: z.string().min(1).max(200).optional(),
});

const RotateKeyBodySchema = z.object({
  apiKey: z.string().min(8),
});

// ---------- api keys ----------

const PostApiKeyBodySchema = z.object({
  name: z.string().min(1).max(200),
  scopes: z
    .string()
    .max(200)
    .refine(
      (raw) => {
        const tokens = raw.split(/[\s+]+/).filter(Boolean);
        return tokens.length > 0 && tokens.includes('serve') && tokens.every((t) => t === 'serve' || t === 'admin');
      },
      // G2.3: the vocabulary is closed — 'serve' (required) and 'admin'.
      // Unknown tokens are rejected at mint; anything that slips into the
      // column anyway fails closed to serve-only at resolution.
      { message: "scopes must be 'serve' or 'serve+admin' (vocabulary: serve, admin; serve required)" },
    )
    .optional(),
  env: z.enum(['live', 'test']).optional(),
  expiresAt: z.string().datetime({ offset: true }).optional(),
  policyId: z.string().min(1).optional(),
});

/** Cheapest price-table alias for a provider — the validation probe target. */
function probeModel(ctx: PotionContext, provider: ProviderId): string | null {
  const entries = ctx.prices.entries
    .filter((e) => e.provider === provider)
    .sort((a, b) => a.inputPer1M + a.outputPer1M - (b.inputPer1M + b.outputPer1M));
  return entries[0]?.alias ?? null;
}

export function registerKeyRoutes(app: FastifyInstance, ctx: PotionContext): void {
  const db = ctx.db.db;

  /** Register a provider key — ENCRYPTED + servable (custody is real). */
  app.post('/api/keys', async (req, reply) => {
    const parsed = PostKeyBodySchema.safeParse(req.body);
    if (!parsed.success) {
      const message = parsed.error.issues
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ');
      return reply.code(400).send(openAiError(message, 'invalid_request_error'));
    }
    const { provider, apiKey, name } = parsed.data;
    const org = req.potionOrg!; // resolved by the dashboard auth hook (#14)
    const keyHash = sha256(apiKey);
    // Tenant scope (M2 #13): dedup + custody are PER ORG.
    const existing = await getProviderKeyByHash(db, org.orgId, keyHash);
    if (existing) {
      // Idempotent: same raw key → the same row, 200 (never re-encrypted).
      return reply.send(keyDto(existing));
    }
    const ciphertext = await ctx.custody.encryptKey(apiKey);
    const row = {
      id: `pvk-${randomUUID().slice(0, 8)}`,
      orgId: org.orgId,
      provider,
      name: name ?? `${provider} key`,
      maskedKey: maskProviderKey(apiKey),
      keyHash,
      ciphertext,
      keyVersion: 1,
      status: 'active' as const,
    };
    await insertProviderKey(db, row);
    await ctx.custody.record(org.orgId, actorOf(req), 'encrypt', row.id, {
      provider,
      keyVersion: 1,
      master: ctx.custody.describeMaster(),
    });
    // The org may have a cached "no keys" provider set — bust it.
    ctx.invalidateOrgProviders(org.orgId);
    const stored = (await getProviderKeyById(db, org.orgId, row.id))!;
    return reply.code(201).send(keyDto(stored));
  });

  /** List provider keys — MASKED display only (the raw key never leaves
   * custody). Powers the dashboard's connected-keys list. */
  app.get('/api/keys', async (req, reply) => {
    const org = req.potionOrg!;
    const rows = await listProviderKeys(db, org.orgId);
    return reply.send({ keys: rows.map(keyDto) });
  });

  /** Per-key custody audit trail (org-scoped). */
  app.get('/api/keys/:id/audit', async (req, reply) => {
    const { id } = req.params as { id: string };
    const org = req.potionOrg!;
    const row = await getProviderKeyById(db, org.orgId, id);
    if (!row) {
      return reply.code(404).send(openAiError(`unknown provider key '${id}'`, 'invalid_request_error'));
    }
    const audit = await listCustodyAudit(db, org.orgId, id);
    return reply.send({
      keyId: id,
      audit: audit.map((a) => ({
        id: a.id,
        actor: a.actor,
        action: a.action,
        metadata: a.metadata,
        createdAt: a.createdAt,
      })),
    });
  });

  /** Rotate the raw key material on a row (ADMIN). */
  app.post('/api/keys/:id/rotate', { preHandler: [requireRole('admin')] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = RotateKeyBodySchema.safeParse(req.body);
    if (!parsed.success) {
      const message = parsed.error.issues
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ');
      return reply.code(400).send(openAiError(message, 'invalid_request_error'));
    }
    const org = req.potionOrg!;
    const row = await getProviderKeyById(db, org.orgId, id);
    if (!row) {
      return reply.code(404).send(openAiError(`unknown provider key '${id}'`, 'invalid_request_error'));
    }
    const newHash = sha256(parsed.data.apiKey);
    if (newHash !== row.keyHash) {
      // Refuse to collide with ANOTHER row in this org (dedup invariant).
      const clash = await getProviderKeyByHash(db, org.orgId, newHash);
      if (clash && clash.id !== id) {
        return reply
          .code(409)
          .send(
            openAiError(
              `another key in this org already holds that raw key ('${clash.id}')`,
              'invalid_request_error',
              'duplicate_key',
            ),
          );
      }
    }
    const ciphertext = await ctx.custody.encryptKey(parsed.data.apiKey);
    await rotateProviderKey(db, org.orgId, id, {
      ciphertext,
      maskedKey: maskProviderKey(parsed.data.apiKey),
      keyHash: newHash,
    });
    const next = (await getProviderKeyById(db, org.orgId, id))!;
    await ctx.custody.record(org.orgId, actorOf(req), 'rotate', id, {
      provider: row.provider,
      fromKeyVersion: row.keyVersion,
      toKeyVersion: next.keyVersion,
    });
    ctx.invalidateOrgProviders(org.orgId);
    return reply.send(keyDto(next));
  });

  /** Revoke a provider key (ADMIN) — serving stops IMMEDIATELY. */
  app.post('/api/keys/:id/revoke', { preHandler: [requireRole('admin')] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const org = req.potionOrg!;
    const row = await getProviderKeyById(db, org.orgId, id);
    if (!row) {
      return reply.code(404).send(openAiError(`unknown provider key '${id}'`, 'invalid_request_error'));
    }
    if (row.status !== 'revoked') {
      await setProviderKeyStatus(db, org.orgId, id, 'revoked');
      await ctx.custody.record(org.orgId, actorOf(req), 'revoke', id, {
        provider: row.provider,
        keyVersion: row.keyVersion,
      });
      ctx.invalidateOrgProviders(org.orgId);
    }
    const next = (await getProviderKeyById(db, org.orgId, id))!;
    return reply.send(keyDto(next));
  });

  /** Validate: a real complete() probe through the provider with the
   * DECRYPTED key (ADMIN). */
  app.post('/api/keys/:id/validate', { preHandler: [requireRole('admin')] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const org = req.potionOrg!;
    const row = await getProviderKeyById(db, org.orgId, id);
    if (!row) {
      return reply.code(404).send(openAiError(`unknown provider key '${id}'`, 'invalid_request_error'));
    }
    if (row.status !== 'active' || !row.ciphertext) {
      return reply
        .code(409)
        .send(
          openAiError(
            `provider key '${id}' is ${row.status}${row.ciphertext ? '' : ' with no ciphertext (legacy masked-only row)'} — only active custodied keys can be validated`,
            'invalid_request_error',
            'key_not_validatable',
          ),
        );
    }
    const providerId = row.provider as ProviderId;
    // Mock-world honesty: with no provider factory there is no live
    // transport to probe — except the mock provider itself, which answers
    // deterministically for 'mock' keys.
    let probe;
    if (ctx.providerFactory) {
      const raw = await ctx.custody.decryptKey(row, actorOf(req));
      const providers = ctx.providerFactory({
        prices: ctx.prices,
        apiKeys: { [providerId]: raw },
        timeoutMs: 10_000,
        maxRetries: 0,
      });
      probe = providers[providerId];
    } else if (providerId === 'mock') {
      probe = ctx.providers.mock;
    } else {
      return reply
        .code(503)
        .send(
          openAiError(
            'validation unavailable in the mock provider world (no live transports) — boot with provider keys or inject a factory',
            'invalid_request_error',
            'validation_unavailable',
          ),
        );
    }
    const model = probeModel(ctx, providerId) ?? 'mock-mid';
    const t0 = Date.now();
    try {
      const res = await probe.complete({
        model,
        messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
        params: { maxTokens: 4 },
      });
      const at = new Date();
      await touchProviderKeyValidation(db, org.orgId, id, at);
      await ctx.custody.record(org.orgId, actorOf(req), 'validate', id, {
        ok: true,
        provider: providerId,
        model,
        modelVersion: res.modelVersion,
        latencyMs: Date.now() - t0,
      });
      return reply.send({
        id,
        ok: true,
        model,
        modelVersion: res.modelVersion,
        latencyMs: Date.now() - t0,
        lastValidatedAt: at,
      });
    } catch (err) {
      await ctx.custody.record(org.orgId, actorOf(req), 'validate', id, {
        ok: false,
        provider: providerId,
        model,
        error: (err as Error).message,
        latencyMs: Date.now() - t0,
      });
      return reply
        .code(502)
        .send(openAiError(`validation call failed: ${(err as Error).message}`, 'upstream_error', 'validation_failed'));
    }
  });

  // ---------- api_keys lifecycle (#15) ----------

  /** Mint a named api key (ADMIN) — the RAW key is returned exactly once. */
  app.post('/api/api-keys', { preHandler: [requireRole('admin')] }, async (req, reply) => {
    const parsed = PostApiKeyBodySchema.safeParse(req.body);
    if (!parsed.success) {
      const message = parsed.error.issues
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ');
      return reply.code(400).send(openAiError(message, 'invalid_request_error'));
    }
    const { name, scopes, env, expiresAt, policyId } = parsed.data;
    const org = req.potionOrg!;
    if (policyId) {
      const policy = await getPolicyById(db, org.orgId, policyId);
      if (!policy) {
        return reply
          .code(404)
          .send(openAiError(`unknown policy '${policyId}'`, 'invalid_request_error'));
      }
    }
    // Every serving key is bound to a rule, so the first request on a new
    // org works instead of refusing with 'no policy bound' (found by walking
    // the journey as a brand-new org, 2026-08-22). No rule given: bind the
    // org's existing one, or create the default — cheapest model that scores
    // at least 0.95 — which the dashboard lets them change later.
    let boundPolicyId = policyId;
    if (boundPolicyId === undefined) {
      // Serving policies only (2026-08-28): the Lab's internal rows (lab-io
      // at floor ZERO, dial pins) must never become a customer key's rule.
      const existing = await listServingPolicies(db, org.orgId);
      if (existing.length > 0) {
        boundPolicyId = existing[0]!.id;
      } else {
        boundPolicyId = `pol-${randomUUID().slice(0, 8)}`;
        await insertPolicy(db, {
          id: boundPolicyId,
          orgId: org.orgId,
          name: 'default',
          config: DEFAULT_ORG_POLICY,
        });
      }
    }
    const raw = `pk_${randomUUID().replace(/-/g, '')}`;
    const id = `key-${randomUUID().slice(0, 8)}`;
    await insertApiKey(db, {
      id,
      keyHash: sha256(raw),
      name,
      orgId: org.orgId,
      policyId: boundPolicyId,
      ...(scopes !== undefined ? { scopes } : {}),
      ...(env !== undefined ? { env } : {}),
      ...(expiresAt !== undefined ? { expiresAt: new Date(expiresAt) } : {}),
    });
    // Walkthrough seam (2026-08-24): the serving-key mint joins the custody
    // trail /settings/audit promises. Metadata carries ids and names only —
    // never key material.
    await insertCustodyAudit(db, {
      id: `ca-${randomUUID().slice(0, 8)}`,
      orgId: org.orgId,
      actor: org.userId ?? `api-key:${req.potionOrg?.orgId ?? 'admin'}`,
      action: 'issue',
      providerKeyId: null,
      metadata: { apiKeyId: id, name, scopes: scopes ?? 'serve', env: env ?? 'live' },
    });
    return reply.code(201).send({
      id,
      name,
      scopes: scopes ?? 'serve',
      env: env ?? 'live',
      expiresAt: expiresAt ?? null,
      policyId: boundPolicyId,
      // returned EXACTLY ONCE — only the sha256 is stored.
      apiKey: raw,
    });
  });

  /** List api keys (never the raw key — only sha256 hashes exist). */
  app.get('/api/api-keys', async (req, reply) => {
    const org = req.potionOrg!;
    const rows = await listApiKeys(db, org.orgId);
    return reply.send({
      keys: rows.map((k) => ({
        id: k.id,
        name: k.name,
        scopes: k.scopes,
        env: k.env,
        policyId: k.policyId,
        createdAt: k.createdAt,
        expiresAt: k.expiresAt,
        revokedAt: k.revokedAt,
      })),
    });
  });

  /** Revoke an api key (ADMIN) — the auth hot path 401s it immediately. */
  app.post('/api/api-keys/:id/revoke', { preHandler: [requireRole('admin')] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const org = req.potionOrg!;
    const key = await getApiKeyById(db, org.orgId, id);
    if (!key) {
      return reply.code(404).send(openAiError(`unknown api key '${id}'`, 'invalid_request_error'));
    }
    if (!key.revokedAt) {
      await revokeApiKey(db, org.orgId, id, new Date());
      await insertCustodyAudit(db, {
        id: `ca-${randomUUID().slice(0, 8)}`,
        orgId: org.orgId,
        actor: org.userId ?? 'api-key:admin',
        action: 'revoke',
        providerKeyId: null,
        metadata: { apiKeyId: id, name: key.name },
      });
    }
    const next = (await getApiKeyById(db, org.orgId, id))!;
    return reply.send({ id: next.id, revokedAt: next.revokedAt });
  });
  /**
   * PUT /api/api-keys/:id/limits — the per-key throughput ceiling (admin).
   *
   * rate_rps has been a column since 0006 and was set at creation and never
   * again, so raising a partner's limit meant an UPDATE typed against the
   * production database. That is not an operation, it is an incident waiting
   * for a typo, and it leaves nothing in the custody audit.
   *
   * Bounds exist because these numbers are a promise the box has to keep:
   * the limiter is a token bucket whose capacity IS the rps, so a large
   * value is also the burst a single key may fire at once. `null` restores
   * the platform default rather than meaning zero — the columns are
   * nullable for exactly that reason, and a rate limit of 0 would silently
   * lock a customer out of their own API.
   */

  app.put('/api/api-keys/:id/limits', { preHandler: [requireRole('admin')] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const org = req.potionOrg!;
    const Body = z
      .object({
        rateRps: z.number().int().min(1).max(1000).nullable().optional(),
        dailyCap: z.number().int().min(1).max(50_000_000).nullable().optional(),
        maxBodyKb: z.number().int().min(1).max(1024).nullable().optional(),
      })
      .strict();
    const parsed = Body.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send(openAiError(parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; '), 'invalid_request_error'));
    }
    const key = await getApiKeyById(db, org.orgId, id);
    if (!key) return reply.code(404).send(openAiError(`unknown api key '${id}'`, 'invalid_request_error'));
    if (key.revokedAt) {
      return reply
        .code(409)
        .send(openAiError(`api key '${id}' is revoked — mint a new one rather than raising a dead key`, 'invalid_request_error'));
    }
    await updateApiKeyLimits(db, org.orgId, id, parsed.data);
    // NOT AUDITED YET, deliberately. A throughput change is the same class of
    // fact as a rotate or a revoke and belongs in custody_audit — but
    // `custody_audit_action_check` (0005) is a DB CHECK constraint listing the
    // permitted actions, so recording it is a migration, not a type widening.
    // Writing an unpermitted action fails the insert and 500s the request, so
    // the choice is a migration or no audit row; a migration does not belong
    // inside an unrelated fix. Follow-up: widen the constraint, then record.
    const next = (await getApiKeyById(db, org.orgId, id))!;
    return reply.send({
      id: next.id,
      // NULL is reported as null, not as the default it resolves to: the
      // caller asked what is SET on this key, and "unset, so the platform
      // default applies" is a different fact from "pinned to 10".
      rateRps: next.rateRps ?? null,
      dailyCap: next.dailyCap ?? null,
      maxBodyKb: next.maxBodyKb ?? null,
    });
  });
}
