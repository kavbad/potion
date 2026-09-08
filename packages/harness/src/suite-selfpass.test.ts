// Suite self-pass gate (G0.5): every code-exec item's REFERENCE solution
// must pass 100% of its own tests in the real sandbox — a wrong reference
// poisons the benchmark, so this is a permanent mechanical quality gate for
// every code-exec suite, not a one-off authoring check. Also validates the
// new suites' shape (counts, id patterns, tiers).
import { describe, expect, it } from 'vitest';
import { loadSuiteV2 } from './ingest/suite-v2.js';
import { scoreCodeExec } from './code-exec-sandbox.js';
import { scoreExact } from './scorers.js';

const CODE_EXEC_SUITES = ['code-gen-humaneval-js-v1', 'code-gen-potion-v2', 'code-gen-hard-v1', 'code-gen-hard-v2'];

describe('code-exec suite self-pass gate', () => {
  for (const suiteId of CODE_EXEC_SUITES) {
    it(`${suiteId}: every reference passes 100% of its own tests`, { timeout: 240_000 }, async () => {
      const { items } = loadSuiteV2(suiteId);
      expect(items.length).toBeGreaterThan(0);
      const failures: string[] = [];
      for (const item of items) {
        if (item.scoring.kind !== 'code-exec') {
          failures.push(`${item.id}: not code-exec`);
          continue;
        }
        expect(typeof item.reference).toBe('string');
        const { quality, report } = await scoreCodeExec(item.reference as string, item.scoring);
        if (quality !== 1) {
          failures.push(
            `${item.id}: ${report.passed}/${report.total} (${report.failures.slice(0, 2).join('; ')})`,
          );
        }
      }
      expect(failures, failures.join('\n')).toEqual([]);
    });
  }
});

describe('code-gen-potion-v2 shape (G0.5)', () => {
  it('60 items, tiered ids, >=5 tests each', () => {
    const { items, manifest } = loadSuiteV2('code-gen-potion-v2');
    expect(items).toHaveLength(60);
    expect(manifest.clusterId).toBe('code-gen');
    const easy = items.filter((i) => /^cg2-e\d{2}$/.test(i.id));
    const medium = items.filter((i) => /^cg2-m\d{2}$/.test(i.id));
    const hard = items.filter((i) => /^cg2-h\d{2}$/.test(i.id));
    expect([easy.length, medium.length, hard.length]).toEqual([20, 25, 15]);
    for (const item of items) {
      const tests = (item.scoring as { tests: string }).tests;
      const count = (tests.match(/test\(/g) ?? []).length;
      expect(count, `${item.id} has ${count} tests`).toBeGreaterThanOrEqual(5);
    }
  });
});

describe('extraction-potion-v2 shape (G0.5)', () => {
  it('50 discriminative field-match items: 6-10 fields, >=1 array field each', () => {
    const { items, manifest } = loadSuiteV2('extraction-potion-v2');
    expect(items).toHaveLength(50);
    expect(manifest.clusterId).toBe('extraction');
    for (const item of items) {
      expect(item.scoring.kind).toBe('field-match');
      const schema = (item.scoring as { schema: Record<string, string> }).schema;
      const fieldCount = Object.keys(schema).length;
      expect(fieldCount, `${item.id} has ${fieldCount} fields`).toBeGreaterThanOrEqual(6);
      expect(fieldCount).toBeLessThanOrEqual(10);
      expect(Object.values(schema)).toContain('array');
      // reference covers exactly the schema keys
      expect(Object.keys(item.reference as Record<string, unknown>).sort()).toEqual(
        Object.keys(schema).sort(),
      );
    }
  });
});

// ---- the four hardened suites (ceiling-effect remediation) ----------------
//
// The four clusters below sat at 0.970-1.000 across every surviving frontier
// point, i.e. the suites had stopped discriminating between models regardless
// of sample size. These gates hold the replacements to the properties that
// make them discriminate, so a later well-meaning edit cannot quietly restore
// the ceiling.

describe('code-gen-hard-v1 shape', () => {
  it('30 retrieval-hostile items, tiered ids, >=8 tests each', () => {
    const { items, manifest } = loadSuiteV2('code-gen-hard-v1');
    expect(items).toHaveLength(30);
    expect(manifest.clusterId).toBe('code-gen');
    const trap = items.filter((i) => /^cgh-t\d{2}$/.test(i.id));
    const composed = items.filter((i) => /^cgh-c\d{2}$/.test(i.id));
    const precision = items.filter((i) => /^cgh-p\d{2}$/.test(i.id));
    expect([trap.length, composed.length, precision.length]).toEqual([8, 12, 10]);
    for (const item of items) {
      expect(item.scoring.kind).toBe('code-exec');
      const tests = (item.scoring as { tests: string }).tests;
      const count = (tests.match(/test\(/g) ?? []).length;
      // 8 rather than code-gen-potion-v2's 5: fractional credit is the only
      // thing separating models once the ceiling is gone, so each item needs
      // enough cases to resolve a partial answer.
      expect(count, `${item.id} has ${count} tests`).toBeGreaterThanOrEqual(8);
    }
  });
});

describe('code-gen-hard-v2 shape (A3)', () => {
  it('42 items: the 30 v1 items plus a 12-item frontier tier, >=8 tests each', () => {
    const { items, manifest } = loadSuiteV2('code-gen-hard-v2');
    expect(items).toHaveLength(42);
    expect(manifest.clusterId).toBe('code-gen');
    const trap = items.filter((i) => /^cgh-t\d{2}$/.test(i.id));
    const composed = items.filter((i) => /^cgh-c\d{2}$/.test(i.id));
    const precision = items.filter((i) => /^cgh-p\d{2}$/.test(i.id));
    const frontier = items.filter((i) => /^cgh-f\d{2}$/.test(i.id));
    expect([trap.length, composed.length, precision.length, frontier.length]).toEqual([8, 12, 10, 12]);
    for (const item of items) {
      expect(item.scoring.kind).toBe('code-exec');
      const tests = (item.scoring as { tests: string }).tests;
      const count = (tests.match(/test\(/g) ?? []).length;
      expect(count, `${item.id} has ${count} tests`).toBeGreaterThanOrEqual(8);
    }
    // The frontier tier's reason to exist: v1 saturated (champion 1.000 across
    // salted runs, 2026-08-24). Keeping v1's items preserves mid-tier
    // separation; these gates keep a later edit from quietly dropping the tail.
  });
});

describe('classification-hard-v2 shape (A3)', () => {
  it('40 items in 8 families; a constant guesser still cannot beat 0.45', () => {
    const { items, manifest } = loadSuiteV2('classification-hard-v2');
    expect(items).toHaveLength(40);
    expect(manifest.clusterId).toBe('classification');
    const byFamily = new Map<string, string[]>();
    for (const item of items) {
      expect(item.scoring.kind).toBe('exact');
      expect(typeof item.reference).toBe('string');
      const family = item.id.slice(4, 5);
      byFamily.set(family, [...(byFamily.get(family) ?? []), item.reference as string]);
    }
    expect(byFamily.size).toBe(8);
    let floor = 0;
    for (const refs of byFamily.values()) {
      const counts = new Map<string, number>();
      for (const r of refs) counts.set(r, (counts.get(r) ?? 0) + 1);
      floor += Math.max(...counts.values());
    }
    expect(floor / items.length).toBeLessThanOrEqual(0.45);
  });
});

describe('extraction-hard-v1 shape', () => {
  it('24 adversarial items, 8 fields each, >=1 array field', () => {
    const { items, manifest } = loadSuiteV2('extraction-hard-v1');
    expect(items).toHaveLength(24);
    expect(manifest.clusterId).toBe('extraction');
    for (const item of items) {
      expect(item.scoring.kind).toBe('field-match');
      const schema = (item.scoring as { schema: Record<string, string> }).schema;
      expect(Object.keys(schema)).toHaveLength(8);
      expect(Object.values(schema)).toContain('array');
      expect(Object.keys(item.reference as Record<string, unknown>).sort()).toEqual(
        Object.keys(schema).sort(),
      );
    }
  });
});

describe('classification-hard-v1 shape', () => {
  it('30 rule-application items in 6 families; a constant guesser cannot beat 0.45', () => {
    const { items, manifest } = loadSuiteV2('classification-hard-v1');
    expect(items).toHaveLength(30);
    expect(manifest.clusterId).toBe('classification');
    const byFamily = new Map<string, string[]>();
    for (const item of items) {
      expect(item.scoring.kind).toBe('exact');
      expect(typeof item.reference).toBe('string');
      const family = item.id.slice(4, 5);
      byFamily.set(family, [...(byFamily.get(family) ?? []), item.reference as string]);
    }
    expect(byFamily.size).toBe(6);
    // The label floor is the property that makes this suite discriminate: if a
    // later edit skews the label balance, always-guess-one-label starts
    // scoring well and the ceiling comes back by a different door.
    let floor = 0;
    for (const refs of byFamily.values()) {
      const counts = new Map<string, number>();
      for (const r of refs) counts.set(r, (counts.get(r) ?? 0) + 1);
      floor += Math.max(...counts.values());
    }
    expect(floor / items.length).toBeLessThanOrEqual(0.45);
  });
});

describe('code-review-hard-v1 shape', () => {
  it('28 items, majority judge-free, with no-bug controls on both scorers', () => {
    const { items, manifest } = loadSuiteV2('code-review-hard-v1');
    expect(items).toHaveLength(28);
    expect(manifest.clusterId).toBe('code-review');
    const exact = items.filter((i) => i.scoring.kind === 'exact');
    const judge = items.filter((i) => i.scoring.kind === 'llm-judge');
    expect(exact.length + judge.length).toBe(items.length);
    // More than half the cluster's signal must not depend on a judge — that is
    // the point of this suite, not an incidental ratio.
    expect(exact.length).toBeGreaterThan(judge.length);

    // No-bug controls. The suite this replaces had ZERO, and a rubric reading
    // "0 = declares the code correct", so it paid models to invent defects.
    const none = exact.filter((i) => i.reference === 'NONE');
    expect(none.length).toBeGreaterThanOrEqual(4);
    const cleanRubrics = judge.filter((i) =>
      (i.scoring as { rubric: string }).rubric.includes('NO CORRECTNESS DEFECT'),
    );
    expect(cleanRubrics.length).toBeGreaterThanOrEqual(3);

    // Every seeded-defect rubric prices false positives.
    for (const item of judge) {
      const rubric = (item.scoring as { rubric: string }).rubric;
      const isClean = rubric.includes('NO CORRECTNESS DEFECT');
      expect(
        isClean || rubric.includes('SUBTRACT 2 POINTS'),
        `${item.id} rubric does not penalise asserted non-defects`,
      ).toBe(true);
    }
  });
});

describe('extraction-hard-v2 shape (the messy tier, 2026-08-26)', () => {
  it('40 items: all 24 v1 items verbatim + 16 messy-tier items with 6 fields each', () => {
    const { items, manifest } = loadSuiteV2('extraction-hard-v2');
    expect(items).toHaveLength(40);
    expect(manifest.clusterId).toBe('extraction');
    const v1 = loadSuiteV2('extraction-hard-v1').items;
    for (const [i, old] of v1.entries()) {
      expect(items[i]!.id).toBe(old.id);
      expect(items[i]!.reference).toEqual(old.reference);
    }
    const messy = items.slice(24);
    expect(messy.every((it) => it.id.startsWith('exh2-m'))).toBe(true);
    for (const item of messy) {
      expect(item.scoring.kind).toBe('field-match');
      const schema = (item.scoring as { schema: Record<string, string> }).schema;
      expect(Object.keys(schema)).toHaveLength(6);
      expect(Object.keys(item.reference as Record<string, unknown>).sort()).toEqual(
        Object.keys(schema).sort(),
      );
    }
  });
});

describe('extraction-confirm-v1 (the first LOCKED holdout)', () => {
  it('refuses the default (search) purpose — the sweep can never read it', () => {
    expect(() => loadSuiteV2('extraction-confirm-v1')).toThrow(/LOCKED/);
  });
  it('loads under confirmation: 8 messy holdout items, field-match only', () => {
    const { items, manifest } = loadSuiteV2('extraction-confirm-v1', undefined, 'confirmation');
    expect(manifest.locked).toBe(true);
    expect(items).toHaveLength(8);
    expect(items.every((it) => it.id.startsWith('exc-'))).toBe(true);
    expect(items.every((it) => it.scoring.kind === 'field-match')).toBe(true);
  });
});

describe('rewrite-edit-hard-v1 shape (the constraint tier, 2026-08-26)', () => {
  it('28 items: 14 flat items ported + 14 rubric-anchored constraint items', () => {
    const { items, manifest } = loadSuiteV2('rewrite-edit-hard-v1');
    expect(items).toHaveLength(28);
    expect(manifest.clusterId).toBe('rewrite-edit');
    const tier = items.slice(14);
    expect(tier.every((it) => it.id.startsWith('rwh-'))).toBe(true);
    for (const item of items) {
      expect(item.scoring.kind).toBe('llm-judge');
      const s = item.scoring as { rubric: string; judgeModel: string; scale: [number, number] };
      expect(s.judgeModel).toBe('judge-class');
      expect(s.scale).toEqual([0, 10]);
      // Rubric-anchored: every rubric carries its checklist and the shared scale.
      expect(s.rubric).toContain('Criteria:');
      expect(s.rubric).toContain('General scale:');
    }
  });
});

describe('rewrite-confirm-v1 (LOCKED holdout)', () => {
  it('refuses search purpose; loads 6 items under confirmation', () => {
    expect(() => loadSuiteV2('rewrite-confirm-v1')).toThrow(/LOCKED/);
    const { items, manifest } = loadSuiteV2('rewrite-confirm-v1', undefined, 'confirmation');
    expect(manifest.locked).toBe(true);
    expect(items).toHaveLength(6);
    expect(items.every((it) => it.id.startsWith('rwc-'))).toBe(true);
  });
});

// Reasoning-suite instrument gate (2026-09-07). The flat multi-step-reasoning
// suite told models to "Solve step by step" and then compared the WHOLE answer
// to a bare gold value, so it scored output-format obedience rather than
// arithmetic: measured live, or-solar-pro4 and or-gemini-flash got 0.000 on
// whole-text exact and 1.000 on the extracted answer over the same items, and
// the compiled frontier rated gpt-4.1 at 0.56 on grade-school sums. This gate
// asserts the property that was missing: on a suite whose prompts ask for
// visible reasoning, a CORRECT answer that shows its work must score 1.
const REASONING_SUITES = ['multi-step-reasoning-v2', 'gsm8k-v1'];

describe('reasoning suite instrument gate', () => {
  for (const suiteId of REASONING_SUITES) {
    it(`${suiteId}: correct answers with visible reasoning score 1, wrong ones score 0`, () => {
      const { items } = loadSuiteV2(suiteId);
      expect(items.length).toBeGreaterThan(0);
      const problems: string[] = [];
      for (const item of items) {
        if (item.scoring.kind !== 'exact' || item.scoring.extract === undefined) {
          problems.push(`${item.id}: scoring ${JSON.stringify(item.scoring)} reads the whole answer`);
          continue;
        }
        const gold = String(item.reference);
        const shown = `Let me work through it.\nStep 1: ...\nStep 2: ...\nFinal answer: ${gold}`;
        if (scoreExact(shown, item.reference, item.scoring) !== 1) {
          problems.push(`${item.id}: correct answer with shown work scored 0 (gold ${gold})`);
        }
        const wrong = `Step 1: ...\nFinal answer: ${gold === '99' ? '98' : '99'}`;
        if (scoreExact(wrong, item.reference, item.scoring) !== 0) {
          problems.push(`${item.id}: a WRONG answer scored above 0 (gold ${gold})`);
        }
      }
      expect(problems, problems.join('\n')).toEqual([]);
    });
  }

  // The prompt must actually ask for the label the scorer reads, or the
  // extractor silently falls back to whole-text compare on every item.
  it('multi-step-reasoning-v2: every item mandates the Final answer label', () => {
    const { items, manifest } = loadSuiteV2('multi-step-reasoning-v2');
    expect(items).toHaveLength(50);
    expect(manifest.clusterId).toBe('multi-step-reasoning');
    for (const item of items) {
      const text = item.prompt.map((m) => m.content).join('\n');
      expect(text, `${item.id} never asks for the label`).toMatch(/Final answer:/);
      expect(text, `${item.id} still carries a whole-answer format demand`).not.toMatch(/Answer with/);
    }
    const numeric = items.filter((i) => (i.scoring as { extract?: string }).extract === 'final-number');
    expect(numeric).toHaveLength(37);
  });
});
