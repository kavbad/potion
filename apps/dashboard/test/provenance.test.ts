// Provenance presentation helpers (M1a): badge rules + header summaries.
// Pure functions, no React/jsdom needed.
import { describe, expect, it } from 'vitest';
import {
  CUSTODY_NOTE,
  clusterBadgeLabel,
  clusterProvenanceSummary,
  isSimulated,
  pointBadgeLabel,
  pointsProvenance,
} from '../lib/provenance';
import type { FrontierClusterDto } from '../lib/types';

const cluster = (live: number, simulated: number): FrontierClusterDto => ({
  clusterId: 'code-gen',
  frontierId: 'fr-1',
  version: 1,
  pointCount: live + simulated,
  createdAt: '2026-08-04T00:00:00.000Z',
  provenance: { live, simulated },
});

describe('badge rules — only live evidence may badge LIVE', () => {
  it("'mock' and 'unknown' (and absence) are SIMULATED", () => {
    expect(pointBadgeLabel('mock')).toBe('SIMULATED');
    expect(pointBadgeLabel('unknown')).toBe('SIMULATED');
    expect(pointBadgeLabel(undefined)).toBe('SIMULATED');
    expect(isSimulated('live')).toBe(false);
    expect(pointBadgeLabel('live')).toBe('LIVE');
  });

  it('cluster badge: any simulated point taints the frontier', () => {
    expect(clusterBadgeLabel(cluster(3, 0))).toBe('LIVE');
    expect(clusterBadgeLabel(cluster(0, 2))).toBe('SIMULATED');
    expect(clusterBadgeLabel(cluster(2, 1))).toBe('MIXED');
    expect(clusterBadgeLabel(cluster(0, 0))).toBe('SIMULATED');
  });
});

describe('clusterProvenanceSummary', () => {
  it('summarizes live / simulated / mixed / empty', () => {
    expect(clusterProvenanceSummary(cluster(3, 0))).toBe('LIVE — all 3 points from live providers');
    expect(clusterProvenanceSummary(cluster(0, 3))).toMatch(/^SIMULATED — 3 of 3 points/);
    expect(clusterProvenanceSummary(cluster(1, 1))).toBe('MIXED — 1 live, 1 simulated of 2 points');
    expect(clusterProvenanceSummary(cluster(0, 0))).toMatch(/^NO EVIDENCE/);
  });
});

describe('pointsProvenance', () => {
  it('counts live vs simulated across a point list', () => {
    expect(
      pointsProvenance([
        { strategyHash: 'a', strategyConfig: { type: 'single', model: 'm' }, quality: 1, costPer1K: 1, latencyP95: 1, providerMode: 'live', dominated: false },
        { strategyHash: 'b', strategyConfig: { type: 'single', model: 'm' }, quality: 1, costPer1K: 1, latencyP95: 1, providerMode: 'mock', dominated: false },
        { strategyHash: 'c', strategyConfig: { type: 'single', model: 'm' }, quality: 1, costPer1K: 1, latencyP95: 1, dominated: false },
      ]),
    ).toEqual({ live: 1, simulated: 2 });
  });
});

describe('CUSTODY_NOTE (M2 #16 — replaces the M1a BYOK honesty banner)', () => {
  it('states the custody facts: AES-256-GCM envelope encryption at rest + serving', () => {
    expect(CUSTODY_NOTE).toBe(
      'Keys are encrypted at rest (AES-256-GCM, envelope) and used to serve your org’s traffic.',
    );
  });
});
