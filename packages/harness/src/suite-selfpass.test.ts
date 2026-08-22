// Suite self-pass gate (G0.5): every code-exec item's REFERENCE solution
// must pass 100% of its own tests in the real sandbox — a wrong reference
// poisons the benchmark, so this is a permanent mechanical quality gate for
// every code-exec suite, not a one-off authoring check. Also validates the
// new suites' shape (counts, id patterns, tiers).
import { describe, expect, it } from 'vitest';
import { loadSuiteV2 } from './ingest/suite-v2.js';
import { scoreCodeExec } from './code-exec-sandbox.js';

const CODE_EXEC_SUITES = ['code-gen-humaneval-js-v1', 'code-gen-potion-v2', 'code-gen-hard-v1'];

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
