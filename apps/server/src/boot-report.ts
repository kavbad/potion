// THE BOOT GATE REPORT (2026-09-02) — the hardening queued after the
// 2026-08-27 production incident, finally built.
//
// WHAT HAPPENED. `POTION_SELF_SERVE=` was scaffolded EMPTY in .env.prod.
// Empty matches neither '1' nor '0', so the gate fell through to its
// default and read OFF in production. New-account sign-in emails then
// stopped silently — by design, the anti-enumeration path returns a
// neutral 200 for unknown addresses — and nothing anywhere said the gate
// was off. The incident note recorded the class: **.env.prod carries
// scaffolded-empty flags that read as silent-off; check VALUES, not
// presence.**
//
// WHAT THIS DOES. At boot, every gate that changes security or billing
// behaviour reports three things: its resolved STATE, where that state
// came from (an explicit value, or a default because the variable was
// unset or empty), and — for the combinations that are dangerous — a
// warning loud enough to read in a deploy log.
//
// The distinction that matters is `empty` vs `unset`. Both take the
// default, but `empty` means a human wrote the variable and left it
// blank, which is nearly always a mistake and is invisible to any check
// that tests presence. Those are called out by name.
import type { FastifyBaseLogger } from 'fastify';

export type GateSource = 'explicit' | 'default-unset' | 'default-empty';

export interface GateReport {
  name: string;
  /** The resolved behaviour, as a word an operator can act on. */
  state: string;
  source: GateSource;
  /** Set when this gate, in this state, deserves attention in the log. */
  warn?: string;
  /**
   * Set when this gate, in this state, means the process MUST NOT serve.
   *
   * The 2026-08-27 incident class in one word: a gate that reported its state
   * and did nothing about it. A warning in a deploy log is only read by
   * someone already looking. `fatal` is read by the process — it exits
   * non-zero, and a server that cannot be secure never takes the port.
   */
  fatal?: string;
}

/** Where a gate's value came from — the empty/unset split is the point. */
import { googleConfigFromEnv } from './oidc.js';
// The REAL resolver, not a second copy of the rule. This file used to
// re-implement `devAuthBypassEnabled`'s logic inline, which meant the boot log
// and the running server could disagree about whether authentication was on —
// and the log is the only place anyone would ever look.
import { devAuthBypassEnabled } from './auth.js';
import { resolveQueueKind } from '@potion/queue';
import { workerModeFromEnv, workerModeIsUnrecognized } from './worker-runtime.js';

export function sourceOf(raw: string | undefined): GateSource {
  if (raw === undefined) return 'default-unset';
  if (raw.trim() === '') return 'default-empty';
  return 'explicit';
}

export interface BootEnvView {
  NODE_ENV?: string | undefined;
  POTION_SELF_SERVE?: string | undefined;
  POTION_MAGIC_LINK_IN_RESPONSE?: string | undefined;
  POTION_DEV_AUTH?: string | undefined;
  STRIPE_SECRET_KEY?: string | undefined;
  REDIS_URL?: string | undefined;
  SENTRY_DSN?: string | undefined;
  POTION_PUBLIC_URL?: string | undefined;
  POTION_OPERATOR_TOKEN?: string | undefined;
  POTION_GOOGLE_CLIENT_ID?: string | undefined;
  POTION_GOOGLE_CLIENT_SECRET?: string | undefined;
  POTION_GOOGLE_REDIRECT_URI?: string | undefined;
  POTION_APP_URL?: string | undefined;
  POTION_METRICS?: string | undefined;
  POTION_WORKER?: string | undefined;
  QUEUE_DRIVER?: string | undefined;
}

const truthy = (v: string | undefined): boolean => v === '1' || v?.toLowerCase() === 'true';

/**
 * Build the report. Pure over the environment view + resolved provider
 * mode, so the dangerous combinations are asserted in tests rather than
 * discovered in production.
 */
export function bootGateReport(
  env: BootEnvView,
  providerMode: 'live' | 'mock',
  /**
   * The RESOLVED queue, not a second guess at it. 'external' means the caller
   * injected its own queue (tests, embedders) and owns whether it is shared.
   * Omitted → resolved from `env` by @potion/queue's own precedence.
   */
  queueKind: 'memory' | 'bullmq' | 'external' = resolveQueueKind(env as NodeJS.ProcessEnv),
): GateReport[] {
  const isProd = env.NODE_ENV === 'production';
  const devAuthRaw = env.POTION_DEV_AUTH;
  const devAuth = devAuthBypassEnabled(env as NodeJS.ProcessEnv);

  const selfServeRaw = env.POTION_SELF_SERVE;
  const selfServe = selfServeRaw === '1' ? true : selfServeRaw === '0' ? false : devAuth;
  const magicLink = truthy(env.POTION_MAGIC_LINK_IN_RESPONSE);

  const rows: GateReport[] = [];

  // ---- the incident's own gate ----
  rows.push({
    name: 'POTION_SELF_SERVE',
    state: selfServe ? 'signup OPEN — any email provisions an org' : 'signup CLOSED — orgs are operator-created only',
    source: sourceOf(selfServeRaw),
    ...(sourceOf(selfServeRaw) === 'default-empty'
      ? {
          warn:
            `set but EMPTY — it is being ignored and the gate defaulted to ` +
            `${selfServe ? 'OPEN' : 'CLOSED'}. This exact shape silently broke ` +
            `new-account sign-in on 2026-08-27. Write 1 or 0.`,
        }
      : {}),
  });

  // ---- the combination that hands out sessions ----
  rows.push({
    name: 'POTION_MAGIC_LINK_IN_RESPONSE',
    state: magicLink ? 'ON — sign-in links are returned in the HTTP response' : 'off',
    source: sourceOf(env.POTION_MAGIC_LINK_IN_RESPONSE),
    ...(magicLink && selfServe && isProd
      ? {
          fatal:
            'DANGEROUS COMBINATION IN PRODUCTION: with self-serve signup ALSO open, ' +
            'anyone who can reach /auth/request-link can mint a session as ANY email ' +
            'address. Unset POTION_MAGIC_LINK_IN_RESPONSE or close POTION_SELF_SERVE.',
        }
      : magicLink && selfServe
      ? {
          warn:
            'DANGEROUS COMBINATION: with self-serve signup ALSO open, anyone who ' +
            'can reach /auth/request-link can mint a session as ANY email address. ' +
            'Acceptable only on a closed test box — never on a reachable deployment.',
        }
      : magicLink && isProd
        ? { warn: 'returning sign-in links in responses while NODE_ENV=production' }
        : {}),
  });

  rows.push({
    name: 'POTION_DEV_AUTH',
    state: devAuth ? 'bypass ON — unauthenticated requests resolve to a dev org' : 'bypass off',
    source: sourceOf(devAuthRaw),
    // FATAL, not a warning (P1-2 / HARDENING-PLAN P2.1). Reaching this state
    // now takes an explicit POTION_DEV_AUTH=1 next to NODE_ENV=production —
    // somebody typed both — so there is no reading of it under which serving
    // anonymous admin access to every dashboard route is the right move.
    ...(devAuth && isProd
      ? {
          fatal:
            'AUTH BYPASS IS ON IN PRODUCTION — every dashboard route would be effectively ' +
            'public: unauthenticated /api/* resolves to the default org as admin. ' +
            'Unset POTION_DEV_AUTH (it defaults OFF) or set it to 0.',
        }
      : {}),
  });

  // ---- money ----
  // ---- P1-3: where the job handlers run, and whether anything runs them ----
  const workerMode = workerModeFromEnv(env as NodeJS.ProcessEnv);
  const driver = queueKind;
  rows.push({
    name: 'POTION_WORKER',
    state:
      workerMode === 'in-process'
        ? `jobs run IN the server process (${driver} queue) — one event loop for serving and background work`
        : `jobs run ELSEWHERE (${driver} queue) — this process enqueues only`,
    source: sourceOf(env.POTION_WORKER),
    // A server that consumes nothing, on a queue nobody else can reach, is a
    // silent black hole: every research cycle, guarantee sweep and alert
    // dispatch is accepted and never runs, and nothing anywhere errors. The
    // memory driver is PROCESS-LOCAL, so this combination cannot be rescued
    // by starting a worker beside it.
    ...(workerMode === 'off' && driver === 'memory'
      ? {
          fatal:
            'POTION_WORKER=off with the MEMORY queue driver: jobs would be enqueued into a ' +
            'process-local queue that nothing consumes and no other process can reach — ' +
            'silently dropped, forever. Set REDIS_URL (or QUEUE_DRIVER=bullmq) so a ' +
            'standalone worker can share the queue, or leave POTION_WORKER unset.',
        }
      : workerModeIsUnrecognized(env as NodeJS.ProcessEnv)
        ? {
            warn:
              `POTION_WORKER=${JSON.stringify(env.POTION_WORKER)} is not a value this build ` +
              `understands — defaulted to in-process. Write 'off' or leave it unset.`,
          }
        : {}),
  });

  rows.push({
    name: 'STRIPE_SECRET_KEY',
    state: sourceOf(env.STRIPE_SECRET_KEY) === 'explicit'
      ? 'stripe transport — invoices CAN take real money'
      : 'ledger transport — charges are recorded, never collected',
    source: sourceOf(env.STRIPE_SECRET_KEY),
    ...(sourceOf(env.STRIPE_SECRET_KEY) === 'default-empty'
      ? { warn: 'set but EMPTY — billing silently falls back to the ledger transport and collects nothing.' }
      : {}),
  });

  // ---- the F18 class: a limiter that multiplies with replicas ----
  rows.push({
    name: 'REDIS_URL',
    state: sourceOf(env.REDIS_URL) === 'explicit'
      ? 'shared Redis rate limiter — buckets span replicas and survive rollouts'
      : 'in-memory rate limiter — per process',
    source: sourceOf(env.REDIS_URL),
    ...(sourceOf(env.REDIS_URL) !== 'explicit' && isProd
      ? {
          warn:
            'in-memory limiter in production: SAFE ONLY AT ONE REPLICA. With N ' +
            'replicas every contracted rate and daily cap becomes N×, and a ' +
            'rollout resets every bucket (F18).',
        }
      : {}),
  });

  // ---- what the compiler will actually call ----
  rows.push({
    name: 'provider mode',
    state: providerMode === 'live' ? 'LIVE — real providers, real spend' : 'mock — no external calls, no spend',
    source: 'explicit',
    ...(providerMode === 'mock' && isProd
      ? { warn: 'MOCK PROVIDERS IN PRODUCTION — served answers are simulated.' }
      : {}),
  });

  rows.push({
    name: 'POTION_PUBLIC_URL',
    state: sourceOf(env.POTION_PUBLIC_URL) === 'explicit' ? 'pinned' : 'derived per request',
    source: sourceOf(env.POTION_PUBLIC_URL),
    ...(sourceOf(env.POTION_PUBLIC_URL) !== 'explicit' && isProd
      ? { warn: 'unpinned behind a proxy, magic links and snippets can name the wrong host.' }
      : {}),
  });

  rows.push({
    name: 'POTION_OPERATOR_TOKEN',
    state: sourceOf(env.POTION_OPERATOR_TOKEN) === 'explicit' ? 'set — operator routes reachable' : 'unset — operator routes fail closed',
    source: sourceOf(env.POTION_OPERATOR_TOKEN),
  });

  // Sign in with Google is a PAIR, and half a pair is the exact failure this
  // file was written for: paste the client id, miss the secret, and the
  // button silently never appears — with nothing anywhere saying why.
  const gId = sourceOf(env.POTION_GOOGLE_CLIENT_ID);
  const gSecret = sourceOf(env.POTION_GOOGLE_CLIENT_SECRET);
  const googleOn = gId === 'explicit' && gSecret === 'explicit';
  const googleHalf = (gId === 'explicit') !== (gSecret === 'explicit');
  // PRINT THE EXACT URI, do not let anyone infer it (2026-09-05). Google
  // matches redirect_uri EXACTLY and answers a mismatch with
  // redirect_uri_mismatch at the first click. The URI is DERIVED from
  // POTION_APP_URL, so a doc that spells it out is a doc that is wrong the
  // moment that variable differs from what the doc's author assumed — which
  // is exactly what happened here: the runbook said withpotion.com while
  // this box had POTION_APP_URL=https://app.withpotion.com. Resolved by the
  // SAME reader the routes use, so the log and the flow cannot disagree.
  const googleRedirect = googleConfigFromEnv(env as NodeJS.ProcessEnv)?.redirectUri;
  rows.push({
    name: 'sign in with Google',
    state: googleOn
      ? `on — the button is drawn; register this redirect URI at Google, exactly: ${googleRedirect ?? '(unresolved — set POTION_APP_URL)'}`
      : googleHalf
        ? 'OFF — only half the pair is set'
        : 'off — email link only',
    source: googleOn ? 'explicit' : gId,
    ...(googleHalf
      ? {
          warn: `half-configured: client id ${gId === 'explicit' ? 'set' : 'missing'}, secret ${
            gSecret === 'explicit' ? 'set' : 'missing'
          } — the button will not appear.`,
        }
      : {}),
  });

  rows.push({
    name: 'SENTRY_DSN',
    state: sourceOf(env.SENTRY_DSN) === 'explicit' ? 'error reporting on' : 'error reporting off',
    source: sourceOf(env.SENTRY_DSN),
    ...(sourceOf(env.SENTRY_DSN) === 'default-empty'
      ? { warn: 'set but EMPTY — errors are going nowhere.' }
      : {}),
  });

  return rows;
}

/** Anything an operator should not scroll past. */
export function bootWarnings(rows: GateReport[]): GateReport[] {
  return rows.filter((r) => r.warn !== undefined);
}

/** Anything the PROCESS should not start past. */
export function bootFatals(rows: GateReport[]): GateReport[] {
  return rows.filter((r) => r.fatal !== undefined);
}

/**
 * Thrown instead of exiting, so the refusal is testable and so an embedder
 * (tests, the CLI) decides what a refusal means. `index.ts` turns it into a
 * non-zero exit; nothing catches it and continues.
 */
export class BootRefusedError extends Error {
  constructor(readonly gates: GateReport[]) {
    super(
      `refusing to serve — ${gates.length} fatal gate${gates.length === 1 ? '' : 's'}: ` +
        gates.map((g) => `${g.name}: ${g.fatal}`).join(' | '),
    );
    this.name = 'BootRefusedError';
  }
}

/**
 * Emit the report. Warnings go at WARN so they survive a log level that
 * drops info, and each names the variable so the fix is unambiguous.
 */
export function logBootGates(
  log: FastifyBaseLogger,
  env: BootEnvView,
  providerMode: 'live' | 'mock',
  queueKind?: 'memory' | 'bullmq' | 'external',
): GateReport[] {
  const rows = bootGateReport(env, providerMode, queueKind);
  log.info(
    { gates: rows.map((r) => ({ name: r.name, state: r.state, source: r.source })) },
    'boot gate report — resolved states and where each came from',
  );
  for (const r of bootWarnings(rows)) {
    log.warn({ gate: r.name, state: r.state, source: r.source }, `GATE WARNING ${r.name}: ${r.warn}`);
  }
  const fatals = bootFatals(rows);
  for (const r of fatals) {
    log.fatal({ gate: r.name, state: r.state, source: r.source }, `GATE FATAL ${r.name}: ${r.fatal}`);
  }
  if (fatals.length > 0) throw new BootRefusedError(fatals);
  return rows;
}
