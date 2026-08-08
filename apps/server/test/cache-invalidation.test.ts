// Cross-instance cache invalidation tests (M3 #27 HA, SPEC §12.8):
//   · redis mode: publish on one instance → subscriber clears its local entry
//     (fake redis pub/sub stub injected via redisFactory — zero services)
//   · no REDIS_URL → memory-only mode (publish/close are no-ops)
//   · ioredis ABSENT (importer throws) → warn-once + memory-only fallback,
//     never a crash (optional-dep contract, mirrors observability's otel)
//   · publish never throws when the redis fan-out fails (logged, TTL heals)
//   · integration: key create/rotate/revoke via the API publishes the org id
//     (stub handle wired through buildServer)
import { EventEmitter } from 'node:events';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sha256 } from '@potion/core';
import { DEFAULT_ORG_ID, insertApiKey, insertPolicy } from '@potion/db';
import {
  KEYS_INVALIDATION_CHANNEL,
  createCacheInvalidator,
  resetRedisWarningForTests,
  type RedisPubSubLike,
} from '../src/cache-invalidation.js';
import { buildServer } from '../src/server.js';

/** In-process fake of the ioredis pub/sub slice: every instance subscribed
 * to a channel receives every instance's publish on that channel. */
class FakeRedis implements RedisPubSubLike {
  static instances = new Set<FakeRedis>();

  private emitter = new EventEmitter();
  private channels = new Set<string>();

  constructor(readonly url: string) {
    FakeRedis.instances.add(this);
  }

  async subscribe(channel: string): Promise<number> {
    this.channels.add(channel);
    return 1;
  }

  on(event: 'message', listener: (channel: string, message: string) => void): this {
    this.emitter.on(event, listener);
    return this;
  }

  async publish(channel: string, message: string): Promise<number> {
    let delivered = 0;
    for (const inst of FakeRedis.instances) {
      if (inst.channels.has(channel)) {
        delivered += 1;
        inst.emitter.emit('message', channel, message);
      }
    }
    return delivered;
  }

  async quit(): Promise<string> {
    FakeRedis.instances.delete(this);
    return 'OK';
  }
}

const factory = (url: string): RedisPubSubLike => new FakeRedis(url);

beforeEach(() => {
  FakeRedis.instances.clear();
  resetRedisWarningForTests();
});

describe('createCacheInvalidator — redis mode (fake pub/sub stub)', () => {
  it('publish on one instance clears the local cache entry on ANOTHER instance', async () => {
    // Two "replicas": each has its own providersForOrg cache map + handle.
    const cacheA = new Map<string, object>([['org-1', { cached: true }]]);
    const replicaA = await createCacheInvalidator({
      redisUrl: 'redis://fake:6379',
      redisFactory: factory,
      onInvalidate: (orgId) => cacheA.delete(orgId),
    });
    const cacheB = new Map<string, object>([['org-1', { cached: true }]]);
    const replicaB = await createCacheInvalidator({
      redisUrl: 'redis://fake:6379',
      redisFactory: factory,
      onInvalidate: (orgId) => cacheB.delete(orgId),
    });
    expect(replicaA.mode).toBe('redis');
    expect(replicaA.channel).toBe(KEYS_INVALIDATION_CHANNEL); // potion:invalidate:keys

    await replicaB.publish('org-1');
    // Both replicas busted the entry (each instance's own subscription sees
    // every publish — a repeat local delete is harmless by design).
    expect(cacheA.has('org-1')).toBe(false);
    expect(cacheB.has('org-1')).toBe(false);
    // Unrelated orgs are untouched.
    cacheA.set('org-2', {});
    await replicaB.publish('org-1');
    expect(cacheA.has('org-2')).toBe(true);

    await Promise.all([replicaA.close(), replicaB.close()]);
    expect(FakeRedis.instances.size).toBe(0); // quit() tore down both conns
  });

  it('publish NEVER throws when the fan-out fails (logged, peers heal at TTL)', async () => {
    const logs: string[] = [];
    const handle = await createCacheInvalidator({
      redisUrl: 'redis://fake:6379',
      log: (m) => logs.push(m),
      redisFactory: (url) => {
        const base = new FakeRedis(url);
        return {
          subscribe: (channel: string) => base.subscribe(channel),
          publish: async (): Promise<number> => {
            throw new Error('redis went away');
          },
          on: (event: 'message', listener: (channel: string, message: string) => void) =>
            base.on(event, listener),
          quit: () => base.quit(),
        };
      },
      onInvalidate: () => {},
    });
    await expect(handle.publish('org-1')).resolves.toBeUndefined();
    expect(logs.some((m) => m.includes('publish failed'))).toBe(true);
    await handle.close();
  });
});

describe('createCacheInvalidator — memory-only fallback', () => {
  it('no REDIS_URL → memory mode, publish/close are no-ops (60s TTL only)', async () => {
    const onInvalidate = vi.fn();
    const handle = await createCacheInvalidator({ onInvalidate });
    expect(handle.mode).toBe('memory');
    await expect(handle.publish('org-1')).resolves.toBeUndefined();
    await expect(handle.close()).resolves.toBeUndefined();
    expect(onInvalidate).not.toHaveBeenCalled();
  });

  it('ioredis ABSENT (import fails) → warn once + memory mode, never crashes', async () => {
    const logs: string[] = [];
    const importer = async () => {
      throw new Error("Cannot find package 'ioredis'");
    };
    const first = await createCacheInvalidator({
      redisUrl: 'redis://localhost:6379',
      importer,
      log: (m) => logs.push(m),
      onInvalidate: () => {},
    });
    expect(first.mode).toBe('memory');
    expect(logs.filter((m) => m.includes('ioredis is unavailable'))).toHaveLength(1);
    // second boot: still memory mode, and the warning does NOT repeat
    const second = await createCacheInvalidator({
      redisUrl: 'redis://localhost:6379',
      importer,
      log: (m) => logs.push(m),
      onInvalidate: () => {},
    });
    expect(second.mode).toBe('memory');
    expect(logs.filter((m) => m.includes('ioredis is unavailable'))).toHaveLength(1);
  });
});

describe('key lifecycle routes publish invalidations (integration)', () => {
  const RAW_ADMIN = 'pk_ha_invalidation_admin';

  let app: FastifyInstance;
  const published: string[] = [];
  const stub = {
    mode: 'redis' as const,
    channel: KEYS_INVALIDATION_CHANNEL,
    publish: async (orgId: string) => {
      published.push(orgId);
    },
    close: async () => {},
  };

  const authed = (url: string, payload: unknown) =>
    app.inject({
      method: 'POST',
      url,
      headers: { authorization: `Bearer ${RAW_ADMIN}`, 'content-type': 'application/json' },
      payload: payload as Record<string, unknown>,
    });

  afterAll(async () => {
    await app?.close();
  });

  it('create → rotate → revoke each publish the org id', async () => {
    app = await buildServer({ seed: false, cacheInvalidation: stub });
    const db = app.potion.db.db;
    await insertPolicy(db, { id: 'pol-ha', orgId: DEFAULT_ORG_ID, name: 'ha', config: { type: 'max_quality', costCeilingPer1K: 100 } });
    await insertApiKey(db, {
      id: 'key-ha-admin',
      keyHash: sha256(RAW_ADMIN),
      name: 'admin',
      orgId: DEFAULT_ORG_ID,
      scopes: 'serve+admin',
    });

    const created = await authed('/api/keys', { provider: 'openai', apiKey: 'ha-byok-v1-aaaaaaaaaaaaaaaa' });
    expect(created.statusCode).toBe(201);
    const keyId = (created.json() as { id: string }).id;
    expect(published).toEqual([DEFAULT_ORG_ID]);

    const rotated = await authed(`/api/keys/${keyId}/rotate`, { apiKey: 'ha-byok-v2-bbbbbbbbbbbbbbbb' });
    expect(rotated.statusCode).toBe(200);
    expect(published).toEqual([DEFAULT_ORG_ID, DEFAULT_ORG_ID]);

    const revoked = await authed(`/api/keys/${keyId}/revoke`, {});
    expect(revoked.statusCode).toBe(200);
    expect(published).toEqual([DEFAULT_ORG_ID, DEFAULT_ORG_ID, DEFAULT_ORG_ID]);
  }, 90_000);
});
