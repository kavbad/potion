// Felt samples: probe determinism, cache semantics (repeat = zero client
// calls), the fail-closed cap with typed partials, and provenance labeling
// (mock feel is labeled, never laundered).
import { describe, expect, it } from 'vitest';
import type { Policy } from '@potion/core';
import type { ServingClient, ServingResult } from '@potion/lab-runtime';
import {
  feltPosition,
  feltSweep,
  missionProbe,
  type FeltCache,
  type FeltCacheRow,
  type FeltPositionRequest,
} from './felt.js';

function memCache(): FeltCache & { size: () => number } {
  const map = new Map<string, FeltCacheRow>();
  const keyOf = (k: { orgId: string; probeHash: string; policyHash: string; frontierId: string }) =>
    `${k.orgId}|${k.probeHash}|${k.policyHash}|${k.frontierId}`;
  return {
    get: async (k) => map.get(keyOf(k)) ?? null,
    put: async (row) => {
      map.set(keyOf(row), row);
    },
    size: () => map.size,
  };
}

function scriptedClient(trace: string, text: string, counter: { calls: number }): ServingClient {
  return {
    complete: async (): Promise<ServingResult> => {
      counter.calls += 1;
      return {
        kind: 'ok', completionId: `chatcmpl-felt-${counter.calls}`, text, toolCalls: [],
        finishReason: 'stop', usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
        frontierTrace: trace,
      } as ServingResult;
    },
  } as unknown as ServingClient;
}

const POLICY: Policy = { type: 'compound', qualityFloor: 0.9, p95Ms: 2000 };

function req(over: Partial<FeltPositionRequest> = {}): FeltPositionRequest {
  return {
    orgId: 'org_felt',
    probe: missionProbe({ goal: 'Summarize the notes', doneDefinition: 'A digest exists' }),
    policy: POLICY,
    policyRef: 'lab-abc123def456-brain',
    frontierId: 'fr-felt-1',
    ...over,
  };
}

describe('missionProbe', () => {
  it('is deterministic and hash-stable', () => {
    const a = missionProbe({ goal: 'G', doneDefinition: 'D' });
    const b = missionProbe({ goal: 'G', doneDefinition: 'D' });
    expect(a).toEqual(b);
    expect(a.probeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(missionProbe({ goal: 'G' }).probeHash).not.toBe(a.probeHash);
  });
});

describe('feltPosition — cache + provenance', () => {
  it('first call hits serving; the repeat is served from cache with ZERO client calls', async () => {
    const counter = { calls: 0 };
    const cache = memCache();
    const deps = {
      clientFor: () => scriptedClient('cluster=summarization;strategy=aabbccdd;frontier=v3;policy=compound;fallback=0;provenance=mock', 'felt output', counter),
      cache,
      costLookup: async () => 0.001,
      clock: () => 0,
    };
    const first = await feltPosition(req(), deps);
    expect(first.ok && !first.sample.cached).toBe(true);
    expect(counter.calls).toBe(1);
    const second = await feltPosition(req(), deps);
    expect(second.ok && second.sample.cached).toBe(true);
    expect(counter.calls).toBe(1); // no new call — the invariant
    if (second.ok) {
      expect(second.sample.strategyHash8).toBe('aabbccdd');
      expect(second.sample.frontierVersion).toBe(3);
      // Mock feel is LABELED, never presented as live.
      expect(second.sample.provenance).toBe('mock');
    }
  });
});

describe('feltSweep — the fail-closed cap', () => {
  it('stops with typed partials when accumulated + projected exceeds the cap', async () => {
    const counter = { calls: 0 };
    const cache = memCache();
    const deps = {
      clientFor: () => scriptedClient('strategy=00ff00ff;frontier=v1;provenance=live', 'x', counter),
      cache,
      costLookup: async () => 0.2, // each call meters $0.20 against a $0.25 cap
      clock: () => 0,
    };
    const positions = [
      req({ policyRef: 'p1', policy: { type: 'compound', qualityFloor: 0.1, p95Ms: 1 } }),
      req({ policyRef: 'p2', policy: { type: 'compound', qualityFloor: 0.2, p95Ms: 1 } }),
      req({ policyRef: 'p3', policy: { type: 'compound', qualityFloor: 0.3, p95Ms: 1 } }),
    ];
    const result = await feltSweep(positions, deps, 0.25);
    // Call 1: $0.20. Projection for call 2: 0.20 + 0.20 > 0.25 → stop.
    expect(result.samples).toHaveLength(1);
    expect(result.gap).toEqual({ code: 'felt-cap-reached', sampled: 1, capUsd: 0.25 });
    expect(result.dropped).toBe(0);
    expect(counter.calls).toBe(1);
  });

  it('cache hits never count against the cap', async () => {
    const counter = { calls: 0 };
    const cache = memCache();
    const deps = {
      clientFor: () => scriptedClient('strategy=11ee11ee;frontier=v1;provenance=mock', 'y', counter),
      cache,
      costLookup: async () => 0.2,
      clock: () => 0,
    };
    const p1 = req({ policyRef: 'p1' });
    await feltPosition(p1, deps); // warm the cache ($0.20 spent outside the sweep)
    const result = await feltSweep([p1, p1, p1], deps, 0.25);
    expect(result.gap).toBeUndefined();
    expect(result.samples.every((s) => s.outcome.ok && s.outcome.sample.cached)).toBe(true);
    expect(counter.calls).toBe(1);
  });

  it('review fix: cache hits resolve BEFORE the cap gate — a $0 cap still serves hits', async () => {
    const counter = { calls: 0 };
    const cache = memCache();
    const deps = {
      clientFor: () => scriptedClient('strategy=22dd22dd;frontier=v1;provenance=mock', 'z', counter),
      cache,
      costLookup: async () => 0.2,
      clock: () => 0,
    };
    const p1 = req({ policyRef: 'pc' });
    await feltPosition(p1, deps); // warm
    const result = await feltSweep([p1], deps, 0.001); // cap below any call
    expect(result.gap).toBeUndefined();
    expect(result.samples[0]!.outcome.ok).toBe(true);
  });

  it('review fix: UNKNOWN metered cost fails closed — the sweep stops after it', async () => {
    const counter = { calls: 0 };
    const deps = {
      clientFor: () => scriptedClient('strategy=33cc33cc;frontier=v1;provenance=mock', 'u', counter),
      cache: memCache(),
      costLookup: async () => null, // request_logs row unresolvable
      clock: () => 0,
    };
    const result = await feltSweep(
      [req({ policyRef: 'u1', policy: { type: 'compound', qualityFloor: 0.4, p95Ms: 1 } }),
       req({ policyRef: 'u2', policy: { type: 'compound', qualityFloor: 0.5, p95Ms: 1 } })],
      deps, 0.25,
    );
    expect(result.samples).toHaveLength(1);
    expect(result.gap?.code).toBe('felt-cap-reached');
    expect(counter.calls).toBe(1);
  });

  it('review fix: divergent samples (fallback/violated/mismatch) are typed and NEVER cached', async () => {
    const counter = { calls: 0 };
    const cache = memCache();
    const deps = {
      clientFor: () => scriptedClient('strategy=44bb44bb;frontier=v1;fallback=1;provenance=mock', 'fb', counter),
      cache,
      costLookup: async () => 0.001,
      clock: () => 0,
    };
    const r1 = await feltPosition(req({ policyRef: 'd1' }), deps);
    expect(r1.ok && r1.divergent?.reason).toBe('fallback-served');
    expect(cache.size()).toBe(0); // poison prevention
    const deps2 = {
      ...deps,
      clientFor: () => scriptedClient('strategy=55aa55aa;frontier=v1;provenance=mock', 'mm', counter),
    };
    const r2 = await feltPosition(req({ policyRef: 'd2', expectedStrategyHash: 'f'.repeat(64) }), deps2);
    expect(r2.ok && r2.divergent?.reason).toBe('strategy-mismatch');
    expect(cache.size()).toBe(0);
  });

  it('review fix: positions beyond the sweep bound are reported, not silent', async () => {
    const counter = { calls: 0 };
    const deps = {
      clientFor: () => scriptedClient('strategy=66996699;frontier=v1;provenance=mock', 't', counter),
      cache: memCache(),
      costLookup: async () => 0.001,
      clock: () => 0,
    };
    const positions = [1, 2, 3, 4, 5].map((i) => req({ policyRef: `t${i}`, policy: { type: 'compound', qualityFloor: i / 10, p95Ms: 1 } }));
    const result = await feltSweep(positions, deps, 0.25);
    expect(result.dropped).toBe(2);
  });
});
