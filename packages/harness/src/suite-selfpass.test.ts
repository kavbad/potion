// Suite self-pass gate (G0.5): every code-exec item's REFERENCE solution
// must pass 100% of its own tests in the real sandbox — a wrong reference
// poisons the benchmark, so this is a permanent mechanical quality gate for
// every code-exec suite, not a one-off authoring check. Also validates the
// new suites' shape (counts, id patterns, tiers).
import { describe, expect, it } from 'vitest';
import { loadSuiteV2 } from './ingest/suite-v2.js';
import { scoreCodeExec } from './code-exec-sandbox.js';

const CODE_EXEC_SUITES = ['code-gen-humaneval-js-v1', 'code-gen-potion-v2'];

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
