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
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
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
  listLabMemoryEntries,
  listLabRunsForHarness,
  listLabSteps,
  revokeApiKey,
  setLabMemoryKey,
  upsertLabHarness,
  answerLabRun,
  killLabRun,
} from '@potion/db';
import { canonicalJson } from '@potion/core';
import { loadCurrentFrontier } from '@potion/pareto';
import {
  fuelFromWorth,
  generateSpec,
  type ChoicesSidecar,
  type InterviewAnswers,
  type TaxonomyCluster,
} from '@potion/lab-gen';
import { harnessSpecHash } from '@potion/lab-spec';
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
import { ServingClient, buildRunReport, type StepPayload } from '@potion/lab-runtime';
import {
  getLabGrant,
  grantConnectionStatus,
  listLabGrants,
  markLabGrantStatus,
  upsertLabGrant,
} from '@potion/db';
import { CONNECTORS, getConnector, withEndpointOverrides, type ConnectorDef } from '@potion/lab-mcp';
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
import { actorOf } from './keys.js';
import type { PotionContext } from '../context.js';

export interface LabRoutesOptions {
  queue: PotionQueue;
}

const notFound = openAiError('not found', 'invalid_request_error', 'lab_not_found');

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
    return reply.send({
      harnesses: rows.map((r) => ({
        harnessHash: r.harnessHash,
        name: r.name,
        clusterId: r.clusterId,
        createdAt: r.createdAt,
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
      spec,
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
  app.post('/api/lab/runs', async (req: FastifyRequest, reply) => {
    const org = req.potionOrg!;
    if (!roleAtLeast(org.role, 'member')) {
      return reply.code(403).send(memberForbidden(org.role, 'start trial runs'));
    }
    const body = z.object({ harnessHash: z.string().regex(HASH_RE) }).safeParse(req.body ?? {});
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
    const jobId = await opts.queue.enqueue('lab:run', { orgId: org.orgId, runId });
    return reply.code(202).send({ runId, jobId, state: 'pending' });
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
        excerpt:
          s.kind === 'model'
            ? (p.responseText ?? '').slice(0, 400)
            : s.kind === 'tool'
              ? `${p.toolName}: ${JSON.stringify(p.toolOutput ?? null).slice(0, 400)}`
              : (p.checkInQuestion ?? ''),
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
      steps: stepDtos,
      cost: {
        meteredUsd: meteredTotal,
        estPendingUsd: estPendingTotal,
        // No blended figure EXISTS in this DTO — deliberate (the DoD pin).
      },
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
    const base = process.env.POTION_PUBLIC_URL ?? `http://${req.headers.host ?? 'localhost'}`;
    return `${base}/api/lab/connectors/${connectorId}/oauth/callback`;
  }

  // ---- GET /api/lab/connectors (viewer) — catalog + grant statuses ----
  // Token material is STRUCTURALLY absent: listLabGrants' SELECT excludes
  // the envelope columns, so no field exists here to leak (enforcement 1;
  // the inventory-driven absence sweep re-proves it over the wire).
  app.get('/api/lab/connectors', async (req: FastifyRequest, reply) => {
    const org = req.potionOrg!;
    const grants = await listLabGrants(db, org.orgId);
    return reply.send({
      connectors: CONNECTORS.map((raw) => withEndpointOverrides(raw)).map((c) => {
        const grant = grants.find((g) => g.connectorId === c.connectorId) ?? null;
        return {
          connectorId: c.connectorId,
          displayName: c.displayName,
          scopesOffered: c.oauth.scopesOffered,
          tools: Object.keys(c.toolScopeMap).sort(),
          configured: connectorEnv(c) !== null,
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
  app.post('/api/lab/connectors/:id/oauth/start', async (req: FastifyRequest, reply) => {
    const org = req.potionOrg!;
    if (!roleAtLeast(org.role, 'admin')) {
      return reply.code(403).send(forbidden(org.role, 'connect superpowers'));
    }
    const { id } = req.params as { id: string };
    const raw = CONNECTOR_ID_RE.test(id) ? getConnector(id) : null;
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
    const raw = CONNECTOR_ID_RE.test(id) ? getConnector(id) : null;
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
}
