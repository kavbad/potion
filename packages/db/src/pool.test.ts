// pg pool config + startup connect retry tests (M3 #27 HA, SPEC §12.8).
// Zero-services: `pg` is an optional peer and is NEVER imported here — the
// pool settings parser and the retry loop are exercised with injected stubs.
import { describe, expect, it } from 'vitest';
import {
  DbConnectError,
  PG_POOL_DEFAULTS,
  connectWithRetry,
  isTransientPgError,
  poolSettingsFromEnv,
} from './pool.js';

describe('poolSettingsFromEnv (SPEC §12.8: env-tunable pg pool)', () => {
  it('returns the defaults when the env vars are unset', () => {
    expect(poolSettingsFromEnv({})).toEqual({ max: 10, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 5_000 });
    expect(poolSettingsFromEnv({})).toEqual(PG_POOL_DEFAULTS);
  });

  it('honors valid overrides', () => {
    expect(
      poolSettingsFromEnv({
        PG_POOL_MAX: '25',
        PG_IDLE_TIMEOUT_MS: '60000',
        PG_CONN_TIMEOUT_MS: '1500',
      }),
    ).toEqual({ max: 25, idleTimeoutMillis: 60_000, connectionTimeoutMillis: 1_500 });
  });

  it('falls back to the default per-knob on bad values', () => {
    for (const bad of ['abc', '-3', '0', '1.5', '', '  ', 'Infinity', 'NaN']) {
      expect(poolSettingsFromEnv({ PG_POOL_MAX: bad }).max).toBe(10);
      expect(poolSettingsFromEnv({ PG_IDLE_TIMEOUT_MS: bad }).idleTimeoutMillis).toBe(30_000);
      expect(poolSettingsFromEnv({ PG_CONN_TIMEOUT_MS: bad }).connectionTimeoutMillis).toBe(5_000);
    }
    // a bad value on one knob must not poison the others
    const mixed = poolSettingsFromEnv({ PG_POOL_MAX: 'junk', PG_CONN_TIMEOUT_MS: '2500' });
    expect(mixed.max).toBe(10);
    expect(mixed.connectionTimeoutMillis).toBe(2_500);
  });
});

describe('isTransientPgError', () => {
  it('treats errno-style connection failures as transient', () => {
    for (const code of ['ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN']) {
      expect(isTransientPgError(Object.assign(new Error('boom'), { code }))).toBe(true);
    }
  });

  it('treats codeless driver errors (e.g. pg connect timeout) as transient', () => {
    expect(isTransientPgError(new Error('timeout exceeded when trying to connect'))).toBe(true);
    expect(isTransientPgError(undefined)).toBe(true);
  });

  it('fails fast on non-transient auth/config errors', () => {
    for (const code of ['28P01', '28000', '3D000']) {
      expect(isTransientPgError(Object.assign(new Error('nope'), { code }))).toBe(false);
    }
  });
});

describe('connectWithRetry (SPEC §12.8: transient-error retry on connect)', () => {
  const noSleep = async () => {};

  it('returns after the first successful attempt', async () => {
    let calls = 0;
    await connectWithRetry(async () => {
      calls += 1;
    }, { sleep: noSleep });
    expect(calls).toBe(1);
  });

  it('retries transient errors with exponential backoff, then succeeds', async () => {
    let calls = 0;
    const delays: number[] = [];
    await connectWithRetry(
      async () => {
        calls += 1;
        if (calls < 3) throw Object.assign(new Error('refused'), { code: 'ECONNREFUSED' });
      },
      { sleep: async (ms) => { delays.push(ms); }, baseDelayMs: 100 },
    );
    expect(calls).toBe(3);
    expect(delays).toEqual([100, 200]); // backoff doubles between attempts
  });

  it('fails fast on non-transient errors (no retry)', async () => {
    let calls = 0;
    await expect(
      connectWithRetry(
        async () => {
          calls += 1;
          throw Object.assign(new Error('password auth failed'), { code: '28P01' });
        },
        { sleep: noSleep },
      ),
    ).rejects.toBeInstanceOf(DbConnectError);
    expect(calls).toBe(1);
  });

  it('exhausts 3 attempts and throws a typed DbConnectError carrying the cause', async () => {
    let calls = 0;
    const cause = Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' });
    const err = await connectWithRetry(
      async () => {
        calls += 1;
        throw cause;
      },
      { sleep: noSleep },
    ).catch((e: unknown) => e);
    expect(calls).toBe(3); // SPEC: 3 attempts
    expect(err).toBeInstanceOf(DbConnectError);
    const typed = err as DbConnectError;
    expect(typed.name).toBe('DbConnectError');
    expect(typed.attempts).toBe(3);
    expect(typed.message).toContain('could not connect to Postgres after 3 attempt(s)');
    expect(typed.cause).toBe(cause);
  });

  it('honors a custom attempt count', async () => {
    let calls = 0;
    await expect(
      connectWithRetry(
        async () => {
          calls += 1;
          throw new Error('always down');
        },
        { attempts: 5, sleep: noSleep },
      ),
    ).rejects.toMatchObject({ name: 'DbConnectError', attempts: 5 });
    expect(calls).toBe(5);
  });
});

describe('attachPoolErrorHandler — a dropped idle connection is witnessed, never fatal', () => {
  it('listens before anything can emit, logs each drop, and never throws', async () => {
    const { attachPoolErrorHandler } = await import('./pool.js');
    const { EventEmitter } = await import('node:events');
    const fake = new EventEmitter();
    const seen: string[] = [];
    attachPoolErrorHandler(fake, (m) => seen.push(m));
    // Without a listener this exact emit is what killed prod (42d72fdf):
    // an unlistened 'error' event throws. With the handler it is a log line.
    fake.emit('error', new Error('Connection terminated unexpectedly'));
    fake.emit('error', new Error('Connection terminated unexpectedly'));
    expect(seen).toHaveLength(2);
    expect(seen[0]).toContain('recovered');
    expect(seen[0]).toContain('Connection terminated unexpectedly');
  });
});
