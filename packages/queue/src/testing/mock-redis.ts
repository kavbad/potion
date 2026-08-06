// Hermetic ioredis-mock connection factory for BullMQ tests (SPEC §12.2:
// "in-process Redis stub (ioredis-mock) — hermetic, no container required").
//
// createBullMqMockConnection() returns an ioredis-mock instance ready to be
// handed to createQueue('bullmq', { connection }):
//   · installBullMqLuaShims() is applied (cmsgpack/cjson/XTRIM/HMGET — see
//     lua-shims.ts);
//   · maxRetriesPerRequest: null as BullMQ workers require;
//   · a BZPOPMIN polyfill is installed: BullMQ v5 workers block on
//     `bzpopmin <queue>:marker <timeout>` and ioredis-mock has no blocking
//     commands. The polyfill polls zpopmin every few ms until the timeout
//     (or the connection ends) — fine for an in-process stub;
//   · duplicate() is wrapped so BullMQ's internal blocking connection (a
//     duplicate of the one we hand over) gets the same polyfills.
//
// DATA-SHARING NOTE: ioredis-mock (v6+) shares one data context per
// host:port across ALL instances in the process, including duplicates. That
// is what makes the "job survives a restart" test work: a second driver over
// a fresh instance sees the jobs the first one enqueued. It also means tests
// MUST use unique queue names (or flushall) to stay isolated.
import IORedisMock from 'ioredis-mock';
import { installBullMqLuaShims } from './lua-shims.js';

const POLL_MS = 15;

type MockRedis = InstanceType<typeof IORedisMock>;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function installPolyfills(conn: MockRedis): MockRedis {
  const anyConn = conn as unknown as Record<string, unknown>;
  anyConn.bzpopmin = async (key: string, timeoutSec: number): Promise<[string, string, string] | null> => {
    // timeout 0 means "block forever" in Redis; cap at 30s so a forgotten
    // worker can never hang a test process.
    const deadline = Date.now() + (timeoutSec > 0 ? timeoutSec * 1000 : 30_000);
    for (;;) {
      const popped = (await conn.zpopmin(key)) as string[];
      if (popped && popped.length >= 2) return [key, popped[0]!, popped[1]!];
      if (Date.now() >= deadline) return null;
      // ioredis-mock tracks liveness with .connected (no .status); BullMQ
      // disconnects the blocking duplicate on worker.close().
      if ((conn as unknown as { connected?: boolean }).connected === false) return null;
      await sleep(POLL_MS);
    }
  };
  const originalDuplicate = conn.duplicate.bind(conn);
  anyConn.duplicate = (...args: unknown[]) =>
    installPolyfills(originalDuplicate(...(args as [])) as MockRedis);
  return conn;
}

/** Create a shimmed + polyfilled ioredis-mock connection for BullMQ tests. */
export function createBullMqMockConnection(
  options?: Record<string, unknown>,
): MockRedis {
  installBullMqLuaShims();
  return installPolyfills(
    new IORedisMock({ maxRetriesPerRequest: null, ...(options ?? {}) }),
  );
}
