// Spec motion + policy-row lifecycle (review outcome 2): a dial move is a
// spec edit producing a new hash-bound pair; superseded policy rows are
// RETAINED — an old spec+sidecar still resolves after a move.
import { describe, expect, it } from 'vitest';
import type { Frontier, FrontierPoint } from '@potion/core';
import { createDb, createOrg, migrate } from '@potion/db';
import { resolvePolicyRef } from '@potion/db';
import { harnessSpecHash, parseHarnessSpecText } from '@potion/lab-spec';
import { verifyChoicesBinding } from '@potion/lab-gen';
import { buildDialDomain, viewPosition } from './geometry.js';
import { applyDialPosition } from './motion.js';
import { dialPolicyName, materializeDialPolicy } from './materialize.js';

function pt(over: Partial<FrontierPoint> & { strategyHash: string }): FrontierPoint {
  return {
    clusterId: 'summarization',
    strategyConfig: { type: 'single', model: 'm' },
    quality: 0.8, costPer1K: 0.01, latencyP95: 800, providerMode: 'live',
    evidence: { cacheKeys: ['ck'], runIds: ['r'], n: 14, qualityCi95: 0.02, suiteContentHash: 'f'.repeat(64) },
    ...over,
  };
}
const FRONTIER = {
  id: 'fr-motion-1', clusterId: 'summarization', version: 2, parentId: null, trigger: 'recompute',
  points: [pt({ strategyHash: 'lo', quality: 0.6, costPer1K: 0.005, latencyP95: 400 }), pt({ strategyHash: 'hi', quality: 0.9, costPer1K: 0.03, latencyP95: 1200 })],
  pricesVersion: 'pv', createdAt: '',
} as unknown as Frontier;

const BASE_SPEC = {
  specVersion: 1 as const,
  name: 'motion-harness',
  brain: { policy: { type: 'compound' as const, qualityFloor: 0.6, p95Ms: 2000 } },
  mission: { kind: 'task' as const, goal: 'Summarize the notes', doneDefinition: 'A digest exists' },
  superpowers: [],
  memory: { enabled: false },
  rules: [],
  fuel: { maxUsdPerRun: 0.5, hardStop: true as const },
  checkIns: [],
};

function baseSpecText(): string {
  const hash = harnessSpecHash(BASE_SPEC);
  return JSON.stringify({ ...BASE_SPEC, hash });
}

function domain() {
  const r = buildDialDomain({ frontier: FRONTIER, clusterId: 'summarization', slot: 'brain', toolBearing: false });
  if (!r.ok) throw new Error('gap');
  return r.domain;
}

describe('applyDialPosition', () => {
  it('produces a new valid spec + two-way-bound sidecar; the old sidecar orphans against it', () => {
    const d = domain();
    const view = viewPosition(d, { qualityIndex: 1 });
    if (!view.feasible) throw new Error('infeasible');
    const moved = applyDialPosition({ specText: baseSpecText(), slot: 'brain', view, domain: d });
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;
    expect(parseHarnessSpecText(moved.specText).ok).toBe(true);
    expect(moved.spec.brain.policy).toEqual(view.policy);
    expect(verifyChoicesBinding(moved.specText, moved.sidecar)).toEqual({ bound: true });
    expect(moved.sidecar.choices[0]!.basis.strategyHash).toBe('hi');
    // The move changed the hash: the new sidecar does NOT bind the old spec.
    const crossCheck = verifyChoicesBinding(baseSpecText(), moved.sidecar);
    expect(crossCheck.bound).toBe(false);
  });

  it('tool-slot move writes brain.toolPolicy and records the slot in the choice', () => {
    const d = domain();
    const view = viewPosition(d, { qualityIndex: 0 });
    if (!view.feasible) throw new Error('infeasible');
    const moved = applyDialPosition({ specText: baseSpecText(), slot: 'tools', view, domain: d });
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;
    expect(moved.spec.brain.toolPolicy).toEqual(view.policy);
    expect(moved.spec.brain.policy).toEqual(BASE_SPEC.brain.policy);
    expect(moved.sidecar.choices[0]!.slot).toBe('brain.toolPolicy');
  });

  it('invalid input spec is a typed refusal', () => {
    const d = domain();
    const view = viewPosition(d, { qualityIndex: 0 });
    if (!view.feasible) throw new Error('infeasible');
    const r = applyDialPosition({ specText: '{"not":"a spec"}', slot: 'brain', view, domain: d });
    expect(!r.ok && r.reason).toBe('spec-invalid');
  });
});

describe('policy-row lifecycle (review outcome 2)', () => {
  it('a dial move creates a NEW row; the superseded generation is retained and still resolves', async () => {
    const h = await createDb();
    await migrate(h.db);
    try {
      await createOrg(h.db, { id: 'org_dial_life', name: 'Dial Lifecycle' });
      const d = domain();
      const v1Text = baseSpecText();
      const v1Hash = harnessSpecHash(BASE_SPEC);
      await materializeDialPolicy(h.db, {
        orgId: 'org_dial_life', harnessHash: v1Hash, slot: 'brain', policy: BASE_SPEC.brain.policy,
      });
      // Idempotent re-materialization of the same generation.
      await materializeDialPolicy(h.db, {
        orgId: 'org_dial_life', harnessHash: v1Hash, slot: 'brain', policy: BASE_SPEC.brain.policy,
      });
      const view = viewPosition(d, { qualityIndex: 1 });
      if (!view.feasible) throw new Error('infeasible');
      const moved = applyDialPosition({ specText: v1Text, slot: 'brain', view, domain: d });
      if (!moved.ok) throw new Error('motion failed');
      const v2Hash = moved.sidecar.specHash;
      expect(v2Hash).not.toBe(v1Hash);
      await materializeDialPolicy(h.db, {
        orgId: 'org_dial_life', harnessHash: v2Hash, slot: 'brain', policy: moved.spec.brain.policy,
      });
      // BOTH generations resolve by name — history retained, never GC'd here.
      const oldRow = await resolvePolicyRef(h.db, 'org_dial_life', dialPolicyName('org_dial_life', v1Hash, 'brain'));
      const newRow = await resolvePolicyRef(h.db, 'org_dial_life', dialPolicyName('org_dial_life', v2Hash, 'brain'));
      expect(oldRow).not.toBeNull();
      expect(newRow).not.toBeNull();
      expect(oldRow!.id).not.toBe(newRow!.id);
      expect(oldRow!.config).toEqual(BASE_SPEC.brain.policy);
      expect(newRow!.config).toEqual(moved.spec.brain.policy);
    } finally {
      await h.close();
    }
  });
});
