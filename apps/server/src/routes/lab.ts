// Lab routes (Step 8, docs/specs/step-08-novice-loop.md — the binding table).
//
//   POST   /api/lab/harnesses            member — interview answers → generateSpec
//                                        (Step 6) → persisted spec+sidecar in the
//                                        0037 catalog, or draft/refusal passthrough
//   GET    /api/lab/harnesses            viewer — list org harnesses
//   GET    /api/lab/harnesses/:hash      viewer — spec + sidecar + dial views (Step 7)
//   POST   /api/lab/harnesses/:hash/dial admin  — apply a dial position (motion +
//                                        materialize; the moved spec is a NEW
//                                        catalog row — specs are content-addressed)
//   POST   /api/lab/harnesses/:hash/felt member — felt sweep (cap-bound; cached)
//   POST   /api/lab/runs                 member — start a trial run (enqueue lab:run)
//   GET    /api/lab/runs/:id             viewer — run + steps — narration/ticker read
//   POST   /api/lab/runs/:id/answer      member — check-in reply → answerLabRun → re-enqueue
//   POST   /api/lab/runs/:id/kill        admin  — operator stop
//   GET    /api/lab/runs/:id/report      viewer — run report v1
//   GET    /api/lab/memory/:hash         viewer — memory entries, plain-language view
//   PUT    /api/lab/memory/:hash/:key    member — edit an entry
//   DELETE /api/lab/memory/:hash/:key    admin  — delete an entry (permanent)
//
// Step 10 — connectors + token custody (docs/specs/step-10-mcp-custody.md):
//   GET    /api/lab/connectors                     viewer — catalog + grant STATUSES
//                                                  (token material structurally absent:
//                                                  the repo never selects envelopes)
//   POST   /api/lab/connectors/:id/oauth/start     admin  — PKCE + org-bound HMAC state
//   GET    /api/lab/connectors/:id/oauth/callback  admin  — code exchange server-side;
//                                                  seal + store; token plaintext exists
//                                                  ONLY in that handler's stack frame
//   POST   /api/lab/connectors/:id/revoke          admin  — typed cut + best-effort
//                                                  provider revocation (worker job)
//
// Tenancy: every read/write is org-scoped through the session org; cross-org
// ids get the SAME 404 as nonexistent ones (no existence oracle). Mock/live
// separation: run, felt, and report surfaces carry the provenance the trace
// REPORTED — anything not live-evidenced is labeled simulated, never live.
//
// Serving custody: generation and felt calls ride the REAL serving path
// in-process (fastify inject as the ServingClient's fetchFn — metering,
// budget, policy pins and trace headers all apply) under an EPHEMERAL
// route-scoped serve key: raw held only inside the request, hash stored via
// the existing key machinery, revoked in finally. Same custody story as the
// lab:run worker's run-scoped keys.
import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireRole } from '../auth.js';
import { sha256, type Frontier } from '@potion/core';
import {
  createLabRun,
  deleteLabMemoryKey,
  getLabHarness,
  getLabRun,
  insertApiKey,
  insertPolicy,
  getPolicyById,
  listLabHarnesses,
  listWaitingLabRuns,
  listLabMemoryEntries,
  listLabRunsForHarness,
  listLabRunChildren,
  addLabRunSteer,
  STEER_LIMITS,
  listLabSteps,
  revokeApiKey,
  setLabMemoryKey,
  upsertLabHarness,
  listLabRunFiles,
  upsertLabRunFile,
  listRecentLabRuns,
  getLabRunFile,
  armLabMission,
  getLabMission,
  findArmedMissionByHookHash,
  insertShareToken,
  pauseLabMission,
  type LabMissionRow,
  answerLabRun,
  killLabRun,
} from '@potion/db';
import { canonicalJson } from '@potion/core';
import { loadCurrentFrontier } from '@potion/pareto';
import {
  fuelFromWorth,
  generateSpec,
  TAXONOMY_CLUSTERS,
  type ChoicesSidecar,
  type InterviewAnswers,
  type TaxonomyCluster,
} from '@potion/lab-gen';
import { scanRawValue, harnessSpecHash } from '@potion/lab-spec';
import {
  acceptGraduation,
  getActionGrant,
  ensureActionGrant,
  ensureHarnessFamily,
  inheritGrantState,
  insertDescendantHarness,
  latestCompletedLabRun,
  latestShadowLabRun,
  listActionGrants,
  listEvidenceReports,
  listFamilyGenerations,
  markSuperseded,
  tightenGrant,
  listLabStepsForHarness,
} from '@potion/db';
import { narrateStep } from '@potion/lab-form';
import { buildDescendantSpec, constitutionTierOverrides, deriveImprovements, evidenceFromReports, extractDeliverable, extractPoreEvidence, extractReport, inheritGrantPlan, mergeEvidence, runGraduationPass, type ImprovementProposal } from '@potion/lab-runtime';
import {
  applyDialPosition,
  dialViews,
  domainFromContext,
  feltSampleCache,
  feltSweep,
  loadDialContext,
  materializeDialPolicy,
  missionProbe,
  requestLogCostLookup,
  viewPosition,
  FELT_SWEEP_MAX_POSITIONS,
  type DialDomain,
  type DialView,
  type FeltPositionRequest,
} from '@potion/lab-dial';
import { parseHarnessSpecText, type HarnessSpec } from '@potion/lab-spec';
import { ServingClient, buildRunReport, getLiveOutput, planFromSteps, replayRun, type StepPayload } from '@potion/lab-runtime';
import {
  getLabGrant,
  grantConnectionStatus,
  listLabGrants,
  markLabGrantStatus,
  upsertLabGrant,
  listLabCustomConnectors,
  upsertLabCustomConnector,
  deleteLabCustomConnector,
  getLabCustomConnector,
} from '@potion/db';
import { withEndpointOverrides, type ConnectorDef } from '@potion/lab-mcp';
import {
  CATALOG,
  contextTokens,
  fixtureAgeDays,
  getPackage,
  packageContentHash,
  toConnectorDef,
} from '@potion/lab-superpowers';
import {
  CONNECTOR_STATE_COOKIE,
  CONNECTOR_STATE_TTL_MS,
  ConnectorOauthError,
  decodeConnectorState,
  encodeConnectorState,
  newConnectorFlowState,
  pkceChallengeS256,
} from '../connector-oauth.js';
import type { PotionQueue } from '@potion/queue';
import { openAiError, parseCookies, roleAtLeast } from '../auth.js';
import { publicBaseUrl } from '../public-url.js';
import { CUSTOM_SLUG_RE, probeMcpEndpoint, type ProbeDeps } from '../custom-mcp.js';
import { SHARE_TOKEN_PREFIX } from './share.js';
import { actorOf } from './keys.js';
import { missionWindow, startEventCheck } from '../lab-scheduler.js';
import type { PotionContext } from '../context.js';

export interface LabRoutesOptions {
  queue: PotionQueue;
  /** BYO-MCP probe deps (tests inject a scripted server + DNS). */
  probeDeps?: ProbeDeps;
}

const notFound = openAiError('not found', 'invalid_request_error', 'lab_not_found');

/** Mission DTO — armed state + the next due instant (derived, never stored). */
function missionDto(m: LabMissionRow | null): {
  state: 'armed' | 'paused';
  cadenceCron: string;
  lastWindowKey: string | null;
  lastNote: string | null;
  nextDueAt: string | null;
  hasHook: boolean;
  feeds: Array<{ url: string; lastCheckedAt: string | null; lastFiredAt: string | null }>;
} | null {
  if (m === null) return null;
  const w = missionWindow(m.cadenceCron, new Date());
  let nextDueAt: string | null = null;
  if (w !== null) {
    // The next boundary after now: current window's due if still ahead,
    // else the following period.
    const period = m.cadenceCron === '0 * * * *' ? 3_600_000 : m.cadenceCron === '0 9 * * *' ? 86_400_000 : 7 * 86_400_000;
    nextDueAt = (w.dueAt > new Date() ? w.dueAt : new Date(w.dueAt.getTime() + period)).toISOString();
  }
  // P5: the event-trigger posture — hook armed (never the token; that was
  // shown once) and each watched feed's observation stamps.
  const feedState = (m.feedState ?? {}) as Record<string, { checkedAt?: string; firedAt?: string }>;
  const feeds = Object.entries(feedState)
    .map(([url, st]) => ({ url, lastCheckedAt: st.checkedAt ?? null, lastFiredAt: st.firedAt ?? null }))
    .sort((a, b) => (a.url < b.url ? -1 : 1));
  return { state: m.state, cadenceCron: m.cadenceCron, lastWindowKey: m.lastWindowKey, lastNote: m.lastNote, nextDueAt, hasHook: m.hookTokenHash !== null, feeds };
}

function forbidden(role: string, action: string) {
  return openAiError(
    `role '${role}' may not ${action} — requires 'admin'`,
    'invalid_request_error',
    'insufficient_role',
  );
}

function memberForbidden(role: string, action: string) {
  return openAiError(
    `role '${role}' may not ${action} — requires 'member'`,
    'invalid_request_error',
    'insufficient_role',
  );
}

/** Content hashes are 64 hex chars; anything else is refused as not-found
 * (uniform with a foreign or unknown hash — no format oracle either). */
const HASH_RE = /^[0-9a-f]{64}$/;
/** Run ids are runtime-minted `run-<8 hex>` (or walkthrough-named). */
const RUN_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** Memory keys as the loop's projection writes them. */
const MEMORY_KEY_RE = /^[A-Za-z0-9._-]{1,128}$/;

const ANSWERS_SCHEMA = z
  .object({
    goal: z.string().min(1).max(4000),
    kind: z.enum(['task', 'standing']),
    doneDefinition: z.string().min(1).max(2000).optional(),
    accounts: z.array(z.string().min(1).max(200)).max(20),
    worthUsd: z.number(),
    constraints: z.array(z.string().min(1).max(500)).max(20).optional(),
    /** Answer to a cluster-uncertain draft — enum-bound, authoritative. */
    clusterChoice: z.enum(TAXONOMY_CLUSTERS).optional(),
    /** Recipe card (2026-08-27): each optional field is one consideration
     * a good agent-builder weighs; each lands in a real spec slot in
     * lab-gen (never decoration, never invented when absent). */
    qualityBar: z.string().min(1).max(500).optional(),
    produces: z.string().min(1).max(500).optional(),
    exampleResult: z.string().min(1).max(2000).optional(),
    whenUnsure: z.enum(['ask-first', 'press-on']).optional(),
    cadence: z.enum(['hourly', 'daily', 'weekly']).optional(),
    /** P5: the standing shape + a page to watch (feed-change trigger). */
    shape: z.enum(['watchdog']).optional(),
    /** X4: may split big work across helpers (1-5), each under a budget slice. */
    helpers: z.number().int().min(1).max(5).optional(),
    watchUrl: z
      .string()
      .max(500)
      .refine((u) => /^https:\/\//.test(u), 'watchUrl must be https')
      .optional(),
  })
  .strict();

/** provenance= token of an x-frontier-trace; absent → 'unknown'. */
function traceProvenance(trace: string | undefined): string {
  const m = /(?:^|;)provenance=([^;]*)/.exec(trace ?? '');
  return m?.[1] !== undefined && m[1] !== '' ? m[1] : 'unknown';
}

/** Superpower connection status union — the four typed places a filament
 * can be (Step 9's structural severance + Step 10's healed/hollow/cut). */
export type SuperpowerStatus = 'not-connected' | 'connected' | 'expired' | 'revoked';

/** P-1: sum over model steps of the best-scorer per-request price for the
 * step's own recorded cluster. Cached per cluster within the call. Honest
 * nulls: steps without a parsable cluster or a live frontier contribute
 * nothing, and if NOTHING was priceable the whole figure is null. */
async function premiumCounterfactualUsd(
  db: PotionContext['db']['db'],
  orgId: string,
  steps: Array<{ kind: string; payload: unknown }>,
): Promise<number | null> {
  const bestByCluster = new Map<string, number | null>();
  let total = 0;
  let priced = 0;
  for (const s of steps) {
    if (s.kind !== 'model') continue;
    const trace = (s.payload as { frontierTrace?: string }).frontierTrace ?? '';
    const m = /(?:^|;)cluster=([^;]*)/.exec(trace);
    const clusterId = m?.[1];
    if (clusterId === undefined || clusterId === '') continue;
    if (!bestByCluster.has(clusterId)) {
      const fr = await loadCurrentFrontier(db, clusterId, orgId).catch(() => null);
      const bestPoint = fr?.points.reduce<{ q: number; c: number } | null>(
        (acc, p) => (acc === null || p.quality > acc.q ? { q: p.quality, c: p.costPer1K } : acc),
        null,
      ) ?? null;
      bestByCluster.set(clusterId, bestPoint === null ? null : bestPoint.c);
    }
    const per1K = bestByCluster.get(clusterId) ?? null;
    if (per1K === null) continue;
    total += per1K / 1000;
    priced += 1;
  }
  return priced > 0 ? total : null;
}

export function registerLabRoutes(
  app: FastifyInstance,
  ctx: PotionContext,
  opts: LabRoutesOptions,
): void {
  const db = ctx.db.db;

  // ---- in-process serving transport (full serving path, no socket) ----
  const injectFetch: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headers[k] = v;
    });
    const res = await app.inject({
      method: (init?.method ?? 'GET') as 'GET' | 'POST',
      url,
      headers,
      ...(init?.body !== undefined ? { payload: init.body as string } : {}),
    });
    const outHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(res.headers)) {
      if (v !== undefined) outHeaders[k] = Array.isArray(v) ? v.join(', ') : String(v);
    }
    return new Response(res.rawPayload, { status: res.statusCode, headers: outHeaders });
  };

  /** The org's lab I/O policy row (the ephemeral keys' policyId anchor —
   * per-call routing rides X-Potion-Policy pins, not this row). */
  async function ensureLabIoPolicy(orgId: string): Promise<string> {
    const id = `pol-lab-io-${orgId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 24)}`;
    const existing = await getPolicyById(db, orgId, id);
    if (existing === null) {
      await insertPolicy(db, {
        id,
        orgId,
        name: 'lab-io',
        config: { type: 'min_cost', qualityFloor: 0 },
      });
    }
    return id;
  }

  /** Mint an ephemeral serve key, run `fn` with the raw, revoke in finally. */
  async function withEphemeralKey<T>(
    orgId: string,
    fn: (rawKey: string) => Promise<T>,
  ): Promise<T> {
    const policyId = await ensureLabIoPolicy(orgId);
    const suffix = randomUUID().replace(/-/g, '').slice(0, 10);
    const rawKey = `pk_labio_${suffix}${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const keyId = `key-labio-${suffix}`;
    await insertApiKey(db, {
      id: keyId,
      keyHash: sha256(rawKey),
      name: `lab-io-${suffix}`,
      orgId,
      policyId,
      rateRps: 50,
      dailyCap: 10_000,
      // Hard expiry (review finding): unlike the lab:run keys, no sweep ever
      // matches `lab-io-%`, so a crash between mint and the finally — or a
      // swallowed revoke failure — would otherwise leave a live credential
      // row forever. Auth rejects expired keys, so the orphan self-destructs.
      expiresAt: new Date(Date.now() + 15 * 60_000),
    });
    try {
      return await fn(rawKey);
    } finally {
      await revokeApiKey(db, orgId, keyId, new Date()).catch(() => {});
    }
  }

  /** Step 10: the four-state posture derived from the grants table via the
   * ONE derivation (grantConnectionStatus). Token material cannot appear
   * here — the repo's projection excludes the envelope columns entirely. */
  async function superpowerPosture(
    orgId: string,
    spec: HarnessSpec | null,
  ): Promise<Array<{ id: string; scopes: string[]; status: SuperpowerStatus }>> {
    if (spec === null || spec.superpowers.length === 0) return [];
    const grants = await listLabGrants(db, orgId);
    return spec.superpowers.map((s) => ({
      id: s.id,
      scopes: s.scopes,
      status: grantConnectionStatus(grants.find((g) => g.connectorId === s.id) ?? null),
    }));
  }

  /** Catalog row for THIS org or the uniform 404 (foreign = unknown). */
  async function ownHarness(req: FastifyRequest) {
    const { hash } = req.params as { hash: string };
    if (!HASH_RE.test(hash)) return null;
    return getLabHarness(db, req.potionOrg!.orgId, hash);
  }

  /** Dial domain for one slot of a catalog harness, or a typed gap. */
  async function slotDomain(
    orgId: string,
    clusterId: string,
    slot: 'brain' | 'tools',
    toolBearing: boolean,
  ): Promise<{ ok: true; domain: DialDomain } | { ok: false; gap: unknown }> {
    const loaded = await loadDialContext(db, { orgId, clusterId });
    if (!loaded.ok) return { ok: false, gap: loaded.gap };
    const r = domainFromContext(loaded.context, { slot, toolBearing });
    if (!r.ok) return { ok: false, gap: r.gap };
    return { ok: true, domain: r.domain };
  }

  // ---- POST /api/lab/harnesses (member) — the interview ----
  app.post('/api/lab/harnesses', async (req: FastifyRequest, reply) => {
    const org = req.potionOrg!;
    if (!roleAtLeast(org.role, 'member')) {
      return reply.code(403).send(memberForbidden(org.role, 'create harnesses'));
    }
    const body = z.object({ answers: ANSWERS_SCHEMA }).safeParse(req.body ?? {});
    if (!body.success) {
      return reply.code(400).send({
        error: 'invalid_body',
        message: body.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      });
    }
    const a = body.data.answers;
    const answers: InterviewAnswers = {
      goal: a.goal,
      kind: a.kind,
      accounts: a.accounts,
      worthUsd: a.worthUsd,
      ...(a.doneDefinition !== undefined ? { doneDefinition: a.doneDefinition } : {}),
      ...(a.constraints !== undefined ? { constraints: a.constraints } : {}),
      ...(a.clusterChoice !== undefined ? { clusterChoice: a.clusterChoice } : {}),
      ...(a.qualityBar !== undefined ? { qualityBar: a.qualityBar } : {}),
      ...(a.produces !== undefined ? { produces: a.produces } : {}),
      ...(a.exampleResult !== undefined ? { exampleResult: a.exampleResult } : {}),
      ...(a.whenUnsure !== undefined ? { whenUnsure: a.whenUnsure } : {}),
      ...(a.cadence !== undefined ? { cadence: a.cadence } : {}),
    };
    const result = await withEphemeralKey(org.orgId, async (rawKey) => {
      const client = new ServingClient({ baseUrl: 'http://lab.injected', apiKey: rawKey, fetchFn: injectFetch });
      return generateSpec(answers, {
        client,
        // Platform frontiers — the generator's world (Step 6): org data
        // plays no part in the default choice.
        loadFrontier: async (clusterId: TaxonomyCluster) =>
          (await loadCurrentFrontier(db, clusterId)) as Frontier | null,
      });
    });
    if (result.kind === 'refused') {
      // Typed refusal passthrough — verbatim reason, never dressed up.
      return reply.code(422).send({ kind: 'refused', reason: result.reason, detail: result.detail });
    }
    if (result.kind === 'draft') {
      return reply.code(200).send({ kind: 'draft', gaps: result.gaps });
    }
    const parsed = parseHarnessSpecText(result.specText);
    if (!parsed.ok) {
      // The generator's closure gate makes this unreachable; fail loudly.
      return reply.code(500).send({ error: 'generator_closure_violation' });
    }
    const clusterId = result.sidecar.choices.find((c) => c.slot === 'brain.policy')?.basis.clusterId;
    if (clusterId === undefined) {
      // A complete spec ALWAYS records the brain choice — closure violation.
      return reply.code(500).send({ error: 'generator_closure_violation' });
    }
    await upsertLabHarness(db, {
      orgId: org.orgId,
      harnessHash: parsed.hash,
      name: result.spec.name,
      specText: result.specText,
      sidecar: result.sidecar,
      clusterId,
    });
    return reply.code(201).send({
      kind: 'complete',
      harnessHash: parsed.hash,
      name: result.spec.name,
      clusterId,
      spec: result.spec,
      sidecar: result.sidecar,
    });
  });

  // ---- GET /api/lab/harnesses (viewer) ----
  app.get('/api/lab/harnesses', async (req: FastifyRequest, reply) => {
    const org = req.potionOrg!;
    const rows = await listLabHarnesses(db, org.orgId);
    // WHO IS WAITING ON YOU (2026-09-05). A parked run emails once and then
    // says nothing ever again; on production one has been waiting since
    // 2026-08-31 because its owner missed that single mail. The roster is
    // where someone looks when they think about their workers, so the
    // roster is where "this one wants you" has to live. One indexed read
    // for the whole org, not one per harness.
    const waiting = await listWaitingLabRuns(db, org.orgId);
    const waitingByHarness = new Map(waiting.map((w) => [w.harnessHash, w]));
    // L-G3+ (design brief): the roster's trust-at-a-glance line — grant
    // state counts per harness, straight from the trust record.
    const harnesses = [];
    for (const r of rows) {
      const grants = await listActionGrants(db, org.orgId, r.harnessHash);
      harnesses.push({
        harnessHash: r.harnessHash,
        name: r.name,
        clusterId: r.clusterId,
        createdAt: r.createdAt,
        trust: {
          autonomous: grants.filter((g) => g.state === 'autonomous').length,
          supervised: grants.filter((g) => g.state === 'supervised').length,
          blocked: grants.filter((g) => g.state === 'blocked').length,
        },
        ...(waitingByHarness.has(r.harnessHash)
          ? {
              waiting: {
                runId: waitingByHarness.get(r.harnessHash)!.id,
                question: waitingByHarness.get(r.harnessHash)!.question,
                since: waitingByHarness.get(r.harnessHash)!.since.toISOString(),
              },
            }
          : {}),
      });
    }
    return reply.send({
      harnesses,
      // Also flat, oldest first: the banner must be able to name the one
      // that has waited longest without walking the roster.
      waiting: waiting.map((w) => ({
        runId: w.id,
        harnessHash: w.harnessHash,
        harnessName: w.harnessName,
        question: w.question,
        since: w.since.toISOString(),
      })),
    });
  });

  // ---- GET /api/lab/harnesses/:hash (viewer) — spec + sidecar + dial ----
  app.get('/api/lab/harnesses/:hash', async (req: FastifyRequest, reply) => {
    const org = req.potionOrg!;
    const row = await ownHarness(req);
    if (row === null) return reply.code(404).send(notFound);
    const parsed = parseHarnessSpecText(row.specText);
    const spec = parsed.ok ? parsed.spec : null;
    const toolBearing = spec !== null && spec.superpowers.length > 0;
    // Dial views per slot — a typed gap is an answer, not an error.
    const dialFor = async (slot: 'brain' | 'tools') => {
      const d = await slotDomain(org.orgId, row.clusterId, slot, toolBearing);
      if (!d.ok) return d;
      return { ok: true as const, frontierId: d.domain.frontierId, views: dialViews(d.domain) };
    };
    return reply.send({
      harnessHash: row.harnessHash,
      name: row.name,
      clusterId: row.clusterId,
      createdAt: row.createdAt,
      // W3 — the generational identity, for the lineage/improve surfaces.
      generation: (row as { generation?: number }).generation ?? 1,
      parentHash: (row as { parentHash?: string | null }).parentHash ?? null,
      supersededBy: (row as { supersededBy?: string | null }).supersededBy ?? null,
      mutationRecord: (row as { mutation?: unknown }).mutation ?? null,
      spec,
      // The canonical spec FILE, byte truth — the machinery view edits
      // this, not a re-serialization (round-trip honesty).
      specText: row.specText,
      // P1 (the clock): armed state for standing missions; null when never armed.
      mission: missionDto(await getLabMission(db, org.orgId, row.harnessHash)),
      sidecar: row.sidecar,
      superpowers: await superpowerPosture(org.orgId, spec),
      dial: {
        brain: await dialFor('brain'),
        ...(toolBearing ? { tools: await dialFor('tools') } : {}),
      },
    });
  });

  // ---- POST /api/lab/harnesses/:hash/dial (admin) — motion ----
  app.post('/api/lab/harnesses/:hash/dial', async (req: FastifyRequest, reply) => {
    const org = req.potionOrg!;
    if (!roleAtLeast(org.role, 'admin')) {
      return reply.code(403).send(forbidden(org.role, 'move the dial'));
    }
    const body = z
      .object({
        slot: z.enum(['brain', 'tools']).default('brain'),
        qualityIndex: z.number().int().min(0).max(100),
        toleranceMs: z.number().int().positive().optional(),
      })
      .safeParse(req.body ?? {});
    if (!body.success) {
      return reply.code(400).send({
        error: 'invalid_body',
        message: body.error.issues.map((i) => i.message).join('; '),
      });
    }
    const row = await ownHarness(req);
    if (row === null) return reply.code(404).send(notFound);
    const parsed = parseHarnessSpecText(row.specText);
    if (!parsed.ok) return reply.code(409).send({ ok: false, gap: { code: 'spec-invalid' } });
    const toolBearing = parsed.spec.superpowers.length > 0;
    const d = await slotDomain(org.orgId, row.clusterId, body.data.slot, toolBearing);
    if (!d.ok) return reply.code(409).send({ ok: false, gap: d.gap });
    if (body.data.qualityIndex >= d.domain.ladder.length) {
      return reply.code(400).send({
        error: 'invalid_body',
        message: `qualityIndex ${body.data.qualityIndex} is off the ladder (0..${d.domain.ladder.length - 1})`,
      });
    }
    const view = viewPosition(d.domain, {
      qualityIndex: body.data.qualityIndex,
      ...(body.data.toleranceMs !== undefined ? { toleranceMs: body.data.toleranceMs } : {}),
    });
    if (!view.feasible) {
      // The typed gap IS the product surface (Step 7): pass it through.
      return reply.code(409).send({ ok: false, gap: view.gap, position: view.position });
    }
    const moved = applyDialPosition({
      specText: row.specText,
      slot: body.data.slot,
      view,
      domain: d.domain,
      priorSidecar: row.sidecar as ChoicesSidecar,
    });
    if (!moved.ok) return reply.code(409).send({ ok: false, gap: { code: moved.reason, detail: moved.detail } });
    const movedParsed = parseHarnessSpecText(moved.specText);
    if (!movedParsed.ok) return reply.code(500).send({ error: 'motion_closure_violation' });
    // The moved spec is a NEW catalog row (content-addressed identity);
    // the prior row — and every run frozen from it — is untouched (the
    // catalog-invariance test pins this from the other side).
    await upsertLabHarness(db, {
      orgId: org.orgId,
      harnessHash: movedParsed.hash,
      name: moved.spec.name,
      specText: moved.specText,
      sidecar: moved.sidecar,
      clusterId: row.clusterId,
    });
    const policyRow = await materializeDialPolicy(db, {
      orgId: org.orgId,
      harnessHash: movedParsed.hash,
      slot: body.data.slot,
      policy: view.policy,
    });
    return reply.send({
      ok: true,
      harnessHash: movedParsed.hash,
      previousHash: row.harnessHash,
      slot: body.data.slot,
      view,
      policyRef: policyRow.name,
    });
  });

  // ---- POST /api/lab/harnesses/:hash/arm | /pause (admin) — the clock ----
  // Arming is the explicit act that lets a STANDING mission run itself on
  // its cadence. It binds to ONE content-addressed version: an edit mints a
  // new hash and the operator re-arms deliberately. Requirements are typed:
  // standing kind, a cron check-in in the spec (the recipe card's cadence),
  // and a cadence the scheduler supports.
  app.post('/api/lab/harnesses/:hash/arm', async (req: FastifyRequest, reply) => {
    const org = req.potionOrg!;
    if (!roleAtLeast(org.role, 'admin')) {
      return reply.code(403).send(forbidden(org.role, 'arm missions'));
    }
    const row = await ownHarness(req);
    if (row === null) return reply.code(404).send(notFound);
    const parsed = parseHarnessSpecText(row.specText);
    if (!parsed.ok) return reply.code(409).send({ ok: false, gap: { code: 'spec-invalid' } });
    if (parsed.spec.mission.kind !== 'standing') {
      return reply.code(400).send({ error: 'invalid_body', message: 'only a standing mission can be armed — a task runs once and finishes' });
    }
    const cron = parsed.spec.checkIns.find((c) => c.trigger === 'cron');
    // P5: event triggers make a mission armable WITHOUT a cadence — the
    // webhook inlet and the feed watcher start its checks instead.
    const hasWebhook = parsed.spec.checkIns.some((c) => c.trigger === 'webhook');
    const hasFeed = parsed.spec.checkIns.some((c) => c.trigger === 'feed-change');
    if ((cron === undefined || !('schedule' in cron)) && !hasWebhook && !hasFeed) {
      return reply.code(400).send({ error: 'invalid_body', message: 'give this mission a schedule or an event trigger first (the "how often it checks" field, a webhook, or a page to watch)' });
    }
    if (cron !== undefined && 'schedule' in cron && missionWindow(cron.schedule, new Date()) === null) {
      return reply.code(400).send({ error: 'invalid_body', message: `the scheduler supports hourly ('0 * * * *'), daily 09:00 UTC ('0 9 * * *') and weekly Monday 09:00 UTC ('0 9 * * 1') — got '${cron.schedule}'` });
    }
    // The webhook inlet's secret is minted AT ARM, shown ONCE in this
    // response, and stored only as a hash (api-key custody). Re-arming
    // rotates it — the old inlet URL stops working, deliberately.
    const hookToken = hasWebhook ? `whk_${randomBytes(24).toString('hex')}` : null;
    await armLabMission(db, {
      orgId: org.orgId,
      harnessHash: row.harnessHash,
      cadenceCron: cron !== undefined && 'schedule' in cron ? cron.schedule : 'event',
      armedBy: actorOf(req),
      hookTokenHash: hookToken !== null ? sha256(hookToken) : null,
    });
    const mission = await getLabMission(db, org.orgId, row.harnessHash);
    return reply.send({
      ok: true,
      mission: missionDto(mission),
      ...(hookToken !== null
        ? {
            hook: {
              url: `${publicBaseUrl(req)}/hooks/lab/${hookToken}`,
              note: 'shown once — POST to it and this worker starts a check. Re-arming rotates it.',
            },
          }
        : {}),
    });
  });

  // ---- P5: the webhook inlet — anything can poke a worker awake ----
  // PUBLIC route addressed by the secret token alone (its sha256 finds the
  // armed mission; unknown or paused = the uniform 404, no oracle). The
  // starter enforces the day budget and refuses bursts (per-minute id).
  app.post('/hooks/lab/:token', async (req: FastifyRequest, reply) => {
    const { token } = req.params as { token: string };
    if (!/^whk_[0-9a-f]{48}$/.test(token)) return reply.code(404).send(notFound);
    const mission = await findArmedMissionByHookHash(db, sha256(token));
    if (mission === null) return reply.code(404).send(notFound);
    const started = await startEventCheck({ db: ctx.db, queue: opts.queue }, {
      orgId: mission.orgId,
      harnessHash: mission.harnessHash,
      kind: 'hook',
      note: 'webhook inlet fired',
    });
    if (!started.ok) return reply.code(429).send({ ok: false, reason: started.reason });
    return reply.code(202).send({ ok: true, runId: started.runId });
  });

  app.post('/api/lab/harnesses/:hash/pause', async (req: FastifyRequest, reply) => {
    const org = req.potionOrg!;
    if (!roleAtLeast(org.role, 'admin')) {
      return reply.code(403).send(forbidden(org.role, 'pause missions'));
    }
    const row = await ownHarness(req);
    if (row === null) return reply.code(404).send(notFound);
    await pauseLabMission(db, org.orgId, row.harnessHash);
    const mission = await getLabMission(db, org.orgId, row.harnessHash);
    return reply.send({ ok: true, mission: missionDto(mission) });
  });

  // ---- PUT /api/lab/harnesses/:hash/spec (admin) — the open hood ----
  // The operator's 2026-08-27 brief: "under the hood must be editable —
  // this is a LAB". The entire spec file is writable, through EVERY custody
  // gate parseHarnessSpecText enforces (schema, size, control characters,
  // key-shaped secrets, tamper-evident hash). Failures return the TYPED
  // issue list — path, code, message — never a laundered 400. A valid edit
  // mints a NEW content-addressed catalog row (dial-motion precedent): the
  // prior row and every run frozen from it are untouched. The autopilot
  // sidecar is deliberately ORPHANED — an operator-authored spec carries
  // operator provenance, and editedFrom names the lineage.
  app.put('/api/lab/harnesses/:hash/spec', async (req: FastifyRequest, reply) => {
    const org = req.potionOrg!;
    if (!roleAtLeast(org.role, 'admin')) {
      return reply.code(403).send(forbidden(org.role, 'edit the spec'));
    }
    const body = z.object({ specText: z.string().min(2).max(80_000) }).safeParse(req.body ?? {});
    if (!body.success) {
      return reply.code(400).send({
        error: 'invalid_body',
        message: body.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      });
    }
    const row = await ownHarness(req);
    if (row === null) return reply.code(404).send(notFound);
    const parsed = parseHarnessSpecText(body.data.specText);
    if (!parsed.ok) {
      return reply.code(422).send({ ok: false, issues: parsed.issues });
    }
    if (parsed.hash === row.harnessHash) {
      return reply.send({ ok: true, harnessHash: row.harnessHash, unchanged: true });
    }
    // Re-canonicalize: the stored file is ALWAYS canonical bytes with the
    // embedded hash, whatever formatting the editor sent.
    const canonicalText = canonicalJson({ ...parsed.spec, hash: parsed.hash });
    const prior = row.sidecar as ChoicesSidecar;
    const sidecar: ChoicesSidecar = {
      specHash: parsed.hash,
      choicesHash: sha256(canonicalJson([])),
      choices: [],
      editedFrom: row.harnessHash,
    };
    if (prior?.workProfile !== undefined) sidecar.workProfile = prior.workProfile;
    await upsertLabHarness(db, {
      orgId: org.orgId,
      harnessHash: parsed.hash,
      name: parsed.spec.name,
      specText: canonicalText,
      sidecar,
      // The cluster is interpretation provenance, not spec law — an edit
      // keeps the reading (re-describe the mission to change it).
      clusterId: row.clusterId,
    });
    return reply.send({ ok: true, harnessHash: parsed.hash, previousHash: row.harnessHash, name: parsed.spec.name });
  });

  // ---- POST /api/lab/harnesses/:hash/felt (member) — cap-bound, cached ----
  app.post('/api/lab/harnesses/:hash/felt', async (req: FastifyRequest, reply) => {
    const org = req.potionOrg!;
    if (!roleAtLeast(org.role, 'member')) {
      return reply.code(403).send(memberForbidden(org.role, 'run felt sweeps'));
    }
    const body = z
      .object({
        slot: z.enum(['brain', 'tools']).default('brain'),
        positions: z
          .array(
            z
              .object({
                qualityIndex: z.number().int().min(0).max(100),
                toleranceMs: z.number().int().positive().optional(),
              })
              .strict(),
          )
          .min(1)
          .max(FELT_SWEEP_MAX_POSITIONS),
      })
      .safeParse(req.body ?? {});
    if (!body.success) {
      return reply.code(400).send({
        error: 'invalid_body',
        message: body.error.issues.map((i) => i.message).join('; '),
      });
    }
    const row = await ownHarness(req);
    if (row === null) return reply.code(404).send(notFound);
    const parsed = parseHarnessSpecText(row.specText);
    if (!parsed.ok) return reply.code(409).send({ ok: false, gap: { code: 'spec-invalid' } });
    const toolBearing = parsed.spec.superpowers.length > 0;
    const d = await slotDomain(org.orgId, row.clusterId, body.data.slot, toolBearing);
    if (!d.ok) return reply.code(409).send({ ok: false, gap: d.gap });

    const probe = missionProbe(parsed.spec.mission);
    const requests: FeltPositionRequest[] = [];
    const infeasible: Array<{ position: unknown; gap: unknown }> = [];
    for (const p of body.data.positions) {
      if (p.qualityIndex >= d.domain.ladder.length) {
        infeasible.push({ position: p, gap: { code: 'off-ladder' } });
        continue;
      }
      const view: DialView = viewPosition(d.domain, {
        qualityIndex: p.qualityIndex,
        ...(p.toleranceMs !== undefined ? { toleranceMs: p.toleranceMs } : {}),
      });
      if (!view.feasible) {
        infeasible.push({ position: view.position, gap: view.gap });
        continue;
      }
      // One policy row PER POSITION, discriminated AWAY from the harness's
      // own hash (review finding, proven live by the felt leg): the row name
      // embeds only the first 12 chars of the hash, so positions sharing it
      // would collapse onto one row — every probe would ride the LAST
      // position's policy — and would clobber the run pin rows an in-flight
      // lab:run materialized under the undiscriminated hash. The leading
      // `f<rung><tol>x` prefix keeps each position's row distinct and
      // disjoint from run pins.
      const policyRow = await materializeDialPolicy(db, {
        orgId: org.orgId,
        harnessHash: `f${p.qualityIndex}t${p.toleranceMs ?? 0}x${row.harnessHash}`.slice(0, 64),
        slot: body.data.slot,
        policy: view.policy,
      });
      requests.push({
        orgId: org.orgId,
        probe,
        policy: view.policy,
        policyRef: policyRow.name,
        frontierId: view.frontierId,
        expectedStrategyHash: view.strategyHash,
      });
    }
    if (requests.length === 0) {
      return reply.code(409).send({ ok: false, infeasible });
    }
    const clusterId = row.clusterId;
    const sweep = await withEphemeralKey(org.orgId, async (rawKey) =>
      feltSweep(requests, {
        clientFor: (policyRef) =>
          new ServingClient({
            baseUrl: 'http://lab.injected',
            apiKey: rawKey,
            policyRef,
            clusterHint: clusterId,
            fetchFn: injectFetch,
          }),
        cache: feltSampleCache(db),
        costLookup: requestLogCostLookup(db),
      }),
    );
    return reply.send({
      ok: true,
      samples: sweep.samples.map((s) => ({
        policyRef: s.policyRef,
        outcome: s.outcome.ok
          ? {
              ok: true,
              sample: {
                ...s.outcome.sample,
                // House style: anything not live-evidenced is SIMULATED.
                simulated: s.outcome.sample.provenance !== 'live',
              },
              ...(s.outcome.divergent !== undefined ? { divergent: s.outcome.divergent } : {}),
            }
          : s.outcome,
      })),
      // The cap gap and any silently-imposed position cap are REPORTED,
      // never hidden (review finding 15).
      ...(sweep.gap !== undefined ? { gap: sweep.gap } : {}),
      dropped: sweep.dropped,
      infeasible,
    });
  });

  // ---- POST /api/lab/runs (member) — start a trial run ----
  // W-flagship (2026-09-01): trials accept ATTACHMENTS — the operator's own
  // data files, seeded into the run workspace before the worker starts. The
  // sandbox ships the whole workspace tree on every call, so an attached
  // CSV is simply THERE. Base64 over JSON (binary-safe; the repo enforces
  // per-file/total caps + path validation); the route lifts the body limit
  // to carry it.
  app.post('/api/lab/runs', { bodyLimit: 16_000_000 }, async (req: FastifyRequest, reply) => {
    const org = req.potionOrg!;
    if (!roleAtLeast(org.role, 'member')) {
      return reply.code(403).send(memberForbidden(org.role, 'start trial runs'));
    }
    const body = z
      .object({
        harnessHash: z.string().regex(HASH_RE),
        attachments: z
          .array(z.object({ name: z.string().min(1).max(120), contentBase64: z.string().max(11_000_000) }).strict())
          .max(4)
          .optional(),
      })
      .safeParse(req.body ?? {});
    if (!body.success) {
      return reply.code(400).send({ error: 'invalid_body', message: 'harnessHash (64 hex chars) is required' });
    }
    const row = await getLabHarness(db, org.orgId, body.data.harnessHash);
    if (row === null) return reply.code(404).send(notFound);
    const parsed = parseHarnessSpecText(row.specText);
    if (!parsed.ok) {
      return reply.code(409).send({
        ok: false,
        gap: { code: 'spec-invalid', detail: parsed.issues.map((i) => i.code).join(',') },
      });
    }
    const runId = `run-${randomUUID().slice(0, 8)}`;
    // The run FREEZES the spec — catalog edits after this instant are
    // invisible to it (catalog-invariance pin).
    await createLabRun(db, {
      id: runId,
      orgId: org.orgId,
      harnessHash: parsed.hash,
      harnessName: parsed.spec.name,
      spec: parsed.spec,
    });
    // Seed attachments BEFORE the job enqueues — the first leg must see them.
    const attached: string[] = [];
    for (const a of body.data.attachments ?? []) {
      let content: Buffer;
      try {
        content = Buffer.from(a.contentBase64, 'base64');
      } catch {
        return reply.code(400).send({ error: 'invalid_body', message: `attachment '${a.name}' is not valid base64` });
      }
      const wrote = await upsertLabRunFile(db, { orgId: org.orgId, runId, name: a.name, content });
      if (!wrote.ok) {
        return reply.code(422).send({ error: 'attachment_refused', message: wrote.reason });
      }
      attached.push(a.name);
    }
    const jobId = await opts.queue.enqueue('lab:run', { orgId: org.orgId, runId });
    return reply.code(202).send({ runId, jobId, state: 'pending', ...(attached.length > 0 ? { attached } : {}) });
  });

  /** Run row for THIS org or uniform 404. */
  async function ownRun(req: FastifyRequest) {
    const { id } = req.params as { id: string };
    if (!RUN_ID_RE.test(id)) return null;
    return getLabRun(db, id, req.potionOrg!.orgId);
  }

  // ---- GET /api/lab/runs/:id (viewer) — narration + est-vs-metered ticker ----
  app.get('/api/lab/runs/:id', async (req: FastifyRequest, reply) => {
    const org = req.potionOrg!;
    const run = await ownRun(req);
    if (run === null) return reply.code(404).send(notFound);
    const steps = await listLabSteps(db, run.id, org.orgId);
    const costLookup = requestLogCostLookup(db);
    let meteredTotal = 0;
    let estPendingTotal = 0;
    const stepDtos = [];
    for (const s of steps) {
      const p = s.payload as StepPayload;
      const provenance = s.kind === 'model' ? traceProvenance(p.frontierTrace) : null;
      // TWO numbers, TWO labels — never blended: metered truth from the
      // request_logs join when the completion resolved, the flat fuel
      // estimate LABELED "est." until then.
      let meteredUsd: number | null = null;
      if (s.kind === 'model' && p.completionId !== undefined) {
        meteredUsd = await costLookup(p.completionId);
      }
      if (meteredUsd !== null) meteredTotal += meteredUsd;
      else if (s.kind === 'model') estPendingTotal += p.estCostUsd ?? 0;
      stepDtos.push({
        seq: s.seq,
        kind: s.kind,
        at: s.createdAt,
        slot: p.slot ?? null,
        // X8: operator steers this step folded in — rendered in the feed.
        ...(p.steers !== undefined ? { steers: p.steers } : {}),
        // W1: the gateway's decision, surfaced — the ledger's word made
        // visible where the action happened.
        ...(p.gate !== undefined
          ? {
              gate: {
                decision: p.gate.decision,
                grantState: p.gate.grantState,
                ...(p.gate.audit !== undefined ? { audit: p.gate.audit } : {}),
                ...(p.gate.reason !== undefined ? { reason: p.gate.reason } : {}),
              },
            }
          : {}),
        excerpt:
          s.kind === 'model'
            ? (p.responseText ?? '').slice(0, 400)
            : s.kind === 'tool'
              ? `${p.toolName}: ${JSON.stringify(p.toolOutput ?? null).slice(0, 400)}`
              : (p.checkInQuestion ?? ''),
        // THE NARRATOR: the human rendering of this step — title/detail/
        // hidden — built by the shared, tested translator (never raw JSON
        // as a headline, never an empty labeled row).
        ...((): Record<string, unknown> => {
          const n = narrateStep({
            kind: s.kind as 'model' | 'tool' | 'check-in',
            ...(p.responseText !== undefined ? { responseText: p.responseText } : {}),
            ...(p.toolCalls !== undefined ? { toolCalls: p.toolCalls } : {}),
            ...(p.toolName !== undefined ? { toolName: p.toolName } : {}),
            ...(p.toolInput !== undefined ? { toolInput: p.toolInput } : {}),
            ...(p.toolOutput !== undefined ? { toolOutput: p.toolOutput } : {}),
            ...(p.checkInTrigger !== undefined ? { checkInTrigger: p.checkInTrigger } : {}),
            ...(p.checkInQuestion !== undefined ? { checkInQuestion: p.checkInQuestion } : {}),
          });
          return {
            ...(n.title !== '' ? { title: n.title } : {}),
            ...(n.detail !== undefined ? { detail: n.detail } : {}),
            ...(n.detailKind !== undefined ? { detailKind: n.detailKind } : {}),
            ...(n.hidden === true ? { hidden: true } : {}),
          };
        })(),
        ...(s.kind === 'model'
          ? {
              estCostUsd: p.estCostUsd ?? 0,
              meteredCostUsd: meteredUsd,
              costLabel: meteredUsd !== null ? ('metered' as const) : ('est.' as const),
              provenance,
              simulated: provenance !== 'live',
              // Step 9: typed anomaly flags — parsed here ONCE so the form's
              // anomaly encoding reads a boolean, never a trace string.
              fallback: /(?:^|;)fallback=1/.test(p.frontierTrace ?? ''),
              latencyViolated: /latency_violated=1/.test(p.frontierTrace ?? ''),
            }
          : {}),
      });
    }
    return reply.send({
      runId: run.id,
      harnessHash: run.harnessHash,
      harnessName: run.harnessName,
      state: run.state,
      stateReason: run.stateReason,
      pendingQuestion: run.pendingQuestion,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      superpowers: await superpowerPosture(org.orgId, run.spec as HarnessSpec),
      // X2: the durable task ledger, derived from the record (last valid
      // update_plan wins) — the same truth the loop re-injects each leg.
      plan: planFromSteps(steps.map((x) => ({ kind: x.kind, payload: x.payload }))),
      // X3: the advisory judgment (null until judged; typed miss recorded).
      judge: run.judge ?? null,
      // X3/H1: the workspace files, LIVE on the polling DTO — artifacts
      // appear as the code produces them, not after a page refresh.
      files: await listLabRunFiles(db, org.orgId, run.id),
      // X4 (one trace): the family — helpers of this run, and the parent
      // when this run IS a helper.
      parentRunId: run.parentRunId ?? null,
      children: (await listLabRunChildren(db, org.orgId, run.id)).map((c) => ({
        runId: c.id,
        state: c.state,
        goal: ((c.spec as { mission?: { goal?: string } }).mission?.goal ?? '').slice(0, 200),
        harnessName: c.harnessName,
        at: c.createdAt,
      })),
      // P-1 (the routing dividend): what THIS run's model steps would have
      // cost on the best scorer of each step's own kind — computed from the
      // steps' recorded traces and the live frontiers, null when unpriceable.
      premiumUsd: await premiumCounterfactualUsd(db, org.orgId, steps),
      steps: stepDtos,
      cost: {
        meteredUsd: meteredTotal,
        estPendingUsd: estPendingTotal,
        // No blended figure EXISTS in this DTO — deliberate (the DoD pin).
      },
      // P1 (the mouth): the filed deliverable, derived from the record by
      // the SAME parser the completion law used — no second storage, no
      // second truth. null when the contract wasn't met (honest absence).
      deliverable: extractDeliverable(
        run.spec as HarnessSpec,
        steps.map((s) => ({ seq: s.seq, kind: s.kind, payload: s.payload as { responseText?: string; toolCalls?: unknown[]; finishReason?: string } })),
      ),
      // 2026-08-31 (the generational pass): a completed TASK run's report —
      // the final answer that met the done-definition, rendered and judged
      // like any deliverable instead of leaving the user a download list.
      report: run.state === 'completed'
        ? extractReport(
            run.spec as HarnessSpec,
            steps.map((s) => ({ seq: s.seq, kind: s.kind, payload: s.payload as { responseText?: string; toolCalls?: unknown[]; finishReason?: string } })),
          )
        : null,
    });
  });

  // ---- POST /api/lab/runs/:id/answer (member) ----
  app.post('/api/lab/runs/:id/answer', async (req: FastifyRequest, reply) => {
    const org = req.potionOrg!;
    if (!roleAtLeast(org.role, 'member')) {
      return reply.code(403).send(memberForbidden(org.role, 'answer check-ins'));
    }
    const body = z.object({ answer: z.string().min(1).max(4000) }).safeParse(req.body ?? {});
    if (!body.success) {
      return reply.code(400).send({ error: 'invalid_body', message: 'answer (1..4000 chars) is required' });
    }
    const run = await ownRun(req);
    if (run === null) return reply.code(404).send(notFound);
    if (run.state !== 'awaiting-human') {
      return reply.code(409).send(
        openAiError(
          `run is '${run.state}' — only awaiting-human runs take answers`,
          'invalid_request_error',
          'run_not_awaiting',
        ),
      );
    }
    // answerLabRun is a GUARDED update (state must still be awaiting-human
    // with no pending answer) — honor its verdict: a lost race is a 409,
    // never a 202 that silently dropped the answer (review finding).
    const accepted = await answerLabRun(db, run.id, org.orgId, body.data.answer);
    if (!accepted) {
      return reply.code(409).send(
        openAiError(
          'the run stopped awaiting between read and write, or an answer is already pending — reload and retry',
          'invalid_request_error',
          'answer_not_accepted',
        ),
      );
    }
    const jobId = await opts.queue.enqueue('lab:run', { orgId: org.orgId, runId: run.id });
    return reply.code(202).send({ runId: run.id, jobId, state: 'pending-resume' });
  });

  // ---- POST /api/lab/runs/:id/kill (admin) ----
  app.post('/api/lab/runs/:id/kill', async (req: FastifyRequest, reply) => {
    const org = req.potionOrg!;
    if (!roleAtLeast(org.role, 'admin')) {
      return reply.code(403).send(forbidden(org.role, 'kill runs'));
    }
    const run = await ownRun(req);
    if (run === null) return reply.code(404).send(notFound);
    await killLabRun(db, run.id, org.orgId);
    const after = await getLabRun(db, run.id, org.orgId);
    return reply.send({ runId: run.id, state: after?.state ?? 'killed-operator' });
  });

  // ---- GET /api/lab/runs/:id/report (viewer) — report v1 ----
  // ---- X3 UX: recent worker activity — the home feed's lab source ----
  app.get('/api/lab/recent', async (req: FastifyRequest, reply) => {
    const org = req.potionOrg!;
    const rows = await listRecentLabRuns(db, org.orgId, { limit: 8 });
    return reply.send({
      runs: rows.map((r) => ({
        runId: r.id,
        harnessName: r.harnessName,
        state: r.state,
        at: r.createdAt,
        judgeOverall: (r.judge as { overall?: number } | null)?.overall ?? null,
      })),
    });
  });

  // ---- X3: verify the record — the replay theorem as a button ----
  // Wording law (the panel): replay proves the record is SELF-CONSISTENT
  // AND DERIVABLE — never that a model would answer the same. The endpoint
  // is pure read + pure computation: zero provider calls, zero writes.
  app.post('/api/lab/runs/:id/verify', async (req: FastifyRequest, reply) => {
    const org = req.potionOrg!;
    const { id } = req.params as { id: string };
    if (!RUN_ID_RE.test(id)) return reply.code(404).send(notFound);
    const run = await getLabRun(db, id, org.orgId);
    if (run === null) return reply.code(404).send(notFound);
    const steps = await listLabSteps(db, id, org.orgId);
    const result = replayRun(
      run.spec as HarnessSpec,
      steps.map((x) => ({ seq: x.seq, kind: x.kind as 'model' | 'tool' | 'check-in', payload: x.payload as never })),
      { state: run.state, reason: run.stateReason },
    );
    return reply.send(
      result.ok
        ? { ok: true, steps: result.steps, modelSteps: result.modelSteps }
        : {
            ok: false,
            divergences: result.divergences.length,
            sample: result.divergences.slice(0, 3).map((d) => ({ code: d.code, seq: d.seq, field: d.field ?? null })),
          },
    );
  });

  // ---- X8 (2026-08-30): the session shape — steer a running worker ----
  // The check-in channel, generalized: guidance lands at the worker's NEXT
  // model step, recorded on that step so replay derives the identical
  // conversation. Steering NEVER authorizes an external action — the pore's
  // answer channel keeps that monopoly (L4), and a parked run stays parked
  // until it is ANSWERED.
  app.post('/api/lab/runs/:id/steer', async (req: FastifyRequest, reply) => {
    const org = req.potionOrg!;
    if (!roleAtLeast(org.role, 'member')) {
      return reply.code(403).send(memberForbidden(org.role, 'steer runs'));
    }
    const body = z.object({ text: z.string().min(1).max(STEER_LIMITS.MAX_TEXT_CHARS) }).safeParse(req.body ?? {});
    if (!body.success) {
      return reply.code(400).send({ error: 'invalid_body', message: body.error.issues.map((i) => i.message).join('; ') });
    }
    const run = await ownRun(req);
    if (run === null) return reply.code(404).send(notFound);
    const TERMINAL = new Set(['completed', 'failed', 'killed-budget', 'killed-operator']);
    if (TERMINAL.has(run.state)) {
      return reply.code(409).send({ ok: false, reason: `this run is ${run.state} — steering targets a live run` });
    }
    // Custody at the inlet: a steer carrying key-shaped content would ride
    // straight into model context and the durable record. Refused.
    const hits = scanRawValue({ text: body.data.text }).filter((i) => i.code === 'secret-material');
    if (hits.length > 0) {
      return reply.code(422).send({ ok: false, reason: 'the steering text contains key-shaped content — refused (nothing was queued)' });
    }
    const added = await addLabRunSteer(db, {
      id: `steer-${randomUUID().slice(0, 12)}`,
      orgId: org.orgId,
      runId: run.id,
      text: body.data.text,
      createdBy: actorOf(req),
    });
    if (!added.ok) return reply.code(429).send({ ok: false, reason: added.reason });
    return reply.code(202).send({
      ok: true,
      note:
        run.state === 'awaiting-human'
          ? 'queued — this worker is parked on its check-in; answer that to resume, and your steering lands at its next step'
          : 'queued — it lands at the worker’s next step, on the record',
    });
  });

  // ---- H2 (2026-08-28): the artifact that escapes — share a deliverable ----
  // Opt-in, admin-minted, revocable (the M4 share rail: sha256 at rest, raw
  // token shown once, uniform 404). The payload is FROZEN AT MINT:
  //   · the brief re-extracted from the record;
  //   · custody scan — key-shaped content anywhere in it REFUSES the mint;
  //   · `verified` computed by the replay theorem right now, stored, and
  //     never asserted beyond what the record proved;
  //   · costs stored labeled (metered vs est.) — no blended figure ships.
  app.post('/api/lab/runs/:id/share', async (req: FastifyRequest, reply) => {
    const org = req.potionOrg!;
    if (!roleAtLeast(org.role, 'admin')) {
      return reply.code(403).send(forbidden(org.role, 'share deliverables'));
    }
    const run = await ownRun(req);
    if (run === null) return reply.code(404).send(notFound);
    if (run.state !== 'completed') {
      return reply.code(409).send({ ok: false, reason: 'only a completed run has a deliverable to share' });
    }
    const spec = run.spec as HarnessSpec;
    const steps = await listLabSteps(db, run.id, org.orgId);
    const found = extractDeliverable(
      spec,
      steps.map((x) => ({ seq: x.seq, kind: x.kind, payload: x.payload as { responseText?: string; toolCalls?: unknown[]; finishReason?: string } })),
    );
    if (found === null) {
      return reply.code(409).send({ ok: false, reason: 'this run produced no contract deliverable — nothing to share' });
    }
    // Custody at the escape hatch: a deliverable carrying key-shaped
    // content does not leave, full stop.
    const secretHits = scanRawValue(found.brief).filter((i) => i.code === 'secret-material');
    if (secretHits.length > 0) {
      return reply.code(422).send({ ok: false, reason: 'the deliverable contains key-shaped content — refused (nothing was shared)' });
    }
    const replayed = replayRun(
      spec,
      steps.map((x) => ({ seq: x.seq, kind: x.kind as 'model' | 'tool' | 'check-in', payload: x.payload as never })),
      { state: run.state, reason: run.stateReason },
    );
    // Labeled costs, the run-page derivation: metered truth where the
    // completion resolved, the flat estimate elsewhere — never blended.
    const costLookup = requestLogCostLookup(db);
    let meteredUsd = 0;
    let estUsd = 0;
    for (const st of steps) {
      const p = st.payload as StepPayload;
      if (st.kind !== 'model') continue;
      const m = p.completionId !== undefined ? await costLookup(p.completionId) : null;
      if (m !== null) meteredUsd += m;
      else estUsd += p.estCostUsd ?? 0;
    }
    const judgeOverall = (run.judge as { overall?: number } | null)?.overall ?? null;
    const rawToken = `${SHARE_TOKEN_PREFIX}${randomUUID().replace(/-/g, '')}${randomUUID().replace(/-/g, '')}`;
    const row = await insertShareToken(db, {
      orgId: org.orgId,
      kind: 'brief',
      tokenHash: sha256(rawToken),
      redactNames: true,
      payload: {
        kind: 'brief',
        harnessName: run.harnessName,
        brief: found.brief,
        verified: replayed.ok,
        judgeOverall,
        meteredUsd: Math.round(meteredUsd * 10_000) / 10_000,
        estUsd: Math.round(estUsd * 10_000) / 10_000,
        sharedAt: new Date().toISOString(),
      },
    });
    return reply.code(201).send({
      ok: true,
      shareId: row.id,
      url: `${publicBaseUrl(req)}/share/b/${rawToken}`,
      note: 'the link is shown once — revoke it any time from the share list',
      verified: replayed.ok,
    });
  });

  // ---- X1: the run's file workspace — artifacts, listed + downloadable ----
  app.get('/api/lab/runs/:id/files', async (req: FastifyRequest, reply) => {
    const org = req.potionOrg!;
    const { id } = req.params as { id: string };
    if (!RUN_ID_RE.test(id)) return reply.code(404).send(notFound);
    const run = await getLabRun(db, id, org.orgId);
    if (run === null) return reply.code(404).send(notFound);
    return reply.send({ runId: id, files: await listLabRunFiles(db, org.orgId, id) });
  });

  // LIVE OUTPUT (2026-09-02, Live views #2): the in-flight sandbox tail
  // for a RUNNING call — ephemeral, in-process, never part of the record.
  // 204 when nothing is executing; the run page's now-strip polls this.
  app.get('/api/lab/runs/:id/live', async (req: FastifyRequest, reply) => {
    const org = req.potionOrg!;
    const { id } = req.params as { id: string };
    if (!RUN_ID_RE.test(id)) return reply.code(404).send(notFound);
    const run = await getLabRun(db, id, org.orgId);
    if (run === null) return reply.code(404).send(notFound);
    const live = getLiveOutput(id);
    // 200 either way — the dashboard proxy relays JSON bodies, and a 204
    // with a body is a contradiction it would mangle.
    if (live === null) return reply.send({ idle: true });
    return reply.send(live);
  });

  app.get('/api/lab/runs/:id/files/:name', async (req: FastifyRequest, reply) => {
    const org = req.potionOrg!;
    const { id, name } = req.params as { id: string; name: string };
    if (!RUN_ID_RE.test(id)) return reply.code(404).send(notFound);
    const run = await getLabRun(db, id, org.orgId);
    if (run === null) return reply.code(404).send(notFound);
    const file = await getLabRunFile(db, org.orgId, id, name);
    if (file === null) return reply.code(404).send(notFound);
    return reply
      .header('content-type', file.meta.mime)
      .header('content-disposition', `attachment; filename="${file.meta.name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '')}"`)
      .header('x-content-sha256', file.meta.sha256)
      .send(file.content);
  });

  app.get('/api/lab/runs/:id/report', async (req: FastifyRequest, reply) => {
    const org = req.potionOrg!;
    const run = await ownRun(req);
    if (run === null) return reply.code(404).send(notFound);
    const report = await buildRunReport(db, run.id, org.orgId);
    if (report === null) return reply.code(404).send(notFound);
    // Provenance over the run's model steps — the report is SIMULATED
    // unless every serving step was live-evidenced.
    const steps = await listLabSteps(db, run.id, org.orgId);
    const provenances = [
      ...new Set(
        steps
          .filter((s) => s.kind === 'model')
          .map((s) => traceProvenance((s.payload as StepPayload).frontierTrace)),
      ),
    ];
    const simulated = provenances.length === 0 || provenances.some((p) => p !== 'live');
    return reply.send({ ...report, provenances, simulated });
  });

  // ---- GET /api/lab/memory/:hash (viewer) ----
  app.get('/api/lab/memory/:hash', async (req: FastifyRequest, reply) => {
    const org = req.potionOrg!;
    const row = await ownHarness(req);
    if (row === null) return reply.code(404).send(notFound);
    const entries = await listLabMemoryEntries(db, org.orgId, row.harnessHash);
    return reply.send({
      harnessHash: row.harnessHash,
      entries: entries.map((e) => ({
        key: e.key,
        value: e.value,
        // Plain-language v1: strings render as text, anything else as JSON.
        rendered: typeof e.value === 'string' ? e.value : JSON.stringify(e.value, null, 2),
        updatedAt: e.updatedAt,
      })),
    });
  });

  // ---- PUT /api/lab/memory/:hash/:key (member) ----
  app.put('/api/lab/memory/:hash/:key', async (req: FastifyRequest, reply) => {
    const org = req.potionOrg!;
    if (!roleAtLeast(org.role, 'member')) {
      return reply.code(403).send(memberForbidden(org.role, 'edit memory'));
    }
    const { key } = req.params as { key: string };
    const body = z.object({ text: z.string().max(8000) }).safeParse(req.body ?? {});
    if (!body.success) {
      return reply.code(400).send({ error: 'invalid_body', message: 'text (string, ≤8000 chars) is required' });
    }
    const row = await ownHarness(req);
    if (row === null || !MEMORY_KEY_RE.test(key)) return reply.code(404).send(notFound);
    // v1 simplification (recorded in the spec): edits are text. A string
    // value stays a string; editing a STRUCTURED value stores { note: text }
    // — Step 9's derived form does better.
    const current = (await listLabMemoryEntries(db, org.orgId, row.harnessHash)).find((e) => e.key === key);
    const value =
      current !== undefined && typeof current.value !== 'string'
        ? { note: body.data.text }
        : body.data.text;
    await setLabMemoryKey(db, org.orgId, row.harnessHash, key, value);
    return reply.send({ key, value });
  });

  // ---- DELETE /api/lab/memory/:hash/:key (admin) — permanent ----
  app.delete('/api/lab/memory/:hash/:key', async (req: FastifyRequest, reply) => {
    const org = req.potionOrg!;
    if (!roleAtLeast(org.role, 'admin')) {
      return reply.code(403).send(forbidden(org.role, 'delete memory'));
    }
    const { key } = req.params as { key: string };
    const row = await ownHarness(req);
    if (row === null || !MEMORY_KEY_RE.test(key)) return reply.code(404).send(notFound);
    const existed = await deleteLabMemoryKey(db, org.orgId, row.harnessHash, key);
    if (!existed) return reply.code(404).send(notFound);
    return reply.send({ key, deleted: true });
  });

  // ---- GET /api/lab/harnesses/:hash/runs (viewer) — the harness's life ----
  app.get('/api/lab/harnesses/:hash/runs', async (req: FastifyRequest, reply) => {
    const org = req.potionOrg!;
    const row = await ownHarness(req);
    if (row === null) return reply.code(404).send(notFound);
    const runs = await listLabRunsForHarness(db, org.orgId, row.harnessHash);
    return reply.send({
      harnessHash: row.harnessHash,
      runs: runs.map((r) => ({
        runId: r.id,
        state: r.state,
        stateReason: r.stateReason,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      })),
    });
  });

  // ---- POST /api/lab/harnesses/:hash/edit (member) — plain-language patch ----
  // The dial-motion precedent applied to the REST of the spec: a typed patch
  // produces a NEW content-addressed catalog row with carried sidecar
  // provenance rebound to the new hash; run-frozen specs are untouched (the
  // Step 8 catalog-invariance pin guards this from the other side). This is
  // the route the form's mid-zoom edit panels save through — live re-render
  // is a refetch of the NEW hash, never a client-side shortcut.
  const EDIT_OP = z.discriminatedUnion('op', [
    z.object({ op: z.literal('add-rule'), rule: z.string().min(1).max(500) }).strict(),
    z.object({ op: z.literal('remove-rule'), index: z.number().int().min(0) }).strict(),
    z.object({ op: z.literal('set-worth'), worthUsd: z.number().positive().max(10_000) }).strict(),
    z.object({ op: z.literal('set-checkin-fraction'), fraction: z.number().gt(0).max(1) }).strict(),
    z.object({ op: z.literal('declare-superpower'), id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,58}[a-z0-9]$/) }).strict(),
    z.object({ op: z.literal('undeclare-superpower'), id: z.string().min(1).max(60) }).strict(),
  ]);
  app.post('/api/lab/harnesses/:hash/edit', async (req: FastifyRequest, reply) => {
    const org = req.potionOrg!;
    if (!roleAtLeast(org.role, 'member')) {
      return reply.code(403).send(memberForbidden(org.role, 'edit harnesses'));
    }
    const body = z.object({ ops: z.array(EDIT_OP).min(1).max(10) }).safeParse(req.body ?? {});
    if (!body.success) {
      return reply.code(400).send({
        error: 'invalid_body',
        message: body.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      });
    }
    const row = await ownHarness(req);
    if (row === null) return reply.code(404).send(notFound);
    const parsed = parseHarnessSpecText(row.specText);
    if (!parsed.ok) return reply.code(409).send({ ok: false, gap: { code: 'spec-invalid' } });

    // Apply the patch to a copy of the spec — every op is total or a 400.
    const spec: HarnessSpec = JSON.parse(JSON.stringify(parsed.spec));
    delete (spec as { hash?: string }).hash;
    for (const op of body.data.ops) {
      if (op.op === 'add-rule') {
        // The generation-time convention, mirrored (review finding):
        // control characters collapse to spaces before the closure gate,
        // so a pasted tab/newline never 409s as an internal-looking
        // closure violation; genuinely secret-shaped rules still refuse
        // with the parse gate's own typed issue codes.
        // eslint-disable-next-line no-control-regex
        const rule = op.rule.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
        if (rule.length === 0) {
          return reply.code(400).send({ error: 'invalid_body', message: 'rule is empty after sanitation' });
        }
        spec.rules = [...spec.rules, rule];
      } else if (op.op === 'remove-rule') {
        if (op.index >= spec.rules.length) {
          return reply.code(400).send({ error: 'invalid_body', message: `remove-rule index ${op.index} is out of range (${spec.rules.length} rules)` });
        }
        spec.rules = spec.rules.filter((_r, i) => i !== op.index);
      } else if (op.op === 'set-worth') {
        // Fuel re-derives through the SAME labeled convention generation
        // uses — the dial-honesty rule for money: no fuel number without
        // the worth answer underneath it.
        spec.fuel = { ...spec.fuel, maxUsdPerRun: fuelFromWorth(op.worthUsd) };
        if (spec.mission.kind === 'task') {
          spec.mission = { ...spec.mission, worthPerRunUsd: op.worthUsd };
        }
      } else if (op.op === 'set-checkin-fraction') {
        const idx = spec.checkIns.findIndex((c) => c.trigger === 'on-budget-fraction');
        if (idx === -1) {
          spec.checkIns = [{ trigger: 'on-budget-fraction', fraction: op.fraction }, ...spec.checkIns];
        } else {
          spec.checkIns = spec.checkIns.map((c, i) => (i === idx ? { trigger: 'on-budget-fraction' as const, fraction: op.fraction } : c));
        }
      } else if (op.op === 'declare-superpower') {
        if (!spec.superpowers.some((s) => s.id === op.id)) {
          spec.superpowers = [...spec.superpowers, { id: op.id, scopes: [] }];
          // The generation-time protective default, mirrored: a tool-bearing
          // spec carries the external-action gate.
          if (!spec.checkIns.some((c) => c.trigger === 'before-external-action')) {
            spec.checkIns = [...spec.checkIns, { trigger: 'before-external-action' }];
          }
        }
      } else {
        spec.superpowers = spec.superpowers.filter((s) => s.id !== op.id);
        // Protections are never silently removed: check-ins stay as-is.
      }
    }

    // Closure gate (the motion.ts pattern): the row we emit is the row
    // lab-spec accepts, or the edit is refused — never a broken catalog row.
    const hash = harnessSpecHash(spec);
    const specText = canonicalJson({ ...spec, hash });
    const reparsed = parseHarnessSpecText(specText);
    if (!reparsed.ok) {
      return reply.code(409).send({
        ok: false,
        gap: { code: 'edit-closure-violation', detail: reparsed.issues.map((i) => i.code).join(',') },
      });
    }
    if (hash === row.harnessHash) {
      // A no-op patch is answered honestly, not written.
      return reply.send({ ok: true, harnessHash: hash, unchanged: true });
    }
    // Hash CONVERGENCE (review finding): if the edited spec's content hash
    // already exists as ANOTHER catalog row, that row IS the result —
    // nothing is written, so the existing row's provenance and cluster
    // routing are never overwritten by a convergent edit.
    const existing = await getLabHarness(db, org.orgId, hash);
    if (existing !== null) {
      return reply.send({ ok: true, harnessHash: hash, previousHash: row.harnessHash, unchanged: false, converged: true });
    }
    // Carried provenance, rebound to the new content hash (the dial-motion
    // sidecar discipline).
    const prior = row.sidecar as ChoicesSidecar;
    const sidecar: ChoicesSidecar = {
      specHash: hash,
      choicesHash: sha256(canonicalJson(prior.choices)),
      choices: prior.choices,
    };
    await upsertLabHarness(db, {
      orgId: org.orgId,
      harnessHash: hash,
      name: spec.name,
      specText,
      sidecar,
      clusterId: row.clusterId,
    });
    return reply.send({ ok: true, harnessHash: hash, previousHash: row.harnessHash, unchanged: false });
  });

  // ═══ Step 10 — connectors + token custody ═════════════════════════════════

  const CONNECTOR_ID_RE = /^[a-z0-9-]{1,64}$/;
  const connectorNotConfigured = (id: string) =>
    openAiError(
      `connector '${id}' has no client credentials configured — set its client id/secret env vars`,
      'invalid_request_error',
      'connector_not_configured',
    );

  function connectorEnv(c: ConnectorDef): { clientId: string; clientSecret: string } | null {
    const clientId = process.env[c.oauth.clientIdEnv];
    const clientSecret = process.env[c.oauth.clientSecretEnv];
    if (clientId === undefined || clientId === '' || clientSecret === undefined || clientSecret === '') {
      return null;
    }
    return { clientId, clientSecret };
  }

  function callbackUrlFor(req: FastifyRequest, connectorId: string): string {
    return `${publicBaseUrl(req)}/api/lab/connectors/${connectorId}/oauth/callback`;
  }

  // ---- GET /api/lab/connectors (viewer) — catalog + grant statuses ----
  // Token material is STRUCTURALLY absent: listLabGrants' SELECT excludes
  // the envelope columns, so no field exists here to leak (enforcement 1;
  // the inventory-driven absence sweep re-proves it over the wire).
  // Step 11: the CATALOG is the surface — every package, with its honest
  // tier, its connect posture, its read/act split and least-privilege
  // defaults, alongside the Step 10 grant badge. A package that cannot
  // reach a live wire says so; it is never shown as merely unconfigured.
  app.get('/api/lab/connectors', async (req: FastifyRequest, reply) => {
    const org = req.potionOrg!;
    const grants = await listLabGrants(db, org.orgId);
    // BYO-MCP: the org's own registered endpoints ride the same list, tier
    // 'byo' — honestly labeled as operator-pinned rather than
    // Potion-authored, every tool an act.
    const customRows = await listLabCustomConnectors(db, org.orgId);
    const custom = customRows.map((row) => {
      const grant = grants.find((g) => g.connectorId === row.connectorId) ?? null;
      return {
        connectorId: row.connectorId,
        displayName: row.displayName,
        category: 'your endpoints',
        version: 'byo',
        contentHash: null,
        tier: 'byo' as const,
        connectStatus: 'ready' as const,
        connectNote: null,
        fixtureAgeDays: null,
        scopesOffered: [],
        defaultScopes: [],
        toolCount: { read: 0, act: row.tools.length },
        tools: row.tools.map((t) => ({ name: t.name, action: 'act' as const })).sort((a, b) => (a.name < b.name ? -1 : 1)),
        contextTokens: 0,
        configured: true,
        status: grantConnectionStatus(grant),
        custom: { endpointUrl: row.endpointUrl, serverName: row.serverName, createdBy: row.createdBy },
        grant:
          grant === null
            ? null
            : { scopesGranted: grant.scopesGranted, tokenExpiresAt: grant.tokenExpiresAt, grantedBy: grant.grantedBy, createdAt: grant.createdAt, revokedAt: grant.revokedAt },
      };
    });
    return reply.send({
      custom,
      connectors: CATALOG.map((pkg) => {
        const grant = grants.find((g) => g.connectorId === pkg.id) ?? null;
        const def = toConnectorDef(pkg);
        const withOverrides = def === null ? null : withEndpointOverrides(def);
        const readTools = pkg.tools.filter((t) => t.action === 'read');
        const actTools = pkg.tools.filter((t) => t.action === 'act');
        return {
          connectorId: pkg.id,
          displayName: pkg.displayName,
          category: pkg.category,
          version: pkg.version,
          contentHash: packageContentHash(pkg),
          // Honest tiering (§5) — the proof tier and the connect posture are
          // DIFFERENT claims and both are shown.
          tier: pkg.proof,
          connectStatus: pkg.connect.status,
          connectNote: pkg.connect.status === 'ready' ? null : pkg.connect.note,
          fixtureAgeDays: pkg.fixtureStamp === undefined ? null : fixtureAgeDays(pkg.fixtureStamp),
          scopesOffered: withOverrides?.oauth.scopesOffered ?? [],
          defaultScopes: pkg.defaultScopes,
          toolCount: { read: readTools.length, act: actTools.length },
          tools: pkg.tools.map((t) => ({ name: t.name, action: t.action })).sort((a, b) => (a.name < b.name ? -1 : 1)),
          contextTokens: contextTokens(pkg),
          // connectable ⇔ the package compiles AND its client env is set
          configured: withOverrides !== null && connectorEnv(withOverrides) !== null,
          status: grantConnectionStatus(grant),
          grant:
            grant === null
              ? null
              : {
                  scopesGranted: grant.scopesGranted,
                  tokenExpiresAt: grant.tokenExpiresAt,
                  grantedBy: grant.grantedBy,
                  createdAt: grant.createdAt,
                  revokedAt: grant.revokedAt,
                },
        };
      }),
    });
  });

  // ---- POST /api/lab/connectors/:id/oauth/start (admin) ----
  // Granting a third-party credential is an admin act. PKCE S256 + an
  // ORG-BOUND signed state cookie (the tenancy anchor for the callback).
  // ---- BYO-MCP (the genius door, 2026-08-28) ----
  // Probe: open ONE MCP session against the admin's endpoint, pin the
  // declared surface under caps + custody scans, return it for review.
  // Nothing is stored; the bearer is used for the session and dropped.
  const CustomBodySchema = z
    .object({
      url: z.string().url().max(500),
      bearerToken: z.string().max(4096).optional(),
      slug: z.string().regex(CUSTOM_SLUG_RE).optional(),
      displayName: z.string().min(1).max(80).optional(),
    })
    .strict();

  app.post('/api/lab/connectors/custom/probe', async (req: FastifyRequest, reply) => {
    const org = req.potionOrg!;
    if (!roleAtLeast(org.role, 'admin')) return reply.code(403).send(forbidden(org.role, 'register endpoints'));
    const body = CustomBodySchema.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: 'invalid_body', message: body.error.issues.map((i) => i.message).join('; ') });
    const probed = await probeMcpEndpoint(body.data.url, body.data.bearerToken, opts.probeDeps ?? {});
    if (!probed.ok) return reply.code(422).send({ ok: false, reason: probed.reason });
    return reply.send({ ok: true, surface: probed.surface });
  });

  // Register: RE-probe server-side (the pin is what Potion saw, never a
  // client echo), store the row, seal the bearer into the grants table —
  // the same envelope custody every OAuth token gets. The registering
  // admin is the AUTHOR of the pinned surface (provenance rule).
  app.post('/api/lab/connectors/custom', async (req: FastifyRequest, reply) => {
    const org = req.potionOrg!;
    if (!roleAtLeast(org.role, 'admin')) return reply.code(403).send(forbidden(org.role, 'register endpoints'));
    const body = CustomBodySchema.safeParse(req.body ?? {});
    if (!body.success || body.data.slug === undefined || body.data.displayName === undefined) {
      return reply.code(400).send({ error: 'invalid_body', message: 'url, slug and displayName are required' });
    }
    if (getPackage(body.data.slug) !== null || body.data.slug === 'web' || body.data.slug === 'code') {
      return reply.code(409).send({ error: 'slug_taken', message: `'${body.data.slug}' is a catalog id — pick another slug` });
    }
    const probed = await probeMcpEndpoint(body.data.url, body.data.bearerToken, opts.probeDeps ?? {});
    if (!probed.ok) return reply.code(422).send({ ok: false, reason: probed.reason });
    const stored = await upsertLabCustomConnector(db, {
      orgId: org.orgId,
      connectorId: body.data.slug,
      displayName: body.data.displayName,
      endpointUrl: body.data.url,
      serverName: probed.surface.serverName,
      tools: probed.surface.tools,
      createdBy: actorOf(req),
    });
    if (!stored.ok) return reply.code(422).send({ ok: false, reason: stored.reason });
    await upsertLabGrant(db, {
      id: `grant-${body.data.slug}-${randomUUID().slice(0, 8)}`,
      orgId: org.orgId,
      connectorId: body.data.slug,
      superpowerId: body.data.slug,
      scopesGranted: ['mcp:pinned'],
      // ALWAYS a real envelope — the run leg OPENS this one (unlike web/code,
      // which never reach openGrantToken), so the builtin sentinel would
      // throw CustodyDecryptError mid-leg. '' = no credential, honestly.
      tokenEnvelope: await ctx.custody.encryptKey(body.data.bearerToken ?? ''),
      grantedBy: actorOf(req),
    });
    return reply.code(201).send({ ok: true, connectorId: body.data.slug, tools: probed.surface.tools.length });
  });

  app.delete('/api/lab/connectors/custom/:id', async (req: FastifyRequest, reply) => {
    const org = req.potionOrg!;
    if (!roleAtLeast(org.role, 'admin')) return reply.code(403).send(forbidden(org.role, 'remove endpoints'));
    const { id } = req.params as { id: string };
    if (!CUSTOM_SLUG_RE.test(id)) return reply.code(404).send(notFound);
    const row = await getLabCustomConnector(db, org.orgId, id);
    if (row === null) return reply.code(404).send(notFound);
    await markLabGrantStatus(db, org.orgId, id, 'revoked').catch(() => {});
    await deleteLabCustomConnector(db, org.orgId, id);
    return reply.send({ ok: true });
  });

  app.post('/api/lab/connectors/:id/oauth/start', async (req: FastifyRequest, reply) => {
    const org = req.potionOrg!;
    if (!roleAtLeast(org.role, 'admin')) {
      return reply.code(403).send(forbidden(org.role, 'connect superpowers'));
    }
    const { id } = req.params as { id: string };
    // Step 11: resolve the catalog PACKAGE, then compile it. A package
    // that is not `ready` (unverified endpoint / unauthored OAuth) yields
    // null and the route 404s — unconnectable is structural, not a note.
    const pkgFound = CONNECTOR_ID_RE.test(id) ? getPackage(id) : null;
    // P1: a BUILTIN package has no OAuth to start — no vendor, no
    // credentials. "Connect" is a pure permission grant, minted here
    // directly by an explicit admin act; the envelope column carries a
    // typed placeholder (nothing ever unseals it — builtins never resolve
    // against a connector endpoint) and revoke cuts it like any grant.
    if (pkgFound !== null && pkgFound.connect.status === 'builtin') {
      await upsertLabGrant(db, {
        id: `grant-${pkgFound.id}-${randomUUID().slice(0, 8)}`,
        orgId: org.orgId,
        connectorId: pkgFound.id,
        superpowerId: pkgFound.id,
        scopesGranted: [...pkgFound.defaultScopes],
        tokenEnvelope: 'builtin:no-credential',
        grantedBy: actorOf(req),
      });
      return reply.send({ granted: true });
    }
    const raw = pkgFound === null ? null : toConnectorDef(pkgFound);
    const connector = raw === null ? null : withEndpointOverrides(raw);
    if (connector === null) return reply.code(404).send(notFound);
    const env = connectorEnv(connector);
    if (env === null) return reply.code(400).send(connectorNotConfigured(id));
    const flow = newConnectorFlowState(org.orgId, connector.connectorId);
    reply.header(
      'set-cookie',
      `${CONNECTOR_STATE_COOKIE}=${encodeConnectorState(flow, env.clientSecret)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(CONNECTOR_STATE_TTL_MS / 1000)}`,
    );
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: env.clientId,
      redirect_uri: callbackUrlFor(req, connector.connectorId),
      state: flow.state,
      code_challenge: pkceChallengeS256(flow.verifier),
      code_challenge_method: 'S256',
      ...(connector.oauth.scopesOffered.length > 0
        ? { scope: connector.oauth.scopesOffered.join(' ') }
        : {}),
    });
    return reply.send({
      authorizationUrl: `${connector.oauth.authorizationUrl}?${params.toString()}`,
    });
  });

  // ---- GET /api/lab/connectors/:id/oauth/callback (admin session) ----
  // The access token exists in plaintext ONLY inside this handler's stack
  // frame: exchanged server-side, sealed with the platform master key,
  // stored as an envelope. Never logged, never in a redirect URL, never in
  // a response body — the absence sweep asserts it over the wire.
  app.get('/api/lab/connectors/:id/oauth/callback', async (req: FastifyRequest, reply) => {
    const org = req.potionOrg!;
    if (!roleAtLeast(org.role, 'admin')) {
      return reply.code(403).send(forbidden(org.role, 'finish connecting superpowers'));
    }
    const { id } = req.params as { id: string };
    // Step 11: resolve the catalog PACKAGE, then compile it. A package
    // that is not `ready` (unverified endpoint / unauthored OAuth) yields
    // null and the route 404s — unconnectable is structural, not a note.
    const pkgFound = CONNECTOR_ID_RE.test(id) ? getPackage(id) : null;
    const raw = pkgFound === null ? null : toConnectorDef(pkgFound);
    const connector = raw === null ? null : withEndpointOverrides(raw);
    if (connector === null) return reply.code(404).send(notFound);
    const env = connectorEnv(connector);
    if (env === null) return reply.code(400).send(connectorNotConfigured(id));
    const clearFlowCookie = () =>
      reply.header('set-cookie', `${CONNECTOR_STATE_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
    try {
      const query = req.query as { code?: string; state?: string };
      const cookies = parseCookies(req.headers.cookie);
      const flow = decodeConnectorState(cookies[CONNECTOR_STATE_COOKIE], env.clientSecret);
      if (!query.state || query.state !== flow.state) {
        throw new ConnectorOauthError('connector state mismatch — restart the connect', 400);
      }
      if (flow.connectorId !== connector.connectorId) {
        throw new ConnectorOauthError('connector flow is for a different connector', 400);
      }
      // The TENANCY ANCHOR: the flow was started for exactly one org, and
      // only a live admin session of that org may complete it.
      if (flow.orgId !== org.orgId) {
        throw new ConnectorOauthError('connector flow belongs to a different org', 403);
      }
      if (!query.code) throw new ConnectorOauthError('missing authorization code', 400);

      const tokenRes = await fetch(connector.oauth.tokenUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: query.code,
          client_id: env.clientId,
          client_secret: env.clientSecret,
          redirect_uri: callbackUrlFor(req, connector.connectorId),
          code_verifier: flow.verifier,
        }).toString(),
        signal: AbortSignal.timeout(30_000),
      });
      if (!tokenRes.ok) {
        throw new ConnectorOauthError(`token exchange failed (HTTP ${tokenRes.status})`, 502);
      }
      const token = (await tokenRes.json()) as {
        access_token?: string;
        refresh_token?: string;
        expires_in?: number;
        scope?: string;
        error?: string;
      };
      if (typeof token.access_token !== 'string' || token.access_token === '') {
        throw new ConnectorOauthError(`token exchange refused: ${token.error ?? 'no access_token'}`, 502);
      }
      const scopesGranted =
        typeof token.scope === 'string' && token.scope !== ''
          ? token.scope.split(/[,\s]+/).filter((s) => s !== '')
          : connector.oauth.scopesOffered;
      await upsertLabGrant(db, {
        id: `grant-${randomUUID().replace(/-/g, '').slice(0, 16)}`,
        orgId: org.orgId,
        connectorId: connector.connectorId,
        superpowerId: connector.connectorId,
        scopesGranted,
        tokenEnvelope: await ctx.custody.encryptKey(token.access_token),
        refreshEnvelope:
          typeof token.refresh_token === 'string' && token.refresh_token !== ''
            ? await ctx.custody.encryptKey(token.refresh_token)
            : null,
        tokenExpiresAt:
          typeof token.expires_in === 'number'
            ? new Date(Date.now() + token.expires_in * 1000)
            : null,
        grantedBy: actorOf(req),
      });
      clearFlowCookie();
      const dash = process.env.POTION_DASHBOARD_URL;
      if (dash !== undefined && dash !== '') {
        return reply.redirect(`${dash}/lab`, 302);
      }
      return reply
        .type('text/html')
        .send('<p>Connected. The filament is healed — return to the Lab.</p>');
    } catch (e) {
      clearFlowCookie();
      if (e instanceof ConnectorOauthError) {
        return reply.code(e.statusCode).send(openAiError(e.message, 'invalid_request_error', 'connector_oauth'));
      }
      throw e;
    }
  });

  // ---- POST /api/lab/connectors/:id/revoke (admin) ----
  // Local truth first (typed cut, immediate — the filament shows it), then
  // best-effort provider-side revocation via the worker (the only other
  // legitimate open of a grant, and it opens an already-dead one).
  app.post('/api/lab/connectors/:id/revoke', async (req: FastifyRequest, reply) => {
    const org = req.potionOrg!;
    if (!roleAtLeast(org.role, 'admin')) {
      return reply.code(403).send(forbidden(org.role, 'revoke superpower grants'));
    }
    const { id } = req.params as { id: string };
    if (!CONNECTOR_ID_RE.test(id)) return reply.code(404).send(notFound);
    const grant = await getLabGrant(db, org.orgId, id);
    if (grant === null) return reply.code(404).send(notFound);
    const cut = await markLabGrantStatus(db, org.orgId, id, 'revoked');
    const jobId = await opts.queue.enqueue('lab:grant-revoke', { orgId: org.orgId, connectorId: id });
    return reply.send({ connectorId: id, status: 'revoked', already: !cut, providerRevocationJobId: jobId });
  });

  // ================= L-G3 — the permission ledger (direction v2) =========
  //
  // GET is a pure read of the STORED grants plus an evidence rollup; the
  // evaluation pass (which may auto-tighten — fail closed) runs on the
  // admin POST, which the ledger UI fires on view. Accept is the ONLY
  // loosening path and is org-guarded before it touches the grant.

  /** act/read per tool from the superpower catalog; unknown stays
   * undefined and tiers fail closed downstream. */
  function classifyTool(actionClass: string): 'read' | 'act' | undefined {
    for (const pkg of CATALOG) {
      const tool = pkg.tools.find((t) => t.name === actionClass);
      if (tool) return tool.action;
    }
    return undefined;
  }

  // ---- GET /api/lab/harnesses/:hash/grants (viewer) — the ledger ----
  app.get('/api/lab/harnesses/:hash/grants', async (req: FastifyRequest, reply) => {
    const org = req.potionOrg!;
    const row = await ownHarness(req);
    if (row === null) return reply.code(404).send(notFound);
    const grants = await listActionGrants(db, org.orgId, row.harnessHash);
    const steps = await listLabStepsForHarness(db, org.orgId, row.harnessHash);
    // W2 — the ledger answers WHY with the full evidence taxonomy: the
    // record's pore + autonomous streams merged with outside reports
    // (outcomes, reversals, incidents, audit verdicts), each class typed.
    const reports = await listEvidenceReports(db, org.orgId, row.harnessHash);
    const byClass = mergeEvidence(
      extractPoreEvidence(steps.map((s0) => ({ payload: s0.payload as StepPayload, createdAt: s0.createdAt }))),
      evidenceFromReports(reports.map((r0) => ({ actionClass: r0.actionClass, kind: r0.kind, createdAt: r0.createdAt }))),
    );
    // Pending audit samples: gate-allowed executions marked for review —
    // shown as OPEN questions, never counted as evidence (unanswered says
    // nothing about the agent).
    const auditPending = new Map<string, number>();
    for (const s0 of steps) {
      const g = (s0.payload as StepPayload).gate;
      if (g !== undefined && g.decision === 'allow' && g.audit === true) {
        auditPending.set(g.actionClass, (auditPending.get(g.actionClass) ?? 0) + 1);
      }
    }
    const auditVerdicts = new Map<string, number>();
    for (const r0 of reports) {
      if (r0.kind === 'audit-clean' || r0.kind === 'audit-flagged') {
        auditVerdicts.set(r0.actionClass, (auditVerdicts.get(r0.actionClass) ?? 0) + 1);
      }
    }
    const rollup = (cls: string) => {
      const ev = byClass.get(cls) ?? [];
      const count = (o: string) => ev.filter((e) => e.outcome === o).length;
      return {
        n: ev.length,
        approved: count('approved'),
        edited: count('edited'),
        rejected: count('rejected'),
        validated: count('validated'),
        reversed: count('reversed'),
        execFailed: count('exec-failed'),
        auditSampled: auditPending.get(cls) ?? 0,
        auditJudged: auditVerdicts.get(cls) ?? 0,
        // Diversity (v3): how many distinct input situations the record
        // spans — the ledger shows breadth, not just volume.
        situations: new Set(ev.map((e) => e.situation ?? 'unfingerprinted')).size,
        lastAt: ev.length > 0 ? ev[ev.length - 1]!.at : null,
      };
    };
    // Classes observed in traffic but not yet granted rows appear too — the
    // ledger must show what the harness DOES, not only what was recorded.
    const known = new Set(grants.map((g) => g.actionClass));
    const ungranted = [...byClass.keys()].filter((c) => !known.has(c));
    return reply.send({
      harnessHash: row.harnessHash,
      grants: grants.map((g) => ({
        id: g.id,
        actionClass: g.actionClass,
        riskTier: g.riskTier,
        state: g.state,
        auditRate: g.auditRate,
        stateReason: g.stateReason,
        grantedAt: g.grantedAt,
        revokedAt: g.revokedAt,
        evidence: rollup(g.actionClass),
      })),
      observedUngranted: ungranted.map((c) => ({ actionClass: c, evidence: rollup(c) })),
    });
  });

  // ---- POST /api/lab/harnesses/:hash/grants/evaluate (admin) ----
  app.post(
    '/api/lab/harnesses/:hash/grants/evaluate',
    { preHandler: [requireRole('admin')] },
    async (req: FastifyRequest, reply) => {
      const org = req.potionOrg!;
      const row = await ownHarness(req);
      if (row === null) return reply.code(404).send(notFound);
      const parsedForPass = parseHarnessSpecText(row.specText);
      const result = await runGraduationPass({
        db,
        orgId: org.orgId,
        harnessHash: row.harnessHash,
        classify: classifyTool,
        tierOverrides: constitutionTierOverrides(parsedForPass.ok ? parsedForPass.spec.constitution : undefined),
      });
      return reply.send(result);
    },
  );

  // ---- POST /api/lab/grants/:id/accept (admin) — the ONLY loosening ----
  app.post(
    '/api/lab/grants/:id/accept',
    { preHandler: [requireRole('admin')] },
    async (req: FastifyRequest, reply) => {
      const org = req.potionOrg!;
      const { id } = req.params as { id: string };
      const grant = await getActionGrant(db, org.orgId, id);
      if (grant === null) return reply.code(404).send(notFound);
      const body = z.object({ auditRate: z.number().min(0).max(1).optional() }).safeParse(req.body ?? {});
      if (!body.success) return reply.code(400).send({ error: { message: 'invalid auditRate', type: 'invalid_request_error' } });
      try {
        const updated = await acceptGraduation(db, grant.id, body.data.auditRate !== undefined ? { auditRate: body.data.auditRate } : {});
        return reply.send({ id: updated.id, actionClass: updated.actionClass, state: updated.state, auditRate: updated.auditRate, grantedAt: updated.grantedAt });
      } catch (e) {
        return reply.code(409).send({ error: { message: e instanceof Error ? e.message : 'refused', type: 'invalid_request_error', code: 'never_graduates' } });
      }
    },
  );

  // ════ W3 — generations & proof ════════════════════════════════════════
  // A generation never changes; learning creates DESCENDANTS. These routes
  // are the improve loop: derive proposals from the record, build a
  // candidate generation, rehearse it in shadow, compare, promote with
  // selective trust inheritance. (WORKERS-DIRECTION W3.)

  async function improveSource(req: FastifyRequest): Promise<{ row: NonNullable<Awaited<ReturnType<typeof ownHarness>>>; spec: HarnessSpec; steps: Array<{ runId: string; payload: StepPayload; createdAt: Date }> } | null> {
    const row = await ownHarness(req);
    if (row === null) return null;
    const parsed = parseHarnessSpecText(row.specText);
    if (!parsed.ok) return null;
    const rows = await listLabStepsForHarness(db, req.potionOrg!.orgId, row.harnessHash);
    return { row, spec: parsed.spec, steps: rows.map((x) => ({ runId: x.runId, payload: x.payload as StepPayload, createdAt: x.createdAt })) };
  }

  // ---- GET /api/lab/harnesses/:hash/improvements (viewer) — the inbox ----
  app.get('/api/lab/harnesses/:hash/improvements', async (req: FastifyRequest, reply) => {
    const src = await improveSource(req);
    if (src === null) return reply.code(404).send(notFound);
    return reply.send({ improvements: deriveImprovements(src.spec, src.steps) });
  });

  // ---- POST /api/lab/harnesses/:hash/candidates (admin) — build + rehearse ----
  app.post(
    '/api/lab/harnesses/:hash/candidates',
    { preHandler: [requireRole('admin')] },
    async (req: FastifyRequest, reply) => {
      const src = await improveSource(req);
      if (src === null) return reply.code(404).send(notFound);
      const body = z.object({ improvementId: z.string().min(1).max(64) }).safeParse(req.body ?? {});
      if (!body.success) return reply.code(400).send({ error: { message: 'improvementId required', type: 'invalid_request_error' } });
      const proposal = deriveImprovements(src.spec, src.steps).find((i) => i.id === body.data.improvementId);
      if (proposal === undefined) {
        return reply.code(409).send({ error: { message: 'that proposal is no longer derivable from the record', type: 'invalid_request_error' } });
      }
      // The descendant: new spec, new hash, lineage recorded, typed mutation carried.
      const draft = buildDescendantSpec(src.spec, proposal.mutation);
      const { hash: _drop, ...unhashed } = draft as HarnessSpec & { hash?: string };
      const childHash = harnessSpecHash(unhashed as HarnessSpec);
      const childSpec = { ...unhashed, hash: childHash } as HarnessSpec;
      const reparsed = parseHarnessSpecText(canonicalJson(childSpec));
      if (!reparsed.ok) {
        return reply.code(422).send({ error: { message: `the mutated spec failed validation: ${reparsed.issues[0]?.code}`, type: 'invalid_request_error' } });
      }
      const org = req.potionOrg!;
      const familyId = (await ensureHarnessFamily(db, org.orgId, src.row.harnessHash))!;
      await insertDescendantHarness(db, {
        orgId: org.orgId,
        harnessHash: childHash,
        name: src.row.name,
        specText: canonicalJson(childSpec),
        sidecar: src.row.sidecar,
        clusterId: src.row.clusterId,
        familyId,
        parentHash: src.row.harnessHash,
        generation: ((src.row as { generation?: number }).generation ?? 1) + 1,
        mutation: proposal.mutation,
      });
      // The shadow rehearsal: acts stubbed from the parent's record, reads
      // real, steps excluded from evidence, judged like any completed run.
      const shadowRunId = `run-${randomUUID().slice(0, 8)}`;
      await createLabRun(db, {
        id: shadowRunId, orgId: org.orgId, harnessHash: childHash,
        harnessName: src.row.name, spec: childSpec, shadow: true,
      });
      const jobId = await opts.queue.enqueue('lab:run', { orgId: org.orgId, runId: shadowRunId });
      return reply.code(201).send({ candidateHash: childHash, generation: ((src.row as { generation?: number }).generation ?? 1) + 1, shadowRunId, jobId, mutation: proposal.mutation });
    },
  );

  // ---- GET /api/lab/harnesses/:hash/candidates (viewer) — the comparison ----
  app.get('/api/lab/harnesses/:hash/candidates', async (req: FastifyRequest, reply) => {
    const org = req.potionOrg!;
    const row = await ownHarness(req);
    if (row === null) return reply.code(404).send(notFound);
    const familyId = (row as { familyId?: string | null }).familyId;
    const generations = familyId != null ? await listFamilyGenerations(db, org.orgId, familyId) : [];
    const children = generations.filter((g) => (g as { parentHash?: string | null }).parentHash === row.harnessHash);
    const baseline = await latestCompletedLabRun(db, org.orgId, row.harnessHash);
    const summarize = async (runId: string) => {
      const run = await getLabRun(db, runId, org.orgId);
      if (run === null) return null;
      const steps = await listLabSteps(db, runId, org.orgId);
      const judge = (run as { judge?: { overall?: number } | null }).judge;
      const metered = steps.reduce((a, x) => {
        const sp = x.payload as { costUsd?: number; estCostUsd?: number };
        return a + (sp.costUsd !== undefined && sp.costUsd > 0 ? sp.costUsd : (sp.estCostUsd ?? 0));
      }, 0);
      return {
        runId, state: run.state,
        judgeOverall: typeof judge?.overall === 'number' ? judge.overall : null,
        spentUsd: Number(metered.toFixed(6)),
        steps: steps.length,
        asks: steps.filter((x) => x.kind === 'check-in').length,
      };
    };
    const out = [];
    for (const c of children) {
      // The candidate's shadow run: its most recent run (shadow or not).
      const shadowRun = await latestShadowLabRun(db, org.orgId, c.harnessHash);
      out.push({
        candidateHash: c.harnessHash,
        generation: (c as { generation?: number }).generation ?? 1,
        mutation: (c as { mutation?: unknown }).mutation ?? null,
        supersededParent: (row as { supersededBy?: string | null }).supersededBy === c.harnessHash,
        shadow: shadowRun !== null ? await summarize(shadowRun.id) : null,
        baseline: baseline !== null ? await summarize(baseline.id) : null,
      });
    }
    return reply.send({ candidates: out });
  });

  // ---- POST /api/lab/harnesses/:hash/promote (admin) — the succession ----
  app.post(
    '/api/lab/harnesses/:hash/promote',
    { preHandler: [requireRole('admin')] },
    async (req: FastifyRequest, reply) => {
      const org = req.potionOrg!;
      const row = await ownHarness(req);
      if (row === null) return reply.code(404).send(notFound);
      const body = z.object({ candidateHash: z.string().regex(HASH_RE) }).safeParse(req.body ?? {});
      if (!body.success) return reply.code(400).send({ error: { message: 'candidateHash required', type: 'invalid_request_error' } });
      const child = await getLabHarness(db, org.orgId, body.data.candidateHash);
      if (child === null || (child as { parentHash?: string | null }).parentHash !== row.harnessHash) {
        return reply.code(409).send({ error: { message: 'the candidate is not a descendant of this generation', type: 'invalid_request_error' } });
      }
      const mutation = (child as { mutation?: ImprovementProposal['mutation'] | null }).mutation;
      // Selective trust inheritance v1: the plan says which earned states
      // carry; preserved grants keep situations + grantedAt; re-proving
      // classes start supervised with the reason on the row.
      const parentGrants = await listActionGrants(db, org.orgId, row.harnessHash);
      const plan = mutation != null
        ? inheritGrantPlan(mutation, parentGrants.map((g) => ({ actionClass: g.actionClass, state: g.state, riskTier: g.riskTier })))
        : parentGrants.map((g) => ({ actionClass: g.actionClass, preserve: true, why: 'no recorded mutation — states carry' }));
      for (const g of parentGrants) {
        const p = plan.find((x) => x.actionClass === g.actionClass)!;
        const created = await ensureActionGrant(db, { orgId: org.orgId, harnessHash: child.harnessHash, actionClass: g.actionClass, riskTier: g.riskTier });
        if (p.preserve && g.state === 'autonomous') {
          await inheritGrantState(db, created.id, { state: 'autonomous', auditRate: g.auditRate, situations: (g as { situations?: string[] }).situations ?? [], grantedAt: g.grantedAt, reason: `inherited from generation ${(row as { generation?: number }).generation ?? 1}: ${p.why}` });
        } else if (!p.preserve) {
          await tightenGrant(db, created.id, `re-proving under the new generation: ${p.why}`);
        }
      }
      await markSuperseded(db, org.orgId, row.harnessHash, child.harnessHash);
      return reply.send({ promoted: child.harnessHash, plan });
    },
  );
}
