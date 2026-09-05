// A WIN LABEL MUST NAME A WIN (2026-09-05).
//
// MixingFact.kind gained 'no-win' and a separate `shape`, because a close
// note reports measured LOSSES and the union could previously only express
// wins — so rows with costSaving -0.12 were going out under a winning label
// with the strategy's shape ('judge-picked pair') sitting in the verdict
// field. The type now permits the honest answer. This makes the dishonest
// one unpublishable, in the same deterministic layer that already refuses
// "groundbreaking".
import { describe, expect, it } from 'vitest';
import { auditMixingVerdicts } from './lint.js';
import type { MixingFact } from './types.js';

// `Partial<T>` under exactOptionalPropertyTypes lets a key be ABSENT but not
// explicitly `undefined`, and this builder spreads defaults — so a test cannot
// express "no cluster" by omitting the key, only by overriding it to undefined
// (which is what MixingFact.clusterId documents: "Absent when the finding is
// vague"). Widen the OVERRIDE type, not MixingFact itself.
const fact = (over: { [K in keyof MixingFact]?: MixingFact[K] | undefined }): MixingFact => ({
  clusterId: 'classification',
  family: 'extractive',
  kind: 'cheaper-and-as-good',
  meanQuality: 0.9,
  qualityDeltaVsBestSingle: 0.01,
  costSaving: 0.4,
  ...over,
} as MixingFact);

describe('auditMixingVerdicts', () => {
  it('passes an honest win and an honest loss', () => {
    expect(auditMixingVerdicts([fact({})])).toBeNull();
    expect(
      auditMixingVerdicts([
        fact({ kind: 'no-win', shape: 'judge-picked pair', costSaving: -0.12, qualityDeltaVsBestSingle: -0.03 }),
      ]),
    ).toBeNull();
  });

  it('refuses the row this was written for: a winning label over a loss', () => {
    // The real shape, from publish-mixing-close-note.ts before the fix.
    const v = auditMixingVerdicts([
      fact({ kind: 'frontier-candidate', shape: 'confidence-escalated', costSaving: -0.12 }),
    ]);
    expect(v).toContain('frontier-candidate');
    expect(v).toContain("'no-win'");
  });

  it('refuses a win that saved exactly nothing — a tie is not cheaper', () => {
    expect(auditMixingVerdicts([fact({ costSaving: 0 })])).toContain('saved nothing');
  });

  it('refuses a win that scored below the best single', () => {
    expect(auditMixingVerdicts([fact({ qualityDeltaVsBestSingle: -0.05 })])).toContain('not a win');
  });

  it('refuses the lie pointed the OTHER way — a real win filed as no-win', () => {
    // Understating is not the safe error: it buries the result the loop exists to find.
    const v = auditMixingVerdicts([fact({ kind: 'no-win', costSaving: 0.5, qualityDeltaVsBestSingle: 0.02 })]);
    expect(v).toContain('understating a win');
  });

  it('names WHERE, so an operator can find the row', () => {
    expect(auditMixingVerdicts([fact({ clusterId: 'rewrite-edit', costSaving: -1 })])).toContain('rewrite-edit');
    // A vague finding has no cluster; the family still locates it.
    expect(auditMixingVerdicts([fact({ clusterId: undefined, costSaving: -1 })])).toContain('extractive');
  });

  it('is vacuously fine on an empty sheet', () => {
    expect(auditMixingVerdicts([])).toBeNull();
  });
});
