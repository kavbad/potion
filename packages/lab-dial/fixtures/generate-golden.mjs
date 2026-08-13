// Golden dial sweeps (the Step 2/4/6 pattern): byte-reproducible fixtures
// pinning full DialView[] streams + gap outcomes, including the Step 6
// three-axis R/M/K case and the felt-cache semantics (memory cache +
// scripted client — the REAL cache proof is the walkthrough's request_logs
// invariant).
//   node fixtures/generate-golden.mjs [outDir]
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson } from '@potion/core';
import { buildDialDomain, dialViews, feltSweep, missionProbe } from '../dist/index.js';

const OUT = process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), 'golden');
mkdirSync(OUT, { recursive: true });

const pt = (over) => ({
  clusterId: 'summarization',
  strategyConfig: { type: 'single', model: 'm' },
  quality: 0.8, costPer1K: 0.01, latencyP95: 800, providerMode: 'live',
  evidence: { cacheKeys: ['ck-g'], runIds: ['run-g'], n: 14, qualityCi95: 0.02, suiteContentHash: 'a'.repeat(64) },
  ...over,
});
const CASCADE_CFG = { type: 'cascade', stages: [{ model: 'a' }, { model: 'b' }], confidenceMethod: 'self-report-calibrated' };
const frontier = (id, points) => ({
  id, clusterId: 'summarization', version: 2, parentId: null, trigger: 'recompute',
  points, pricesVersion: 'pv-golden', createdAt: '2026-08-12T00:00:00.000Z',
});

const R = pt({ strategyHash: 'gold-r', quality: 0.9, costPer1K: 1.0, latencyP95: 1300 });
const M = pt({ strategyHash: 'gold-m', quality: 0.3, costPer1K: 1.05, latencyP95: 40 });
const K = pt({ strategyHash: 'gold-k', quality: 0.9, costPer1K: 1.15, latencyP95: 900 });

const FIXTURES = [
  {
    name: 'ladder-simple',
    kind: 'sweep',
    frontier: frontier('fr-ladder', [
      pt({ strategyHash: 'g-lo', quality: 0.6, costPer1K: 0.005, latencyP95: 300 }),
      pt({ strategyHash: 'g-mid', quality: 0.8, costPer1K: 0.02, latencyP95: 700 }),
      pt({ strategyHash: 'g-hi', quality: 0.95, costPer1K: 0.09, latencyP95: 1600 }),
    ]),
    toolBearing: false,
    tolerances: [undefined],
  },
  {
    name: 'three-axis-rmk',
    kind: 'sweep',
    frontier: frontier('fr-rmk', [R, M, K]),
    toolBearing: false,
    tolerances: [undefined, 1000, 30],
  },
  {
    name: 'tool-partition-sweep',
    kind: 'sweep',
    frontier: frontier('fr-tools', [
      pt({ strategyHash: 'g-s1', quality: 0.7, costPer1K: 0.01, latencyP95: 500 }),
      pt({ strategyHash: 'g-cas', quality: 0.92, costPer1K: 0.008, latencyP95: 900, strategyConfig: CASCADE_CFG }),
      pt({ strategyHash: 'g-s2', quality: 0.88, costPer1K: 0.04, latencyP95: 1100 }),
    ]),
    toolBearing: true,
    tolerances: [undefined, 600],
  },
  {
    name: 'tie-quality-cost',
    kind: 'sweep',
    frontier: frontier('fr-tie', [
      pt({ strategyHash: 'g-aa', quality: 0.8, costPer1K: 0.02, latencyP95: 600 }),
      pt({ strategyHash: 'g-bb', quality: 0.8, costPer1K: 0.02, latencyP95: 400 }),
    ]),
    toolBearing: false,
    tolerances: [undefined],
  },
  {
    name: 'not-live',
    kind: 'sweep',
    frontier: frontier('fr-taint', [pt({ strategyHash: 'g-ok' }), pt({ strategyHash: 'g-mock', providerMode: 'mock' })]),
    toolBearing: false,
    tolerances: [undefined],
  },
  { name: 'felt-cache', kind: 'felt' },
];

for (const f of FIXTURES) {
  let result;
  if (f.kind === 'sweep') {
    const built = buildDialDomain({ frontier: f.frontier, clusterId: 'summarization', slot: f.toolBearing ? 'tools' : 'brain', toolBearing: f.toolBearing });
    result = built.ok
      ? { domain: { ladder: built.domain.ladder, defaultToleranceMs: built.domain.defaultToleranceMs, singleOnly: built.domain.singleOnly },
          sweeps: f.tolerances.map((t) => ({ toleranceMs: t ?? null, views: dialViews(built.domain, t) })) }
      : { gap: built.gap };
  } else {
    // Felt-cache semantics with a memory cache + scripted client.
    const map = new Map();
    const keyOf = (k) => `${k.orgId}|${k.probeHash}|${k.policyHash}|${k.frontierId}`;
    let calls = 0;
    const deps = {
      clientFor: () => ({
        complete: async () => {
          calls += 1;
          return {
            kind: 'ok', completionId: `chatcmpl-golden-felt-${calls}`, text: 'felt output', toolCalls: [],
            finishReason: 'stop', usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
            frontierTrace: 'cluster=summarization;strategy=goldfelt1;frontier=v2;policy=compound;fallback=0;provenance=mock',
          };
        },
      }),
      cache: { get: async (k) => map.get(keyOf(k)) ?? null, put: async (row) => { map.set(keyOf(row), row); } },
      costLookup: async () => 0.001,
      clock: () => 0,
    };
    const probe = missionProbe({ goal: 'Summarize the notes', doneDefinition: 'A digest exists' });
    const pos = { orgId: 'org_golden', probe, policy: { type: 'compound', qualityFloor: 0.9, p95Ms: 2000 }, policyRef: 'lab-golden-brain', frontierId: 'fr-rmk' };
    const first = await feltSweep([pos], deps);
    const second = await feltSweep([pos], deps);
    result = { first, second, totalClientCalls: calls };
  }
  writeFileSync(path.join(OUT, `${f.name}.json`), canonicalJson({ name: f.name, input: f.kind === 'sweep' ? { frontier: f.frontier, toolBearing: f.toolBearing, tolerances: f.tolerances.map((t) => t ?? null) } : null, result }) + '\n');
  console.log(`golden: ${f.name}`);
}
