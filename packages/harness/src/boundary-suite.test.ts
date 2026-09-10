// A boundary suite is the union of two parents, verbatim, ids preserved — so a
// cell measured on either parent is reused, and a point on that frontier has
// been scored on both kinds of item. One entry per boundary that ships.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadSuiteV2 } from './ingest/suite-v2.js';

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8').split('\n').filter((l) => l.trim() && !l.startsWith('//')).map((l) => JSON.parse(l) as { id: string; scoring: { kind: string } });

const BOUNDARIES = [
  { suiteId: 'boundary-extraction-msr-v1', clusterId: 'extraction+multi-step-reasoning', parents: ['../suites/v2/extraction-hard-v2/items.jsonl', '../suites/multi-step-reasoning.jsonl'], kinds: ['field-match', 'exact'] },
  { suiteId: 'boundary-agentic-msr-v1', clusterId: 'agentic-tool-use+multi-step-reasoning', parents: ['../suites/agentic-tool-use.jsonl', '../suites/multi-step-reasoning.jsonl'], kinds: ['llm-judge', 'exact'] },
];

// A boundary-SHAPED suite has no parents: its items were generated to sit at
// the tie and gated against the live classifier (validation.json beside it).
// The slice is the classifier's top-1 — which side of the line the item sits
// on — so it must be one of the two parents, and both sides must be present.
describe('boundary-extraction-msr-shaped-v1', () => {
  it('every item is under the boundary cluster, field-match scored, sliced to one of the two parents, with both sides present', () => {
    const { items, manifest } = loadSuiteV2('boundary-extraction-msr-shaped-v1');
    expect(manifest.clusterId).toBe('extraction+multi-step-reasoning');
    expect(items.length).toBeGreaterThanOrEqual(60);
    expect(new Set(items.map((i) => i.clusterId))).toEqual(new Set(['extraction+multi-step-reasoning']));
    expect(new Set(items.map((i) => i.scoring.kind))).toEqual(new Set(['field-match']));
    const slices = new Set(items.map((i) => i.slice));
    expect(slices).toEqual(new Set(['extraction', 'multi-step-reasoning']));
    expect(items.filter((i) => i.slice === 'multi-step-reasoning').length).toBeGreaterThanOrEqual(20);
  });
});

describe.each(BOUNDARIES)('$suiteId', ({ suiteId, clusterId, parents, kinds }) => {
  it('is exactly the union of its parents, ids unchanged, every item under the boundary cluster', () => {
    const parentItems = parents.flatMap(read);
    const { items, manifest } = loadSuiteV2(suiteId);
    expect(manifest.clusterId).toBe(clusterId);
    expect(items).toHaveLength(parentItems.length);
    expect(items.map((i) => i.id).sort()).toEqual(parentItems.map((i) => i.id).sort());
    expect(new Set(items.map((i) => i.clusterId))).toEqual(new Set([clusterId]));
    expect(new Set(items.map((i) => i.scoring.kind))).toEqual(new Set(kinds));
  });
});
