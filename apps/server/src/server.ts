// buildServer(opts) — the testable Fastify 5 factory (SPEC §8). Assembles
// the boot context (db + migrate → taxonomy centroids + assigner → demo seed
// when empty), registers the routes, and returns the configured instance
// WITHOUT listening (tests drive it via app.inject; src/index.ts listens).
import { aggregateUsage, utcDay } from '@potion/db';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { registerChatRoutes } from './routes/chat.js';
import { registerPolicyRoutes } from './routes/policies.js';
import { registerDashboardRoutes } from './routes/dashboard.js';
import { registerAuthRoutes } from './routes/auth.js';
import { sendEmailFromEnv } from './email.js';
import { dashboardAuthHook } from './auth.js';
import { buildContext, type ContextOptions, type PotionContext } from './context.js';
import { initSentry } from './sentry.js';
// M2 Wave 2 metering (ROADMAP #17/#18) — appended imports (append-only block).
import { registerRateLimiting } from './middleware/ratelimit.js';
import {
  DEMAND_FLUSH_INTERVAL_MS,
  demandLearningEnabled,
  flushDemand,
  refreshDemandOptOut,
} from './demand.js';
import { registerUsageRoutes } from './routes/usage.js';
// M2 Wave 2 key custody + lifecycle (ROADMAP #15/#16) — appended import.
import { registerKeyRoutes } from './routes/keys.js';
import { registerConnectionRoutes } from './routes/connection.js';
import { registerPlanRoutes } from './routes/plan.js';
import { logBootGates } from './boot-report.js';
// ---- M3 #26 observability (m3-observability) — appended imports ----
import {
  REQUEST_ID_HEADER,
  createLoggerOptions,
  genRequestId,
  initObservability,
  observabilityPlugin,
} from '@potion/observability';
// ---- end M3 #26 observability imports ----
// M3 #25 OpenAI parity (m3-openai-parity) — appended import.
import { registerOpenAiParityRoutes } from './routes/openai-parity.js';
// M3 #28 jobs (m3-queue-workers) — appended imports (append-only block).
import { createArtifactStore, type ArtifactStore } from '@potion/artifacts';
import { createQueue, resolveQueueKind, type PotionQueue } from '@potion/queue';
import { registerJobRoutes } from './routes/jobs.js';
import { startPotionWorker, workerModeFromEnv } from './worker-runtime.js';
import type { WorkerHandle } from '@potion/workers';
// ---- M3 #21 shadow (m3-shadow) — appended import ----
import { registerReportRoutes } from './routes/reports.js';
import { registerGuaranteeReportRoutes } from './routes/guarantee-report.js';
// ---- end M3 #21 shadow imports ----
// G1 Outcome API (SPEC §16) — appended import.
import { registerOutcomeRoutes } from './routes/outcomes.js';
// G1 challenger promotion — appended import.
import { registerChallengerRoutes } from './routes/challengers.js';
// G1 randomized incumbent holdout — appended import.
import { registerHoldoutRoutes } from './routes/holdout.js';
// ---- M3 #22 guarantee (m3-guarantee) — appended imports ----
import { registerGuaranteeRoutes } from './routes/guarantee.js';
import { GUARANTEE_EVALUATE_JOB } from './guarantee.js';
// ---- end M3 #22 guarantee imports ----
// ---- M3 #27 HA (m3-ha) — appended import ----
import { checkReadiness } from './readiness.js';
// ---- end M3 #27 HA imports ----
// ---- M4 #31 share (m4-playground) — appended imports ----
import { registerShareRoutes } from './routes/share.js';
import { registerPublicAnswersRoutes } from './routes/public-answers.js';
import { registerLabRuntimeGateRoutes } from './routes/lab-runtime-gate.js';
import { registerPlaygroundRoutes } from './routes/playground.js';
import { registerLearningRoutes } from './routes/learning.js';
import { registerInviteRoutes } from './routes/invites.js';
import { registerSupportRoutes } from './routes/support.js';
import { registerPinRoutes } from './routes/pins.js';
import { registerBillingRoutes } from './routes/billing.js';
// ---- end M4 #31 share imports ----
// ---- M4 #34 enterprise (m4-enterprise) — appended imports ----
import { registerOidcRoutes } from './routes/oidc.js';
import { registerGoogleAuthRoutes } from './routes/google-auth.js';
import { googleConfigFromEnv } from './oidc.js';
import { registerAuditRoutes } from './routes/audit.js';
// ---- end M4 #34 enterprise imports ----
// ---- M4 #33/#35 alerts + budget (m4-alerts-budget) — appended imports ----
import { registerAlertRoutes } from './routes/alerts.js';
import { registerResearchRoutes } from './routes/research.js';
import { registerFrontierNotesClock } from './research-clock.js';
// ---- M5 #36 agent workloads ----
import { registerTraceRoutes } from './routes/traces.js';
// G2 rung 1: discovered org workloads — appended import.
import { registerDiscoveryRoutes } from './routes/discovery.js';
import { registerGenerationRoutes } from './routes/generations.js';
import { registerRubricRoutes } from './routes/rubrics.js';
import { registerCertificationRoutes } from './routes/certifications.js';
import { registerLabRoutes } from './routes/lab.js';
import { registerOperatorRoutes } from './routes/operator.js';
import { registerBudgetRoutes } from './routes/budgets.js';
// ---- end M4 #33/#35 imports ----

/** M4 #35: nightly budget:evaluate cadence (24h, SPEC §13.7). */
export const BUDGET_EVALUATE_INTERVAL_MS = 24 * 3600 * 1000;
/** How often to look for parked runs owed a second ask (the run itself
 * only ever gets one reminder — see lab:parked-reminder). */
const PARKED_REMINDER_SWEEP_MS = 60 * 60 * 1000;
/** …and once this soon after boot, so a restart cannot starve the sweep.
 * Long enough that the worker is consuming before the job lands. */
const PARKED_REMINDER_BOOT_DELAY_MS = 60 * 1000;

/** M4b #37: nightly new-model scan (SPEC §15.2 schedule trigger). */
export const RESEARCH_SCAN_INTERVAL_MS = 24 * 3600 * 1000;
/**
 * S7 L4: nightly autonomous probe — demand picks the next measurement.
 *
 * Enqueued whether or not spending is authorized. With the daily cap unset
 * the job writes a 'refused' ledger row and stops, which is how the loop
 * stays VISIBLE while it is switched off: an idle learning table would
 * otherwise be indistinguishable from a broken one.
 */
export /** The learning period: every six hours, every consenting org gets its bar re-measured under the per-org cap. */
const LEARNING_PERIOD_INTERVAL_MS = 6 * 60 * 60 * 1000;
const LEARNING_PROBE_INTERVAL_MS = 24 * 3600 * 1000;
const USAGE_ROLLUP_INTERVAL_MS = 60 * 60 * 1000;
const USAGE_ROLLUP_FIRST_DELAY_MS = 60 * 1000;
const USAGE_ROLLUP_BACKFILL_DAYS = 7;
/** The provider-drift tripwire — the ONE clocked measurement (workers drift-canary.ts).
 * Weekly, plus a check shortly after boot (idempotent per ISO week, so a
 * redeploy neither double-runs nor loses the week). */
const DRIFT_CANARY_INTERVAL_MS = 7 * 24 * 3600 * 1000;
const DRIFT_CANARY_FIRST_DELAY_MS = 10 * 60 * 1000;
// ---- M5 #36 agent workloads ----
/** Nightly agent-session clustering (SPEC §14.2). */
export const TRACES_CLUSTER_INTERVAL_MS = 24 * 3600 * 1000;
/** Nightly trace-retention purge (SPEC §14.3). */
export const TRACES_PURGE_INTERVAL_MS = 24 * 3600 * 1000;

/** M3 #22: periodic guarantee:evaluate sweep cadence (see the M3 #22 block
 * in buildServer). */
export const GUARANTEE_SWEEP_INTERVAL_MS = 60_000;

export interface BuildServerOptions extends ContextOptions {
  /** Fastify logger option (default: false). */
  logger?: FastifyServerOptions['logger'];
  /** M3 #28: injected job queue (tests). Default: createQueue() — driver
   * precedence: QUEUE_DRIVER > REDIS_URL set > memory (packages/queue). */
  queue?: PotionQueue;
  /** M3 #28: injected artifact store (tests). Default: ARTIFACT_STORE env
   * ('local'|'s3'); unset → no artifacts are written (M2 behavior). */
  artifacts?: ArtifactStore;
  /** BYO-MCP probe deps (tests inject a scripted server + DNS). */
  labProbeDeps?: import('./custom-mcp.js').ProbeDeps;
  /** Sign-in-with-Google config seam. The issuer is a CONSTANT in
   * googleConfigFromEnv — deliberately not operator-supplied, so the Google
   * button can never be pointed at another IdP by an env var. That leaves
   * tests no way to aim the flow at a mock IdP, which is what this is for:
   * an explicit injection point, in code, alongside labProbeDeps. */
  googleAuth?: import('./routes/google-auth.js').GoogleAuthRouteOptions;
}

export async function buildServer(opts: BuildServerOptions = {}): Promise<FastifyInstance> {
  // 13a §1.6: error reporting, one wiring point for server + in-process
  // worker. No-op without SENTRY_DSN — see sentry.ts.
  await initSentry();

  // ---- M3 #26 observability (m3-observability) ----
  // Env-gated: POTION_METRICS=0|false disables the meter + /metrics (default
  // ON); OTEL_EXPORTER_OTLP_ENDPOINT unset → OTel fully off (lazy import,
  // total no-op). `logger:true` callers get the redacting pino config
  // (authorization/cookie/set-cookie never logged); request ids honor the
  // inbound x-request-id header else a uuid, echoed back by the plugin.
  const obsMetricsEnabled =
    process.env.POTION_METRICS !== '0' && process.env.POTION_METRICS !== 'false';
  const obsOtlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  const observability = initObservability({
    serviceName: 'potion-server',
    ...(obsOtlpEndpoint ? { otlpEndpoint: obsOtlpEndpoint } : {}),
    metrics: obsMetricsEnabled,
  });
  // ---- end M3 #26 observability init ----
  const ctx = await buildContext({ ...opts, observability });
  const app = Fastify({
    logger: opts.logger === true ? createLoggerOptions('potion-server') : (opts.logger ?? false),
    genReqId: genRequestId,
    requestIdHeader: REQUEST_ID_HEADER,
  });

  app.decorate('potion', ctx);

  // JSONL uploads for POST /api/workloads (text/plain is built-in).
  app.addContentTypeParser(
    ['application/x-ndjson', 'application/jsonl'],
    { parseAs: 'string' },
    (_req, body, done) => {
      done(null, body);
    },
  );

  app.get('/healthz', () => ({
    ok: true,
    seeded: ctx.seeded,
    // M1a item 3: full embedder identity {mode, model, dims}.
    embedder: ctx.embedderInfo,
    providerMode: ctx.providerMode,
    pricesVersion: ctx.prices.version,
    // P0-2: the assignment cache reports its own bound and hit rate. An
    // operator watching for the OOM this replaced needs entries-vs-cap, and a
    // hit rate rebuilt from request logs cannot see an eviction.
    assignCache: ctx.assignCache.stats(),
  }));

  // ---- M3 #27 HA (m3-ha) ----
  // /readyz (load-balancer probe, SPEC §12.8): 200 only when db ping
  // (`SELECT 1`, 2s timeout) AND queue ping (memory: always ok; bullmq:
  // redis ping) succeed; payload always carries the circuit-breaker summary.
  // Any failed check → 503 with per-check detail. /healthz above stays
  // "process up" (no dependencies) on purpose.
  app.get('/readyz', async (_req, reply) => {
    const report = await checkReadiness(ctx);
    return reply.code(report.ok ? 200 : 503).send(report);
  });
  // ---- end M3 #27 HA readyz ----

  registerChatRoutes(app, ctx);
  registerPolicyRoutes(app, ctx);
  registerDashboardRoutes(app, ctx);

  // ── M2 Wave 2 auth (#14): magic-link session auth + dashboard guard ──────
  // /auth/* routes (request-link / verify / logout / invite / me) and the
  // /api/* guard: session-or-apikey auth + viewer read-only / member write /
  // admin invite RBAC. Dev-mode bypass POTION_DEV_AUTH=1 keeps the pre-auth
  // local-tool behaviour; since P1-2 its DEFAULT is an allow-list — on only
  // when NODE_ENV names a non-production runtime, never merely because
  // NODE_ENV is absent or misspelled. See auth.ts header.
  app.decorateRequest('potionOrg', null);
  app.decorateRequest('potionAuth', null);
  app.addHook('onRequest', dashboardAuthHook(ctx));
  // ONE resolution of the Google config, read by both the routes that use
  // it and the endpoint that advertises it. Deriving it twice is how a
  // "Continue with Google" button ends up pointing at a 404.
  const googleAuthOpts = opts.googleAuth ?? {};
  const googleConfig = googleAuthOpts.config ?? googleConfigFromEnv();
  registerAuthRoutes(app, ctx, { googleEnabled: googleConfig !== null });
  app.log.info({ transport: sendEmailFromEnv().transport }, 'email transport');
  // The 2026-08-27 hardening: every security- and billing-relevant gate
  // reports its RESOLVED state and where that state came from, because a
  // scaffolded-empty variable reads as unset, takes a default nobody chose,
  // and is invisible to any check that tests presence. See boot-report.ts.
  // The queue is RESOLVED by now, so the boot gate reads what this process
  // actually got rather than re-deriving it: an injected queue (tests,
  // embedders) is the caller's to manage and is never the P1-3 black hole.
  logBootGates(app.log, process.env, ctx.providerMode, opts.queue !== undefined ? 'external' : resolveQueueKind());

  // ---- M2 Wave 2 metering (ROADMAP #17/#18): append-only registration ----
  // Rate limiting runs as an onRequest hook matched on routeOptions.url, so
  // it applies to /v1/chat/completions without touching routes/chat.ts.
  // Usage/invoice routes are org-scoped reads over usage_daily + the batch
  // rollup trigger.
  registerRateLimiting(app, ctx);
  registerUsageRoutes(app, ctx);
  // ---- end M2 Wave 2 metering ----

  // ---- M2 Wave 2 key custody + lifecycle (ROADMAP #15/#16): append-only ----
  // Provider-key register/list/audit/rotate/revoke/validate with REAL custody
  // (AES-256-GCM envelope — see src/custody/) and the api_keys lifecycle
  // (named keys, scopes, env, revoke/expiry). The serving path itself lives
  // in context.ts (providersForOrg) + routes/chat.ts.
  registerKeyRoutes(app, ctx);
  // ---- end M2 Wave 2 key custody ----

  // ---- Connect & auto-route (SERVING-ROADMAP S1) ----
  // GET /api/connection + /api/routing-activity: the durable answers to
  // "where do I point traffic" and "did the auto-switch actually route my
  // requests". Reads only — every field comes from state the serving path
  // already wrote. Registered after keys so it sees the same auth hook.
  registerConnectionRoutes(app, ctx);
  // S2: POST /api/plan — "what are you building?" for a customer with no
  // workload. Read-only; applying a choice goes through POST /api/policies.
  registerPlanRoutes(app, ctx);
  // ---- end Connect & auto-route ----

  // ---- M3 #26 observability (m3-observability) ----
  // Direct-attach plugin (NOT app.register): its hooks must see every route
  // on the instance. Counts requests + durations, echoes x-request-id, and
  // exposes GET /metrics (Prometheus text) when metrics are enabled.
  observabilityPlugin(app, { handle: observability, metrics: obsMetricsEnabled });
  // ---- end M3 #26 observability plugin ----

  // ---- M3 #25 OpenAI parity (m3-openai-parity) ----
  // GET /v1/models, POST /v1/embeddings, POST /v1/completions (legacy) — all
  // in src/routes/openai-parity.ts, reusing the §8 chat serving-path helpers.
  // The two SPEND routes here carry the serving protections through the
  // shared seams (security/serving-routes.ts drives rate limiting;
  // routes/budgets.ts enforceBudgetHardStop is the budget gate) — F6.
  // (Chat-completions parity — tools/tool_choice passthrough, streaming
  // usage, error-shape parity — lives in routes/chat.ts + auth.ts +
  // middleware/ratelimit.ts.)
  registerOpenAiParityRoutes(app, ctx);
  // ---- end M3 #25 OpenAI parity ----

  // ---- M3 #28 jobs (m3-queue-workers) ----
  // Queue + worker runtime + job routes (SPEC §12.2). Driver precedence:
  // explicit opt > QUEUE_DRIVER > REDIS_URL set > memory — default memory
  // keeps an M2 deployment byte-identical (worker runs in-process on mock
  // providers). Artifact writes only engage when ARTIFACT_STORE=local|s3
  // (ARTIFACT_DIR for local; S3_ENDPOINT/S3_BUCKET/S3_ACCESS_KEY/S3_SECRET_KEY
  // for s3 — MinIO-compatible, see packages/artifacts).
  const queue = opts.queue ?? createQueue();
  // M4 #33/#35: expose the queue on ctx so routes can emit alerts:dispatch
  // (alerts.ts falls back to in-process dispatch when absent).
  ctx.queue = queue;
  const artifacts =
    opts.artifacts ??
    (process.env.ARTIFACT_STORE === 'local' || process.env.ARTIFACT_STORE === 's3'
      ? createArtifactStore(process.env.ARTIFACT_STORE, {
          ...(process.env.ARTIFACT_DIR !== undefined ? { dir: process.env.ARTIFACT_DIR } : {}),
        })
      : undefined);
  // P1-3: the worker is no longer welded to the server. Unset POTION_WORKER
  // keeps it in-process, which is right on one box; 'off' runs a server that
  // enqueues and never consumes, for a deployment that runs
  // apps/server/dist/worker.js as its own process. Node has ONE event loop:
  // measured here, loop lag while idle maxed at 2ms and loop lag during a
  // single in-process job maxed at 1188ms — every in-flight request, streaming
  // included, frozen for the duration.
  const workerMode = workerModeFromEnv();
  const worker =
    workerMode === 'in-process'
      ? await startPotionWorker({
          ctx,
          queue,
          artifacts,
          meter: observability.meter,
          log: (m: string) => app.log.warn(m),
        })
      : null;
  app.decorate('potionWorker', worker);
  registerJobRoutes(app, ctx, { queue });
  app.addHook('onClose', async () => {
    // The worker owns the queue's consumer side and closes it on the way out.
    // With the worker OFF nothing else would: the queue is still ours (routes
    // and the guarantee sweep enqueue on it), so the server closes it itself.
    if (worker !== null) await worker.close(); // drains in-flight jobs, then closes the queue
    else await queue.close();
  });
  // ---- end M3 #28 jobs ----

  // ---- M3 #22 guarantee (m3-guarantee) ----
  // Quality guarantee (SPEC §12.5): the status/resolve read surface +
  // the periodic breach sweep. GET /api/guarantee/status (org-scoped
  // per-policy rolling quality + breaches) and POST /api/incidents/:id/resolve
  // (admin). The sweep re-evaluates guarantee-carrying policies every
  // GUARANTEE_SWEEP_INTERVAL_MS via the queue's guarantee:evaluate job —
  // staleness:scan-adjacent; the per-sample evaluation in routes/chat.ts is
  // the primary trigger, the sweep catches windows that go quiet. The timer
  // is unref'd (never keeps the process alive) and cleared on close; a
  // sweep failure is logged, never thrown.
  registerGuaranteeRoutes(app, ctx);
  const guaranteeSweep = setInterval(() => {
    queue.enqueue(GUARANTEE_EVALUATE_JOB, {}).catch((err: unknown) => {
      app.log.warn(err, 'guarantee sweep enqueue failed — swallowed');
    });
  }, GUARANTEE_SWEEP_INTERVAL_MS);
  guaranteeSweep.unref();
  app.addHook('onClose', () => {
    clearInterval(guaranteeSweep);
  });
  // ---- end M3 #22 guarantee ----

  // ---- M3 #21 shadow (m3-shadow) ----
  // Shadow mode (SPEC §12.4): the savings-report read surface.
  //   GET /api/reports/savings[.csv]?from&to — org-scoped projection of the
  //   shadow_results evidence (migration 0007) against the live request_logs
  //   usage rollup. The serving-path shadow trigger itself lives in
  //   routes/chat.ts (fire-and-forget after the response) + src/shadow.ts.
  registerReportRoutes(app, ctx);
  registerGuaranteeReportRoutes(app, ctx);
  // ---- end M3 #21 shadow ----
  // G1 Outcome API: POST /v1/outcomes — ground-truth signals from the
  // customer's own application, attached at ingest to the served request.
  registerOutcomeRoutes(app, ctx);
  // G1 challenger promotion: proposals list + one-button apply (mints the
  // org frontier from the same-suite measurements — never routes by fiat).
  registerChallengerRoutes(app, ctx);
  // G1 randomized incumbent holdout: consent-gated settings; the serving
  // swap itself lives in routes/chat.ts + routing/holdout.ts.
  registerHoldoutRoutes(app, ctx);

  // ---- M4 #31 share (m4-playground) ----
  // Playground + share links (SPEC §13.3): POST/GET /api/share + admin
  // revoke are org-scoped via the dashboard auth hook; the PUBLIC read
  // surface (/api/public/share/:token/frontier|report) is session-free BY
  // CONTRACT — the share token IS the credential (sha256 at rest, revocable;
  // see the /api/public/ exemption in auth.ts). POST /api/playground/chat
  // executes a chosen frontier point directly, org-scoped, SSE-streamed.
  registerShareRoutes(app, ctx);
  registerPublicAnswersRoutes(app, ctx);
  registerLabRuntimeGateRoutes(app, ctx);
  registerPlaygroundRoutes(app, ctx);
  registerLearningRoutes(app, ctx, { queue });
  registerInviteRoutes(app, ctx);
  registerSupportRoutes(app, ctx);
  registerPinRoutes(app, ctx);
  registerBillingRoutes(app, ctx);
  // ---- end M4 #31 share ----
  // ---- M4 #34 enterprise (m4-enterprise) ----
  // SSO + audit export (SPEC §13.6). OIDC routes self-gate: without the full
  // POTION_OIDC_* env quartet they are NEVER registered (404 — magic-link
  // stays the byte-identical M2 default). The audit surface is admin-only
  // (requireRole) over /api/*, so the dashboard auth hook attaches the org
  // context first: GET /api/audit (recent 100) + GET /api/audit/export.jsonl
  // (bounded 92-day JSONL stream, custody + auth + incident chronology).
  registerOidcRoutes(app, ctx);
  // Sign in with Google (2026-09-04) — self-gating on
  // POTION_GOOGLE_CLIENT_ID/SECRET the same way the OIDC quartet gates
  // above. The BROWSER half of this flow lives in the dashboard, because
  // the session cookie has to land on the dashboard's origin; see
  // routes/google-auth.ts for the split and why.
  registerGoogleAuthRoutes(app, ctx, googleConfig !== null ? { config: googleConfig } : {});
  registerAuditRoutes(app, ctx);
  // ---- end M4 #34 enterprise ----
  // ---- M4 #33/#35 alerts + budget (m4-alerts-budget) ----
  // Alert rules CRUD + test delivery (SPEC §13.5) and budget GET/PUT +
  // state read (SPEC §13.7). The serving-path hard-stop check lives in
  // routes/chat.ts (M4 #35 block); the nightly sweep below drives the
  // z-score anomaly / forecast / warn-crossing detections.
  registerAlertRoutes(app, ctx);
  registerBudgetRoutes(app, ctx);
  // ---- M4b #37/#32 autoresearcher + leaderboard ----
  // Research surface (SPEC §15.5): scan trigger, cycle ledger, the recipe
  // library + single-recipe evaluation (admin), and the PUBLIC leaderboard
  // (§13.4 — session-free by contract, live-provenance only, honest empty
  // state pre-M1b). The nightly scan below drives new-model detection; the
  // scan handler fans out research:cycle jobs per new alias.
  registerResearchRoutes(app, ctx, { queue });
  // F4 (docs/RESEARCH-OPS.md): the Frontier Notes clock — the Tuesday
  // draft→verify→gate→publish chain as a 60s in-process tick (the reaper's
  // pattern; the single-worker queue must never be awaited from a job).
  // Armed only when POTION_RESEARCH_* env is set.
  registerFrontierNotesClock(app, ctx, { queue });
  const researchScan = setInterval(() => {
    queue.enqueue('research:scan', {}).catch((err: unknown) => {
      app.log.warn(err, 'research scan enqueue failed — swallowed');
    });
  }, RESEARCH_SCAN_INTERVAL_MS);
  researchScan.unref();
  app.addHook('onClose', () => {
    clearInterval(researchScan);
  });
  // ---- end M4b #37/#32 ----
  // ---- M5 #36 agent workloads ----
  // Trace surface (SPEC §14.1/§14.3): /v1/traces ingest, session rollup +
  // waterfall, retention setting, manual clustering trigger. Nightly: the
  // purge enforces trace_retention_days (0 = metadata only); clustering runs
  // BEFORE the purge so retention-0 orgs still get clustered from payloads
  // that are about to be redacted (purge redacts, never blocks clustering).
  registerTraceRoutes(app, ctx, { queue });
  // G2 rung 1: discovered org workloads — observed structure + refresh.
  registerDiscoveryRoutes(app, ctx, { queue });
  registerGenerationRoutes(app, ctx);
  // G1.5: per-cluster rubric review surface (generate/list/approve/reject).
  registerRubricRoutes(app, ctx, { queue });
  registerCertificationRoutes(app, ctx, { queue });
  // Lab Step 8: the novice loop surface (/api/lab/*) — interview → catalog →
  // dial/felt → trial runs → report/memory. Every row in ROUTE_INVENTORY.
  registerLabRoutes(app, ctx, { queue, ...(opts.labProbeDeps !== undefined ? { probeDeps: opts.labProbeDeps } : {}) });
  // G2.7: operator surface (create/list/delete orgs + jobs mirror) —
  // fail-closed POTION_OPERATOR_TOKEN bearer, outside the /api auth hook.
  registerOperatorRoutes(app, ctx, { queue });
  const tracesCluster = setInterval(() => {
    queue.enqueue('traces:cluster', {}).catch((err: unknown) => {
      app.log.warn(err, 'traces cluster enqueue failed — swallowed');
    });
  }, TRACES_CLUSTER_INTERVAL_MS);
  tracesCluster.unref();
  app.addHook('onClose', () => {
    clearInterval(tracesCluster);
  });
  const tracesPurge = setInterval(() => {
    queue.enqueue('traces:purge', {}).catch((err: unknown) => {
      app.log.warn(err, 'traces purge enqueue failed — swallowed');
    });
  }, TRACES_PURGE_INTERVAL_MS);
  tracesPurge.unref();
  app.addHook('onClose', () => {
    clearInterval(tracesPurge);
  });
  // ---- end M5 #36 ----
  // ---- S7 L2: demand learning ----
  // The serve path accumulates in memory; this drains it. On close it drains
  // one last time, so a graceful shutdown does not throw away the window.
  if (demandLearningEnabled()) {
    void refreshDemandOptOut(ctx).catch((err: unknown) => {
      app.log.warn(err, 'demand opt-out load failed — swallowed');
    });
    const demandFlush = setInterval(() => {
      void flushDemand(ctx)
        .then((report) => {
          if (report.dropped > 0) {
            // The cell cap turned observations away: this window UNDER-counts
            // demand. Said out loud, because a bound nobody can see reads as
            // "that demand never happened".
            app.log.warn(
              { dropped: report.dropped },
              'demand accumulator hit its cell cap — window under-counts',
            );
          }
        })
        .catch((err: unknown) => {
          app.log.warn(err, 'demand flush failed — window dropped');
        });
    }, DEMAND_FLUSH_INTERVAL_MS);
    demandFlush.unref();
    app.addHook('onClose', async () => {
      clearInterval(demandFlush);
      await flushDemand(ctx).catch((err: unknown) => {
        app.log.warn(err, 'final demand flush failed — window dropped');
      });
    });

    const learningPeriod = setInterval(() => {
      queue.enqueue('learning:period', {}).catch((err: unknown) => {
        app.log.warn(err, 'learning period enqueue failed — swallowed');
      });
    }, LEARNING_PERIOD_INTERVAL_MS);
    learningPeriod.unref();
    app.addHook('onClose', () => {
      clearInterval(learningPeriod);
    });
    const driftCanary = () => {
      queue.enqueue('drift:canary', {}).catch((err: unknown) => {
        app.log.warn(err, 'drift canary enqueue failed — swallowed');
      });
    };
    const driftFirst = setTimeout(driftCanary, DRIFT_CANARY_FIRST_DELAY_MS);
    driftFirst.unref();
    const driftWeekly = setInterval(driftCanary, DRIFT_CANARY_INTERVAL_MS);
    driftWeekly.unref();
    app.addHook('onClose', () => {
      clearTimeout(driftFirst);
      clearInterval(driftWeekly);
    });
    const learningProbe = setInterval(() => {
      queue.enqueue('learning:probe', {}).catch((err: unknown) => {
        app.log.warn(err, 'learning probe enqueue failed — swallowed');
      });
    }, LEARNING_PROBE_INTERVAL_MS);
    learningProbe.unref();
    app.addHook('onClose', () => {
      clearInterval(learningProbe);
    });
  }

  // USAGE ROLLUP ON A CLOCK (2026-09-11). usage_daily — what invoices, the
  // per-day usage page and the weekly brief read — was only ever written by
  // the aggregate-usage CLI, the invoice route and an admin POST; nothing
  // scheduled it, so it stopped at whatever day someone last looked (found
  // 2026-09-11: 09-06 for one org, 09-02 for the rest). Hourly, idempotent
  // (full-replace upsert per org/day/cluster), over a trailing window so a
  // late-landing row or a restart gap is repaired without anyone noticing.
  const rollUpUsage = () => {
    const toDay = utcDay();
    const from = new Date(`${toDay}T00:00:00Z`);
    from.setUTCDate(from.getUTCDate() - USAGE_ROLLUP_BACKFILL_DAYS);
    const fromDay = from.toISOString().slice(0, 10);
    aggregateUsage(ctx.db.db, { fromDay, toDay }).catch((err: unknown) => {
      app.log.warn(err, 'usage rollup failed — swallowed, next hour retries');
    });
  };
  const rollupFirst = setTimeout(rollUpUsage, USAGE_ROLLUP_FIRST_DELAY_MS);
  rollupFirst.unref();
  const usageRollup = setInterval(rollUpUsage, USAGE_ROLLUP_INTERVAL_MS);
  usageRollup.unref();
  app.addHook('onClose', () => {
    clearTimeout(rollupFirst);
    clearInterval(usageRollup);
  });
  // ---- end S7 L2/L4 ----
  // ---- the second ask (2026-09-05) ----
  // A run parked on a person mails once and then goes silent; on production
  // one has waited since 2026-08-31 because that single mail was missed.
  // Hourly so the reminder lands close to its 24-hour mark; the sweep is
  // one indexed read over a partial index and does nothing when nothing is
  // due. `sendNotify` is left default so it resolves the Resend transport
  // from env exactly as the run-event notification does.
  const enqueueParkedReminder = () => {
    queue.enqueue('lab:parked-reminder', {}).catch((err: unknown) => {
      app.log.warn(err, 'parked reminder enqueue failed — swallowed');
    });
  };
  // ONCE SHORTLY AFTER BOOT, THEN HOURLY (2026-09-05, found while verifying
  // it on production). A bare setInterval restarts its clock with the
  // process, so on a box that is deployed more often than the interval the
  // tick NEVER ARRIVES — and this box was redeployed four times in the hour
  // I spent waiting for the first one. For the other sweeps a missed tick
  // is deferred work; for this one it is a person who is never told, which
  // is the entire defect it was written to fix.
  //
  // Running at every boot is safe by construction rather than by luck:
  // reminded_at is claimed before the mail and only by the writer that wins
  // the NULL guard, so a hundred restarts still produce at most one email
  // per parked run. That property is why the stamp exists.
  const parkedReminderKick = setTimeout(enqueueParkedReminder, PARKED_REMINDER_BOOT_DELAY_MS);
  parkedReminderKick.unref();
  const parkedReminder = setInterval(enqueueParkedReminder, PARKED_REMINDER_SWEEP_MS);
  parkedReminder.unref();
  app.addHook('onClose', () => {
    clearTimeout(parkedReminderKick);
    clearInterval(parkedReminder);
  });

  const budgetSweep = setInterval(() => {
    queue.enqueue('budget:evaluate', {}).catch((err: unknown) => {
      app.log.warn(err, 'budget sweep enqueue failed — swallowed');
    });
  }, BUDGET_EVALUATE_INTERVAL_MS);
  budgetSweep.unref();
  app.addHook('onClose', () => {
    clearInterval(budgetSweep);
  });
  // ---- end M4 #33/#35 alerts + budget ----

  app.addHook('onClose', async () => {
    await observability.shutdown(); // M3 #26: drain the OTel SDK when active
    await ctx.cacheInvalidation.close(); // M3 #27: drop redis pub/sub connections
    if (!ctx.externalDb) await ctx.db.close();
  });

  return app;
}

declare module 'fastify' {
  interface FastifyInstance {
    potion: PotionContext;
    /**
     * P1-3: the in-process worker, or null when POTION_WORKER=off and jobs are
     * consumed by a separate process. Surfaced rather than hidden so a
     * deployment can ASSERT what this process is doing instead of assuming it
     * — the same reason WorkerHandle carries researchScanIntervalHours.
     */
    potionWorker: WorkerHandle | null;
  }
}
