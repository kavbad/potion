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
}

/** Where a gate's value came from — the empty/unset split is the point. */
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
  POTION_METRICS?: string | undefined;
}

const truthy = (v: string | undefined): boolean => v === '1' || v?.toLowerCase() === 'true';

/**
 * Build the report. Pure over the environment view + resolved provider
 * mode, so the dangerous combinations are asserted in tests rather than
 * discovered in production.
 */
export function bootGateReport(env: BootEnvView, providerMode: 'live' | 'mock'): GateReport[] {
  const isProd = env.NODE_ENV === 'production';
  const devAuthRaw = env.POTION_DEV_AUTH;
  const devAuth = devAuthRaw !== undefined && devAuthRaw !== '' ? truthy(devAuthRaw) : !isProd;

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
    ...(magicLink && selfServe
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
    ...(devAuth && isProd
      ? { warn: 'AUTH BYPASS IS ON IN PRODUCTION — every dashboard route is effectively public.' }
      : {}),
  });

  // ---- money ----
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

  // ---- what the router will actually call ----
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

/**
 * Emit the report. Warnings go at WARN so they survive a log level that
 * drops info, and each names the variable so the fix is unambiguous.
 */
export function logBootGates(log: FastifyBaseLogger, env: BootEnvView, providerMode: 'live' | 'mock'): GateReport[] {
  const rows = bootGateReport(env, providerMode);
  log.info(
    { gates: rows.map((r) => ({ name: r.name, state: r.state, source: r.source })) },
    'boot gate report — resolved states and where each came from',
  );
  for (const r of bootWarnings(rows)) {
    log.warn({ gate: r.name, state: r.state, source: r.source }, `GATE WARNING ${r.name}: ${r.warn}`);
  }
  return rows;
}
