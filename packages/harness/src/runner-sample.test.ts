// Lab Step 5: itemSampleN — the deterministic sample the platform sweep's
// Tier B rides. First N by item-id sort, byte-stable; because cache keys
// are per item id, a later full run reuses every sampled cell and pays only
// for the remainder (asserted below via resume cacheHits).
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { createDb } from '@potion/db';
import { migrate } from '@potion/db';
import type { StrategyConfig } from '@potion/core';
import { loadSuite } from './suites.js';
import { runEval } from './runner.js';

const REPO_PRICES = fileURLToPath(new URL('../../../prices.json', import.meta.url));
const SUITE = 'summarization';
const strategies: StrategyConfig[] = [{ type: 'single', model: 'mock-mid' }];

describe('itemSampleN', () => {
  it('runs exactly the first N items by id sort; a full run then pays only the remainder', async () => {
    const db = await createDb();
    await migrate(db.db);
    try {
      const expected = loadSuite(SUITE)
        .map((i) => i.id)
        .sort()
        .slice(0, 5);

      const first = await runEval(
        { suiteIds: [SUITE], strategies, budgetCapUsd: 1000, resume: true, itemSampleN: 5 },
        { db, pricesPath: REPO_PRICES },
      );
      expect(first.results.map((r) => r.itemId).sort()).toEqual(expected);
      expect(first.executed).toBe(5);

      // Byte-stable: the same sample re-runs as pure cache hits.
      const second = await runEval(
        { suiteIds: [SUITE], strategies, budgetCapUsd: 1000, resume: true, itemSampleN: 5 },
        { db, pricesPath: REPO_PRICES },
      );
      expect(second.executed).toBe(0);
      expect(second.cacheHits).toBe(5);

      // The Tier-B → full-run upgrade path: sampled cells are reused.
      const all = loadSuite(SUITE).length;
      const full = await runEval(
        { suiteIds: [SUITE], strategies, budgetCapUsd: 1000, resume: true },
        { db, pricesPath: REPO_PRICES },
      );
      expect(full.cacheHits).toBe(5);
      expect(full.executed).toBe(all - 5);
    } finally {
      await db.close();
    }
  });

  it('the projection binds to the SAMPLED set, not the full suite', async () => {
    const db = await createDb();
    await migrate(db.db);
    try {
      // A cap that fits 2 items but not the full 15-item suite: with
      // itemSampleN it runs; without it the preflight refuses. If sampling
      // ever slipped to after the projection, this test fails.
      const two = await runEval(
        { suiteIds: [SUITE], strategies, budgetCapUsd: 1000, resume: false, itemSampleN: 2 },
        { db, pricesPath: REPO_PRICES },
      );
      const perItem = two.projectedSpendUsd / 2;
      const cap = perItem * 3; // room for 2, not for 15
      const sampled = await runEval(
        { suiteIds: [SUITE], strategies, budgetCapUsd: cap, resume: false, itemSampleN: 2 },
        { db, pricesPath: REPO_PRICES },
      );
      expect(sampled.executed).toBe(2);
      await expect(
        runEval(
          { suiteIds: [SUITE], strategies, budgetCapUsd: cap, resume: false },
          { db, pricesPath: REPO_PRICES },
        ),
      ).rejects.toThrow(/projected/i);
    } finally {
      await db.close();
    }
  });

  it('rejects a non-positive or fractional sample size', async () => {
    const db = await createDb();
    await migrate(db.db);
    try {
      for (const bad of [0, -1, 1.5]) {
        await expect(
          runEval(
            { suiteIds: [SUITE], strategies, budgetCapUsd: 1000, itemSampleN: bad },
            { db, pricesPath: REPO_PRICES },
          ),
        ).rejects.toThrow(/itemSampleN/);
      }
    } finally {
      await db.close();
    }
  });
});
