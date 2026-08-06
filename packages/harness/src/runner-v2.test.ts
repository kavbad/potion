// Runner v2 integration tests (ROADMAP M1a): --suite-v2 loading through the
// registry/loader, python code-exec items skipped with a clear warning, and a
// small end-to-end eval of the checked-in v2 code-gen suite on the mock
// provider. PGlite in-memory, zero services.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { EvalItem } from '@potion/core';
import { createDb, type DbHandle } from '@potion/db';
import { runEval, unrunnableReason, type RunDeps } from './runner.js';

const PRICES_PATH = fileURLToPath(new URL('../../../prices.json', import.meta.url));

// ---- tmp v2 suite mixing python + javascript code-exec items ----------------

function codeItem(id: string, language: 'javascript' | 'python'): EvalItem {
  return {
    id,
    clusterId: 'code-gen',
    prompt: [{ role: 'user', content: `EVAL: ${id}\nImplement something.` }],
    reference: language === 'javascript' ? 'function f() { return 1; }' : 'def f():\n    return 1\n',
    scoring: {
      kind: 'code-exec',
      language,
      tests:
        language === 'javascript'
          ? "test('f returns 1', () => assert(f() === 1));"
          : 'def check(candidate):\n    assert candidate() == 1\n',
    },
  };
}

const v2Dir = mkdtempSync(`${tmpdir()}/potion-runner-v2-`);
mkdirSync(`${v2Dir}/mixed-lang`, { recursive: true });
writeFileSync(
  `${v2Dir}/mixed-lang/manifest.json`,
  JSON.stringify({
    suiteId: 'mixed-lang',
    clusterId: 'code-gen',
    version: '1.0.0',
    source: { kind: 'authored', name: 'test fixture', license: 'Proprietary' },
    items: 'items.jsonl',
    scoring: { allowed: ['code-exec'] },
    createdAt: '2026-08-04T00:00:00.000Z',
  }),
);
writeFileSync(
  `${v2Dir}/mixed-lang/items.jsonl`,
  [codeItem('js-01', 'javascript'), codeItem('py-01', 'python'), codeItem('py-02', 'python')]
    .map((i) => JSON.stringify(i))
    .join('\n') + '\n',
);

describe('runEval v2 integration', () => {
  let handle: DbHandle;
  beforeAll(async () => {
    handle = await createDb('pglite://');
  });
  afterAll(async () => {
    await handle.close();
  });

  const deps = (): RunDeps => ({ db: handle, suitesV2Dir: v2Dir, pricesPath: PRICES_PATH });

  it('unrunnableReason flags only python code-exec items', () => {
    expect(unrunnableReason(codeItem('a', 'python'))).toContain('python-exec scorer');
    expect(unrunnableReason(codeItem('b', 'javascript'))).toBeNull();
  });

  it('skips python items with a clear warning and evals the JS ones', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const summary = await runEval(
        {
          suiteIds: [],
          suiteV2Ids: ['mixed-lang'],
          strategies: [{ type: 'single', model: 'mock-frontier' }],
          budgetCapUsd: 25,
        },
        deps(),
      );
      expect(summary.executed).toBe(1);
      expect(summary.skipped).toHaveLength(2);
      expect(summary.skipped.map((s) => s.itemId).sort()).toEqual(['py-01', 'py-02']);
      expect(summary.skipped[0]!.reason).toContain("language 'python'");
      expect(summary.skipped[0]!.reason).toContain('TODO');
      const warned = warn.mock.calls.map((c) => String(c[0])).join('\n');
      expect(warned).toContain("SKIP item 'py-01'");
      expect(warned).toContain("SKIP item 'py-02'");
      expect(warned).toContain('python-exec scorer');
      expect(summary.results).toHaveLength(1);
      expect(summary.results[0]!.itemId).toBe('js-01');
      expect(summary.aggregates).toHaveLength(1);
      expect(summary.aggregates[0]!.clusterId).toBe('code-gen');
      expect(summary.aggregates[0]!.n).toBe(1);
    } finally {
      warn.mockRestore();
    }
  }, 30_000);

  it('evals the checked-in code-gen-humaneval-js-v1 suite end-to-end on mock (12 items)', async () => {
    // No suitesV2Dir override → the real packages/harness/suites/v2 dir.
    const summary = await runEval(
      {
        suiteIds: [],
        suiteV2Ids: ['code-gen-humaneval-js-v1'],
        strategies: [{ type: 'single', model: 'mock-frontier' }],
        budgetCapUsd: 25,
      },
      { db: handle, pricesPath: PRICES_PATH },
    );
    expect(summary.skipped).toHaveLength(0);
    expect(summary.executed).toBe(12);
    expect(summary.results).toHaveLength(12);
    expect(summary.results.every((r) => r.scorer === 'code-exec')).toBe(true);
    expect(summary.results.every((r) => r.clusterId === 'code-gen')).toBe(true);
    expect(summary.aggregates).toHaveLength(1);
    const agg = summary.aggregates[0]!;
    expect(agg.clusterId).toBe('code-gen');
    expect(agg.n).toBe(12);
    // NOTE: the mock corpus does not know these new tasks (M1a decouples the
    // harness from the mock world), so answers are word-bank text scoring 0 —
    // the assertion is that the PIPELINE runs end-to-end deterministically.
    expect(agg.qualityMean).toBe(0);
    expect(agg.latencyP50).toBe(1800);
  }, 30_000);

  it('evals extraction-authored-v1 on mock end-to-end (30 repackaged items)', async () => {
    const summary = await runEval(
      {
        suiteIds: [],
        suiteV2Ids: ['extraction-authored-v1'],
        strategies: [{ type: 'single', model: 'mock-mid' }],
        budgetCapUsd: 25,
      },
      { db: handle, pricesPath: PRICES_PATH },
    );
    expect(summary.executed).toBe(30);
    expect(summary.skipped).toHaveLength(0);
    expect(summary.aggregates[0]!.clusterId).toBe('extraction');
    expect(summary.aggregates[0]!.n).toBe(30);
  }, 30_000);
});
