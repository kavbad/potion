// /readyz tests (M3 #27 HA, SPEC §12.8):
//   · all-ok → 200 with db/queue check detail + the circuit-breaker summary
//   · db down (closed pool) → 503 with per-check detail, queue still ok
//   · db ping timeout (hung driver) → 503 via the 2s-timeout path
//   · memory queue (default, nothing wired) is always ready
//   · queue ping failure → 503 with queue detail
//   · /healthz stays "process up" — it does NOT probe the db
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createDb, migrate, type DbHandle } from '@potion/db';
import { resetBreakers } from '@potion/providers';
import { buildServer } from '../src/server.js';
import { checkReadiness } from '../src/readiness.js';
import type { PotionContext } from '../src/context.js';

/**
 * Exactly the surface checkReadiness reads (readiness.ts): `ctx.db.db`,
 * `ctx.db.driver`, and a duck-typed `ctx.queue`. Standing up a whole
 * PotionContext — providers, custody, embedder, demand accumulator — to probe
 * two fields would be fiction, so the stand-ins below are checked against this
 * real surface (PotionContext is assignable to it) and widened in one place.
 */
interface ReadinessCtx {
  db: { db: unknown; driver: string; close(): Promise<void> };
  queue?: {
    close(): Promise<void>;
    ping?: () => Promise<unknown>;
    getJob?: (id: string) => Promise<unknown>;
  };
}
const asCtx = (ctx: ReadinessCtx): PotionContext => ctx as PotionContext;

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildServer({ seed: false });
}, 90_000);

afterAll(async () => {
  await app.close();
  resetBreakers();
});

describe('GET /readyz (SPEC §12.8)', () => {
  it('200 with db + queue ok and the breaker summary when everything is up', async () => {
    resetBreakers();
    const res = await app.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      ok: boolean;
      checks: { db: { ok: boolean; driver: string }; queue: { ok: boolean; driver: string } };
      breakers: Record<string, string>;
    };
    expect(body.ok).toBe(true);
    expect(body.checks.db).toMatchObject({ ok: true, driver: 'pglite' });
    // memory queue (nothing wired): always ready
    expect(body.checks.queue).toMatchObject({ ok: true, driver: 'memory' });
    expect(body.breakers).toEqual({}); // registry empty → no open breakers
  });

  it('503 with db detail when the db handle is closed (db down)', async () => {
    // Own the handle so closing it out from under the server is fair game.
    const db = await createDb();
    await migrate(db.db);
    const victim = await buildServer({ seed: false, db });
    await victim.ready(); // fire boot hooks BEFORE the db goes away
    await db.close(); // simulate db down: pool/socket closed mid-flight
    try {
      const res = await victim.inject({ method: 'GET', url: '/readyz' });
      expect(res.statusCode).toBe(503);
      const body = res.json() as {
        ok: boolean;
        checks: { db: { ok: boolean; detail?: string }; queue: { ok: boolean } };
        breakers: Record<string, string>;
      };
      expect(body.ok).toBe(false);
      expect(body.checks.db.ok).toBe(false);
      expect(typeof body.checks.db.detail).toBe('string');
      expect(body.checks.db.detail!.length).toBeGreaterThan(0);
      expect(body.checks.queue.ok).toBe(true); // per-check detail: queue unaffected
      expect(body.breakers).toBeDefined();
    } finally {
      await victim.close().catch(() => {});
    }
  });

  // CONTRACT CHANGED 2026-09-06, and this test is the record of why. It used
  // to assert that a hung db ping made the instance UNREADY, which is what a
  // readiness probe classically does — and in production that is what pulled
  // the only replica out of rotation under load and turned saturation into a
  // 32%-failure outage. A hung driver here is indistinguishable from a busy
  // one, and busy must keep serving. The timeout DETAIL still has to survive,
  // because an operator needs to see it; only the verdict changed.
  it('db ping timeout path → still ready, flagged degraded, timeout detail intact', async () => {
    const db = await createDb();
    const ctx = asCtx({
      db: {
        driver: 'node-postgres',
        db: { execute: () => new Promise(() => {}) }, // hung driver
        close: async () => {},
      },
    });
    const report = await checkReadiness(ctx, { dbTimeoutMs: 25 });
    expect(report.ok).toBe(true);
    expect(report.degraded).toBe(true);
    expect(report.checks.db).toMatchObject({ ok: true, degraded: true, driver: 'node-postgres' });
    expect(report.checks.db.detail).toContain('timeout after 25ms');
    expect(report.checks.queue.ok).toBe(true);
    await db.close();
  });

  it('queue ping failure → 503 with queue detail (bullmq-style redis ping)', async () => {
    const db = await createDb();
    await migrate(db.db);
    const ctx = asCtx({
      db,
      queue: {
        ping: async () => {
          throw new Error('redis unreachable');
        },
        close: async () => {},
      },
    });
    const report = await checkReadiness(ctx);
    expect(report.ok).toBe(false);
    expect(report.checks.db.ok).toBe(true);
    expect(report.checks.queue.ok).toBe(false);
    expect(report.checks.queue.detail).toContain('redis unreachable');
    await db.close();
  });

  it('§12.2 PotionQueue probe: getJob round-trip surfaces redis down (no ping method)', async () => {
    const db = await createDb();
    await migrate(db.db);
    class BullMQQueue {
      async getJob(): Promise<null> {
        throw new Error('enqueue failed — Redis unreachable or closed');
      }
      async close(): Promise<void> {}
    }
    const ctx = asCtx({ db, queue: new BullMQQueue() });
    const down = await checkReadiness(ctx);
    expect(down.ok).toBe(false);
    expect(down.checks.queue).toMatchObject({ ok: false, driver: 'bullmq' });
    expect(down.checks.queue.detail).toContain('Redis unreachable');

    // redis back up: the same probe resolves (null = job not found) → ready
    class BullMQUp {
      async getJob(): Promise<null> {
        return null;
      }
      async close(): Promise<void> {}
    }
    const up = await checkReadiness(asCtx({ db, queue: new BullMQUp() }));
    expect(up.checks.queue).toMatchObject({ ok: true, driver: 'bullmq' });
    await db.close();
  });

  it('wired memory driver is always ready without a probe round-trip', async () => {
    const db = await createDb();
    await migrate(db.db);
    class MemoryQueue {
      probeCount = 0;
      async getJob(): Promise<null> {
        this.probeCount += 1;
        return null;
      }
      async close(): Promise<void> {}
    }
    const queue = new MemoryQueue();
    const report = await checkReadiness(asCtx({ db, queue }));
    expect(report.checks.queue).toMatchObject({ ok: true, driver: 'memory' });
    expect(queue.probeCount).toBe(0); // memory: no probe, always ok
    await db.close();
  });

  it('/healthz stays "process up" even when the db is down (no probes)', async () => {
    const db: DbHandle = await createDb();
    await migrate(db.db);
    const victim = await buildServer({ seed: false, db });
    await victim.ready();
    await db.close();
    try {
      const res = await victim.inject({ method: 'GET', url: '/healthz' });
      expect(res.statusCode).toBe(200);
      expect((res.json() as { ok: boolean }).ok).toBe(true);
    } finally {
      await victim.close().catch(() => {});
    }
  });
});

// 2026-09-06, from a production load test. Caddy health-checks /readyz every
// 10s and drains the upstream on a 503. Under sustained load the db ping
// exceeded its 2s budget — because WE were busy, not because the database was
// down — so /readyz reported unhealthy, the only replica was pulled from
// rotation, and the proxy answered 478 of 1500 requests with 503 while the
// server sat there able to serve them. The probe meant to protect the service
// was the thing taking it down, at roughly 15 rps.
describe('a SLOW dependency is not a DOWN one', () => {
  const slow = (ms: number) => ({
    db: {
      db: { execute: () => new Promise((r) => setTimeout(r, ms)) },
      driver: 'pglite',
      close: async () => {},
    },
  });
  const broken = {
    db: {
      db: { execute: () => Promise.reject(new Error('connection refused')) },
      driver: 'pglite',
      close: async () => {},
    },
  };

  it('a db ping that TIMES OUT stays ready, and says it is degraded', async () => {
    const report = await checkReadiness(asCtx(slow(200)), { dbTimeoutMs: 20 });
    expect(
      report.ok,
      'draining a saturated instance removes capacity from a system already short of it',
    ).toBe(true);
    expect(report.degraded).toBe(true);
    expect(report.checks.db.degraded).toBe(true);
    expect(report.checks.db.detail).toMatch(/timeout/i);
  });

  it('a db ping that ERRORS is still not ready — draining is for broken, not busy', async () => {
    const report = await checkReadiness(asCtx(broken), { dbTimeoutMs: 500 });
    expect(report.ok).toBe(false);
    expect(report.degraded).toBeUndefined();
    expect(report.checks.db.detail).toMatch(/refused/i);
  });

  it('a healthy instance is neither degraded nor unready', async () => {
    const report = await checkReadiness(asCtx(slow(0)), { dbTimeoutMs: 500 });
    expect(report.ok).toBe(true);
    expect(report.degraded).toBeUndefined();
  });
});
