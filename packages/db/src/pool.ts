// node-postgres pool configuration + startup connect retry (SPEC §12.8, #27).
// Pure/config-only module — it NEVER imports `pg` (the optional peer), so it
// loads in the zero-services sandbox; db.ts wires these helpers into the
// node-pg branch of createDb().

/** Pool knobs for the node-pg path (PGlite is single-connection, untouched). */
export interface PgPoolSettings {
  /** Max pooled connections (env PG_POOL_MAX, default 10). */
  max: number;
  /** Idle connection reap (env PG_IDLE_TIMEOUT_MS, default 30_000). */
  idleTimeoutMillis: number;
  /** Connection acquisition timeout (env PG_CONN_TIMEOUT_MS, default 5_000). */
  connectionTimeoutMillis: number;
}

export const PG_POOL_DEFAULTS: PgPoolSettings = {
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
};

/** Positive-int env parse; anything unusable falls back to the default
 * (loud envs are nice, but a mis-set pool knob must never block boot). */
function positiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) return fallback;
  return value;
}

/** Read the pool knobs from the environment (bad values → defaults). */
export function poolSettingsFromEnv(env: NodeJS.ProcessEnv = process.env): PgPoolSettings {
  return {
    max: positiveInt(env.PG_POOL_MAX, PG_POOL_DEFAULTS.max),
    idleTimeoutMillis: positiveInt(env.PG_IDLE_TIMEOUT_MS, PG_POOL_DEFAULTS.idleTimeoutMillis),
    connectionTimeoutMillis: positiveInt(env.PG_CONN_TIMEOUT_MS, PG_POOL_DEFAULTS.connectionTimeoutMillis),
  };
}

/** Startup connect failure after exhausting retries — typed so operators and
 * tests can distinguish "db unreachable at boot" from query-time errors. */
export class DbConnectError extends Error {
  /** How many connect attempts were made before giving up. */
  readonly attempts: number;

  constructor(attempts: number, cause: unknown) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(`could not connect to Postgres after ${attempts} attempt(s): ${reason}`, {
      cause,
    });
    this.name = 'DbConnectError';
    this.attempts = attempts;
  }
}

/**
 * Postgres/sqlstate + errno codes that are NOT worth retrying at startup:
 * invalid password / auth failure / unknown database — these never heal by
 * waiting, so fail fast. Everything else (ECONNREFUSED, ETIMEDOUT, sqlstate
 * 08xxx / 57P0x, codeless driver timeouts) is treated as transient.
 */
const NON_TRANSIENT_CODES = new Set(['28000', '28P01', '3D000']);

export function isTransientPgError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  if (typeof code !== 'string') return true; // codeless (e.g. pg connect timeout) → retry
  return !NON_TRANSIENT_CODES.has(code);
}

export interface ConnectRetryOptions {
  /** Total attempts (default 3, per SPEC §12.8). */
  attempts?: number;
  /** First backoff delay in ms; doubles each attempt (default 200 → 200,400). */
  baseDelayMs?: number;
  /** Injectable sleep (tests). */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable transient classifier (tests). */
  isTransient?: (err: unknown) => boolean;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run `connect` with bounded retry + exponential backoff on transient errors
 * (SPEC §12.8: "transient-error retry on connect", 3 attempts). Non-transient
 * errors fail fast. Exhaustion throws a typed DbConnectError.
 */
export async function connectWithRetry(
  connect: () => Promise<unknown>,
  opts: ConnectRetryOptions = {},
): Promise<void> {
  const attempts = opts.attempts ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 200;
  const sleep = opts.sleep ?? defaultSleep;
  const isTransient = opts.isTransient ?? isTransientPgError;
  let lastErr: unknown;
  let tried = 0;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    tried = attempt;
    try {
      await connect();
      return;
    } catch (err) {
      lastErr = err;
      if (attempt >= attempts || !isTransient(err)) break;
      await sleep(baseDelayMs * 2 ** (attempt - 1));
    }
  }
  throw new DbConnectError(tried, lastErr);
}
