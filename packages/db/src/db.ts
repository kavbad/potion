// Dual-driver db factory (SPEC §7): PGlite when url is absent or 'pglite://'
// (tests/dev/sandbox — zero services), node-postgres otherwise (local/prod
// Postgres 16 + pgvector via docker-compose). One drizzle schema for both.
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { sql } from 'drizzle-orm';
import { drizzle as drizzlePglite, type PgliteDatabase } from 'drizzle-orm/pglite';
import { schema, type Schema } from './schema.js';
// ---- M3 #27 HA (m3-ha): pg pool config + startup connect retry ----
import { connectWithRetry, poolSettingsFromEnv } from './pool.js';
// ---- end M3 #27 HA imports ----

/**
 * Both drivers expose the same query API at runtime; we standardize on the
 * PGlite drizzle type and cast the node-postgres instance (documented, used
 * only outside the sandbox).
 */
export type PotionDb = PgliteDatabase<Schema>;

export type DbDriver = 'pglite' | 'node-postgres';

export interface DbHandle {
  db: PotionDb;
  driver: DbDriver;
  close(): Promise<void>;
}

/**
 * createDb(url?) — PGlite when `url` (or DATABASE_URL fallback) is absent or
 * 'pglite://' (in-memory; tests/dev/sandbox — zero services), PGlite persisted
 * to a data directory for 'pglite://<dir>', node-postgres otherwise (local/prod
 * Postgres 16 + pgvector via docker-compose). One drizzle schema for both.
 */
export async function createDb(url?: string): Promise<DbHandle> {
  const effective = url ?? process.env.DATABASE_URL;

  if (!effective || effective === 'pglite://') {
    const client = new PGlite({ extensions: { vector } });
    const db = drizzlePglite(client, { schema });
    return {
      db,
      driver: 'pglite',
      close: async () => {
        await client.close();
      },
    };
  }

  // 'pglite://<dir>' — PGlite persisted to a data directory (additive; lets
  // CLI invocations and demo scripts share one zero-services database).
  if (effective.startsWith('pglite://')) {
    const dataDir = effective.slice('pglite://'.length);
    const client = new PGlite(dataDir, { extensions: { vector } });
    const db = drizzlePglite(client, { schema });
    return {
      db,
      driver: 'pglite',
      close: async () => {
        await client.close();
      },
    };
  }

  // Dynamic import: `pg` is an optional peer — never loaded in the sandbox.
  const [{ Pool }, { drizzle: drizzleNodePg }] = await Promise.all([
    import('pg'),
    import('drizzle-orm/node-postgres'),
  ]);
  // ---- M3 #27 HA (m3-ha) ----
  // Env-tunable pool (PG_POOL_MAX / PG_IDLE_TIMEOUT_MS / PG_CONN_TIMEOUT_MS)
  // + bounded startup connect with backoff on transient errors (3 attempts,
  // typed DbConnectError on exhaustion). PGlite paths above are unchanged.
  const pool = new Pool({ connectionString: effective, ...poolSettingsFromEnv() });
  await connectWithRetry(() => pool.query('SELECT 1'));
  // ---- end M3 #27 HA ----
  const db = drizzleNodePg(pool, { schema }) as unknown as PotionDb;
  return {
    db,
    driver: 'node-postgres',
    close: async () => {
      await pool.end();
    },
  };
}

/**
 * pingDb (M3 #27 HA, SPEC §12.8): liveness probe used by GET /readyz —
 * a bare `SELECT 1` on whichever driver the handle wraps. Callers apply
 * their own timeout; this rejects when the db is down (closed pool/socket).
 */
export async function pingDb(db: PotionDb): Promise<void> {
  await db.execute(sql`SELECT 1`);
}
