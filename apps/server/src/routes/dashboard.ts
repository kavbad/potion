// Dashboard API (SPEC §8) — the routes apps/dashboard (and this repo's demo)
// consume. Local-tool surface: no bearer requirement; where a "customer" is
// needed (operating point) a valid Bearer token wins, otherwise the first
// api key with a bound policy is used.
//
// NOTE (M2 Wave 2, ROADMAP #15/#16): the provider-key routes (POST/GET
// /api/keys) MOVED to routes/keys.ts — custody is real now (envelope
// encryption + serving), and the lifecycle (rotate/revoke/validate/audit)
// lives there. maskProviderKey moved with them.
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  sha256,
  PolicySchema,
  fastestQualityQualifyingPoint,
  selectPoint,
  type Policy,
} from '@potion/core';
import {
  DEFAULT_ORG_ID,
  getApiKeyById,
  getFirstApiKeyWithPolicy,
  getPolicyById,
  insertApiKey,
  insertPolicy,
  listClusters,
  updateApiKeyPolicy,
  getClusterByIdForOrg,
  type OrgContext,
  type PotionDb,
} from '@potion/db';
import { loadTaxonomy } from '@potion/cluster';
import { loadCurrentFrontier } from '@potion/pareto';
import { isDominated } from '@potion/pareto';
import {
  roleAtLeast, authenticate, bearerToken, openAiError } from '../auth.js';
import type { PotionContext } from '../context.js';
import { highestQualityPoint } from './chat.js';
import { bindServingLatency, policyHasLatencyDimension } from '../latency-policy.js';

// ---------- POST /api/workloads ----------

/** Extract prompt strings from a JSONL string / {prompts:[…]} / {jsonl:"…"} /
 * plain JSON array body. Each JSONL line is a JSON string or {"prompt": …};
 * an unparseable non-empty line is taken verbatim. */
export function extractPrompts(body: unknown): string[] {
  if (Array.isArray(body)) return body.filter((x): x is string => typeof x === 'string');
  if (typeof body === 'string') return parseJsonl(body);
  if (body && typeof body === 'object') {
    const rec = body as Record<string, unknown>;
    if (Array.isArray(rec.prompts)) {
      return rec.prompts.filter((x): x is string => typeof x === 'string');
    }
    if (typeof rec.jsonl === 'string') return parseJsonl(rec.jsonl);
  }
  return [];
}

function parseJsonl(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed === 'string') out.push(parsed);
      else if (
        parsed &&
        typeof parsed === 'object' &&
        typeof (parsed as Record<string, unknown>).prompt === 'string'
      ) {
        out.push((parsed as Record<string, unknown>).prompt as string);
      }
    } catch {
      out.push(trimmed); // lenient: raw line is the prompt
    }
  }
  return out;
}

// ---------- GET /api/endpoint-snippet ----------

const POLICY_DEFAULTS: Record<Policy['type'], Policy> = {
  max_quality: { type: 'max_quality', costCeilingPer1K: 1.0 },
  min_cost: { type: 'min_cost', qualityFloor: 0.8 },
  latency_bound: { type: 'latency_bound', p95Ms: 1000 },
  // G2.6: the two existing single-constraint defaults, stated together.
  compound: { type: 'compound', qualityFloor: 0.8, p95Ms: 1000 },
};

/** Parse the ?policy= query: a JSON-encoded Policy, or a bare type name
 * (defaults applied). null when unparseable. */
export function parsePolicyQuery(raw: string | undefined): Policy | null {
  if (!raw) return null;
  let candidate: unknown = raw;
  try {
    candidate = JSON.parse(raw);
  } catch {
    candidate = { type: raw };
  }
  if (
    candidate &&
    typeof candidate === 'object' &&
    Object.keys(candidate as Record<string, unknown>).length === 1 &&
    typeof (candidate as Record<string, unknown>).type === 'string'
  ) {
    const dflt = POLICY_DEFAULTS[(candidate as { type: Policy['type'] }).type];
    if (dflt) candidate = dflt;
  }
  const parsed = PolicySchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

export function buildEndpointSnippets(baseUrl: string, policy: Policy): {
  url: string;
  curl: string;
  openaiNode: string;
} {
  const url = `${baseUrl}/v1/chat/completions`;
  // The platform routes by PROMPT (cluster) + server-side policy, so the
  // client sends any model label; 'potion-auto' is the documented convention.
  const payload = JSON.stringify({
    model: 'potion-auto',
    messages: [{ role: 'user', content: 'Write a python function that reverses a string' }],
  });
  const curl =
    `# policy: ${JSON.stringify(policy)} (bind it to your key first:\n` +
    `#   curl -X POST ${baseUrl}/v1/policies -H "Authorization: Bearer $POTION_API_KEY" \\\n` +
    `#     -H "Content-Type: application/json" -d '${JSON.stringify(policy)}')\n` +
    `curl ${url} \\\n` +
    `  -H "Authorization: Bearer $POTION_API_KEY" \\\n` +
    `  -H "Content-Type: application/json" \\\n` +
    `  -d '${payload}'`;
  const openaiNode =
    `import OpenAI from 'openai';\n\n` +
    `// Potion speaks the OpenAI chat.completions protocol; routing + policy\n` +
    `// happen server-side. Policy in effect: ${JSON.stringify(policy)}\n` +
    `const client = new OpenAI({\n` +
    `  baseURL: '${baseUrl}/v1',\n` +
    `  apiKey: process.env.POTION_API_KEY, // your pk_... key\n` +
    `});\n\n` +
    `const res = await client.chat.completions.create({\n` +
    `  model: 'potion-auto', // any label; Potion routes by prompt + policy\n` +
    `  messages: [{ role: 'user', content: 'Write a python function that reverses a string' }],\n` +
    `});\n` +
    `console.log(res.choices[0].message.content);`;
  return { url, curl, openaiNode };
}

function baseUrlOf(req: FastifyRequest): string {
  const proto = req.protocol || 'http';
  const host = req.headers.host ?? 'localhost:3000';
  return `${proto}://${host}`;
}

/**
 * Tenant resolution for the dashboard surface — M2 Wave 2 (ROADMAP #14):
 * the dashboard auth hook (server.ts) resolves every /api/* request BEFORE
 * the handler runs (Bearer api key → session cookie/bearer → dev bypass →
 * 401) and attaches the OrgContext as req.potionOrg. Handlers MUST use it —
 * there is no unauthenticated path anymore (the bypass resolves to the
 * default org with role 'admin' when enabled; see auth.ts header).
 *
 * RBAC mapping (enforced by the hook + requireRole; role from OrgContext):
 *   GET    /api/frontiers, /api/frontiers/:id, /api/keys, /api/endpoint-snippet → viewer+
 *   POST   /api/keys, /api/policies, /api/workloads                            → member+
 *   POST   /auth/invite (+ key revoke/rotate, Wave-2 #15)                      → admin
 *
 * @deprecated kept for source compatibility — the hook has already resolved
 * the org by the time handlers run; use req.potionOrg.
 */
export async function resolveDashboardOrg(
  db: PotionDb,
  authorization: string | undefined,
): Promise<OrgContext> {
  const auth = await authenticate(db, bearerToken(authorization));
  return auth?.org ?? { orgId: DEFAULT_ORG_ID, role: 'admin' };
}

// ---------- routes ----------

export function registerDashboardRoutes(app: FastifyInstance, ctx: PotionContext): void {
  const db = ctx.db.db;

  /** List clusters that have a CURRENT frontier (the dashboard's cluster
   * selector). Enumerates the taxonomy; clusters without a frontier yet are
   * omitted rather than 404-ing the selector one click at a time. Each entry
   * carries a provenance summary (M1a): how many points are live evidence vs
   * simulated (provider_mode 'mock'/'unknown').
   * G1.6: reads are org-PREFERRED with platform fallback — the caller sees
   * their own agent frontiers plus the shared platform ones; other tenants'
   * clusters were already invisible via the org-filtered cluster list. */
  app.get('/api/frontiers', async (req, reply) => {
    const taxonomy = loadTaxonomy();
    const clusters: Array<{
      clusterId: string;
      frontierId: string;
      version: number;
      pointCount: number;
      createdAt: string;
      provenance: { live: number; simulated: number };
    }> = [];
    const seen = new Set<string>();
    const pushIfFrontier = async (clusterId: string): Promise<void> => {
      if (seen.has(clusterId)) return;
      seen.add(clusterId);
      // G1.6: org-preferred read — the caller sees THEIR frontier where one
      // exists, platform elsewhere (the cluster list is already org-filtered).
      const frontier = await loadCurrentFrontier(db, clusterId, req.potionOrg!.orgId);
      if (frontier) {
        clusters.push({
          clusterId: frontier.clusterId,
          frontierId: frontier.id,
          version: frontier.version,
          pointCount: frontier.points.length,
          createdAt: frontier.createdAt,
          provenance: {
            live: frontier.points.filter((p) => p.providerMode === 'live').length,
            simulated: frontier.points.filter((p) => p.providerMode !== 'live').length,
          },
        });
      }
    };
    for (const c of taxonomy.clusters) await pushIfFrontier(c.id);
    // M5 #36: db-registered clusters (agent-* from traces:cluster) are NOT
    // in the static taxonomy — merge them so agent frontiers list too.
    // G1.2: scoped — platform clusters (org_id NULL) + the caller's OWN;
    // other tenants' agent clusters are invisible.
    for (const c of await listClusters(db, { orgId: req.potionOrg!.orgId })) {
      await pushIfFrontier(c.id);
    }
    return reply.send({ clusters });
  });

  /** JSONL workload upload → cluster breakdown via assignBatch.
   * Cluster assignment is shared-global by design (ROADMAP #13) — the
   * taxonomy + centroids are platform assets; nothing tenant-scoped is read
   * or written here. */
  app.post('/api/workloads', async (req, reply) => {
    const prompts = extractPrompts(req.body);
    if (prompts.length === 0) {
      return reply
        .code(400)
        .send(
          openAiError(
            'no prompts found — send a JSONL body (one prompt per line), {"prompts": [...]}, or {"jsonl": "..."}',
            'invalid_request_error',
          ),
        );
    }
    const assignments = await ctx.assigner.assignBatch(prompts);
    const breakdown: Record<string, number> = {};
    let confidenceSum = 0;
    for (const a of assignments) {
      breakdown[a.clusterId] = (breakdown[a.clusterId] ?? 0) + 1;
      confidenceSum += a.confidence;
    }
    return reply.send({
      total: prompts.length,
      breakdown,
      avgConfidence: Math.round((confidenceSum / prompts.length) * 1000) / 1000,
      assignments: assignments.map((a, i) => ({
        index: i,
        prompt: prompts[i] ?? '',
        clusterId: a.clusterId,
        confidence: Math.round(a.confidence * 1000) / 1000,
      })),
    });
  });

  /** Current frontier for a cluster (points incl. strategy configs, each
   * marked dominated=false — frontier points are non-dominated by
   * construction and we verify it), plus the customer's current operating
   * point when a policy exists. */
  /** G1.7: launch a live capped eval sweep of one of the caller's agent
   * clusters (admin). The job re-verifies ownership, env gate, and the
   * org's hard-stop budget FAIL-CLOSED before any spend; spend is metered
   * as request_logs 'eval_live' (customer-attributable). */
  app.post('/api/frontiers/live-sweep', async (req, reply) => {
    const org = req.potionOrg!;
    if (org.role !== 'admin') {
      return reply
        .code(403)
        .send(
          openAiError(
            `role '${org.role}' may not launch live sweeps — requires 'admin'`,
            'invalid_request_error',
            'insufficient_role',
          ),
        );
    }
    const body = z
      .object({
        clusterId: z.string().min(1),
        capUsd: z.number().positive().max(50).optional(),
        judgeMaxTokens: z.number().int().positive().max(4096).optional(),
        maxOutputTokens: z.number().int().positive().max(8192).optional(),
      })
      .safeParse(req.body ?? {});
    if (!body.success) {
      return reply.code(400).send({
        error: 'invalid_body',
        message: body.error.issues.map((i) => i.message).join('; '),
      });
    }
    // Ownership: unknown and unowned cluster ids get the SAME 404.
    const cluster = await getClusterByIdForOrg(db, body.data.clusterId, org.orgId);
    if (!cluster || cluster.orgId === null) {
      return reply
        .code(404)
        .send(openAiError('cluster not found', 'invalid_request_error', 'cluster_not_found'));
    }
    if (!ctx.queue) {
      return reply
        .code(503)
        .send(openAiError('job queue unavailable', 'server_error', 'queue_unavailable'));
    }
    const jobId = await ctx.queue.enqueue('frontier:live-sweep', {
      orgId: org.orgId,
      clusterId: body.data.clusterId,
      ...(body.data.capUsd !== undefined ? { capUsd: body.data.capUsd } : {}),
      ...(body.data.judgeMaxTokens !== undefined ? { judgeMaxTokens: body.data.judgeMaxTokens } : {}),
      ...(body.data.maxOutputTokens !== undefined ? { maxOutputTokens: body.data.maxOutputTokens } : {}),
    });
    return reply.code(202).send({ jobId });
  });

  app.get('/api/frontiers/:clusterId', async (req, reply) => {
    const { clusterId } = req.params as { clusterId: string };
    // G1.6: ownership FIRST — another org's agent-cluster id gets the SAME
    // 404 as a nonexistent one (pre-G1.6 a guessed agent-<hash>-<sig> id
    // returned another tenant's points). Then the org-preferred read.
    const cluster = await getClusterByIdForOrg(db, clusterId, req.potionOrg!.orgId);
    const isKnownTaxonomy = loadTaxonomy().clusters.some((t) => t.id === clusterId);
    if (!cluster && !isKnownTaxonomy) {
      return reply
        .code(404)
        .send(openAiError(`no frontier for cluster '${clusterId}'`, 'invalid_request_error'));
    }
    const frontier = await loadCurrentFrontier(db, clusterId, req.potionOrg!.orgId);
    if (!frontier) {
      return reply
        .code(404)
        .send(openAiError(`no frontier for cluster '${clusterId}'`, 'invalid_request_error'));
    }

    // ---- the customer's operating point: an api-key caller with a bound
    // policy uses it; session/dev callers fall back to their org's first key
    // with a bound policy (org resolved by the dashboard auth hook, #14) ----
    let policy: Policy | null = null;
    const auth = req.potionAuth;
    const orgId = req.potionOrg!.orgId;
    if (auth?.kind === 'apiKey' && auth.policy) {
      policy = auth.policy;
    } else {
      const key = await getFirstApiKeyWithPolicy(db, orgId);
      if (key?.policyId) {
        const row = await getPolicyById(db, orgId, key.policyId);
        policy = row?.config ?? null;
      }
    }

    let operatingPoint: unknown = null;
    if (policy && frontier.points.length > 0) {
      // G2.6: the DTO runs the SAME serving-grade latency binding the serving
      // path runs, so the number a developer reads here is the number their
      // requests are actually evaluated against. A DTO computed off harness
      // latency while serving binds against measured latency would be a
      // dashboard that quietly disagrees with production.
      const latency = await bindServingLatency(
        ctx,
        policy,
        frontier,
        orgId,
        frontier.clusterId,
        (msg) => app.log.warn(msg),
      );
      const bound = latency.frontier ?? frontier;
      const selected = selectPoint(policy, bound);
      const violated =
        selected === null && policy.type === 'compound'
          ? fastestQualityQualifyingPoint(bound.points, policy.qualityFloor)
          : null;
      const point = selected ?? violated ?? highestQualityPoint(bound.points);
      if (point) {
        operatingPoint = {
          strategyHash: point.strategyHash,
          strategyConfig: point.strategyConfig,
          quality: point.quality,
          costPer1K: point.costPer1K,
          latencyP95: point.latencyP95,
          policy,
          fallback: selected ? 0 : 1,
          // Which clock, over what n, on which span — the provenance parity
          // the owner asked for: a latency-driven selection is as auditable
          // as a quality-driven one.
          latencyEvidence: latency.evidence[point.strategyHash] ?? null,
          // What the bound is costing at this quality floor, and what
          // relaxing it would unlock. Present for every latency-dimensioned
          // policy so 'binding: none' is itself informative.
          latencyPremium: policyHasLatencyDimension(policy) ? latency.premium : null,
          latencyViolation: violated
            ? {
                boundMs: (policy as { p95Ms: number }).p95Ms,
                qualityFloor: (policy as { qualityFloor: number }).qualityFloor,
                servedP95Ms: violated.latencyP95,
                servedStrategyHash: violated.strategyHash,
                relaxLatencyToMs: latency.premium.relaxLatencyToMs,
                relaxQualityToFloor: latency.premium.relaxQualityToFloor,
              }
            : null,
        };
      }
    }

    return reply.send({
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
          // G1.6 (owner rule): the AUTHED surface carries each point's
          // evidence links — this is the guarantee report's raw material.
          // Public DTOs (share/leaderboard) deliberately omit it.
          evidence: p.evidence ?? null,
          // Provenance per point (M1a): absence surfaces as explicit 'unknown'
          // so the dashboard can badge it SIMULATED.
          providerMode: p.providerMode ?? 'unknown',
          // Frontier points are non-dominated by construction; verified here.
          dominated: isDominated(p, frontier.points) !== null,
        })),
      },
      operatingPoint,
    });
  });

  /** Create a policy via the dashboard; optionally bind it to an api key. */
  app.post('/api/policies', async (req, reply) => {
    const BodySchema = z.object({
      policy: PolicySchema,
      name: z.string().min(1).max(200).optional(),
      keyId: z.string().min(1).optional(),
      /** Convenience: create a NEW api key with this policy bound. Returns
       * the raw key exactly once. */
      createKey: z.boolean().optional(),
    });
    const parsed = BodySchema.safeParse(req.body);
    if (!parsed.success) {
      const message = parsed.error.issues
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ');
      return reply.code(400).send(openAiError(message, 'invalid_request_error'));
    }
    const { policy, name, keyId, createKey } = parsed.data;
    const org = req.potionOrg!; // resolved by the dashboard auth hook (#14)
    // G2.3: key lifecycle is the ADMIN domain (parity with POST
    // /api/api-keys). Plain policy creation stays member+; minting a new
    // key or rebinding an existing one requires admin — a serve-scoped
    // api key (role 'member' since the role split) is refused here.
    if ((createKey || keyId !== undefined) && !roleAtLeast(org.role, 'admin')) {
      return reply
        .code(403)
        .send(
          openAiError(
            `role '${org.role}' may not mint or rebind api keys — requires 'admin' (plain policy creation without createKey/keyId is allowed)`,
            'invalid_request_error',
            'insufficient_role',
          ),
        );
    }
    const id = `pol-${randomUUID().slice(0, 8)}`;
    const policyName = name ?? `${policy.type}-${id.slice(4)}`;
    // Tenant scope (M2 #13): the policy row lives in the resolved org.
    await insertPolicy(db, { id, orgId: org.orgId, name: policyName, config: policy });

    let boundKeyId: string | null = null;
    let rawKey: string | undefined;
    if (keyId) {
      // Org-scoped lookup: a key id from ANOTHER org 404s (isolation).
      const key = await getApiKeyById(db, org.orgId, keyId);
      if (!key) {
        return reply
          .code(404)
          .send(openAiError(`unknown api key '${keyId}'`, 'invalid_request_error'));
      }
      await updateApiKeyPolicy(db, org.orgId, keyId, id);
      boundKeyId = keyId;
    } else if (createKey) {
      rawKey = `pk_${randomUUID().replace(/-/g, '')}`;
      boundKeyId = `key-${randomUUID().slice(0, 8)}`;
      await insertApiKey(db, {
        id: boundKeyId,
        keyHash: sha256(rawKey),
        name: policyName,
        orgId: org.orgId,
        policyId: id,
      });
    }

    return reply.code(201).send({
      policy: { id, name: policyName, config: policy },
      boundKeyId,
      ...(rawKey !== undefined ? { apiKey: rawKey } : {}),
    });
  });

  /** curl + openai-node snippets for the chat endpoint under a policy. */
  app.get('/api/endpoint-snippet', async (req, reply) => {
    const { policy: raw } = req.query as { policy?: string };
    const policy = parsePolicyQuery(raw);
    if (!policy) {
      return reply
        .code(400)
        .send(
          openAiError(
            'invalid ?policy= — pass a JSON-encoded Policy or one of: max_quality, min_cost, latency_bound',
            'invalid_request_error',
          ),
        );
    }
    return reply.send({ policy, ...buildEndpointSnippets(baseUrlOf(req), policy) });
  });
}
