// A cache hit is the same measurement under a different suite. Until
// 2026-09-08 the runner pushed the STORED row — carrying the cluster it was
// first measured under — so any cell reused from a parent suite fell out of a
// boundary suite's aggregate. Both boundary frontiers published that day were
// measured on partial unions for every cached model.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EvalItem } from '@potion/core';
import { createDb, createOrg, migrate, type DbHandle } from '@potion/db';
import { evalTaskById } from '@potion/providers';
import { runEval } from './runner.js';

const PRICES_PATH = fileURLToPath(new URL('../../../prices.json', import.meta.url));
const item = (id: string, clusterId: string, slice?: string): EvalItem => {
  const task = evalTaskById(id)!;
  return { id: task.id, clusterId, prompt: [{ role: 'user', content: `EVAL: ${task.id}\n${task.task}\n\nRespond with ONLY the JSON object.` }], reference: JSON.parse(task.reference) as unknown, scoring: { kind: 'field-match', schema: task.schema ?? {} }, ...(slice ? { slice } : {}) };
};
const dir = mkdtempSync(`${tmpdir()}/potion-rekey-`);
writeFileSync(`${dir}/parent.jsonl`, [item('ex-01', 'parent'), item('ex-02', 'parent')].map((i) => JSON.stringify(i)).join('\n') + '\n');
writeFileSync(`${dir}/parent-other.jsonl`, [item('ex-01', 'parent-other', 'parent'), item('ex-02', 'parent-other', 'parent')].map((i) => JSON.stringify(i)).join('\n') + '\n');

describe('a cached cell is re-keyed to the suite that reuses it', () => {
  let handle: DbHandle;
  beforeAll(async () => { handle = await createDb('pglite://'); await migrate(handle.db); await createOrg(handle.db, { id: 'org-rekey', name: 'rekey' }); });
  afterAll(async () => { await handle.close(); });
  it('a boundary suite aggregates the cells its parent already paid for', async () => {
    const deps = { db: handle, suitesDir: dir, pricesPath: PRICES_PATH };
    const strategies = [{ type: 'single' as const, model: 'mock-frontier' }];
    const first = await runEval({ suiteIds: ['parent'], strategies, budgetCapUsd: 25, orgId: 'org-rekey' }, deps);
    expect(first.executed).toBe(2);
    const second = await runEval({ suiteIds: ['parent-other'], strategies, budgetCapUsd: 25, orgId: 'org-rekey', resume: true }, deps);
    expect(second.cacheHits).toBe(2);
    expect(second.executed).toBe(0);
    expect(second.aggregates).toHaveLength(1);
    expect(second.aggregates[0]?.clusterId).toBe('parent-other');
    expect(second.aggregates[0]?.n).toBe(2);
    expect(second.results.every((r) => r.clusterId === 'parent-other')).toBe(true);
  });
});
