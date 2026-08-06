// Chaos: DB killed mid-eval (ROADMAP #29, SPEC §12.9).
//
// TRUE BEHAVIOR (documented, tested here):
//   · runEval persists each (strategy × item) result row AS IT COMPLETES —
//     there is no run-level transaction. Killing the db mid-run therefore
//     leaves PARTIAL rows: exactly the items completed before the kill.
//   · The run REJECTS with a typed drizzle error (DrizzleQueryError —
//     "Failed query: …") whose cause chain carries the driver detail
//     ("PGlite is closed"). The runner does NOT swallow it.
//   · Re-running is IDEMPOTENT thanks to the content-addressed cacheKey:
//     a fresh handle on the SAME data dir + resume:true reuses the partial
//     rows (cacheHits) and completes the rest without duplicates. The
//     cacheKey unique index is the cleanup mechanism — there is nothing to
//     roll back.
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { EvalItem, StrategyConfig } from '@potion/core';
import { createDb, evalResults, migrate, type PotionDb } from '@potion/db';
import { runEval } from '@potion/harness';

const PRICES_PATH = fileURLToPath(new URL('../../../prices.json', import.meta.url));

// 20 synthetic extraction items (field-match scoring — no judge calls, so the
// run is pure strategy→insert cycles and the kill window is easy to hit).
function item(id: string): EvalItem {
  return {
    id,
    clusterId: 'chaos-extraction',
    prompt: [{ role: 'user', content: `Extract JSON for chaos item ${id}` }],
    reference: { id },
    scoring: { kind: 'field-match', schema: {} },
  };
}
const ITEM_COUNT = 20;
const suiteDir = mkdtempSync(`${tmpdir()}/potion-chaos-suites-`);
writeFileSync(
  `${suiteDir}/chaos-extraction.jsonl`,
  Array.from({ length: ITEM_COUNT }, (_, i) =>
    JSON.stringify(item(`cx-${String(i).padStart(2, '0')}`)),
  ).join('\n') + '\n',
);
mkdirSync(`${suiteDir}/simulated`, { recursive: true });

const STRATEGY: StrategyConfig = { type: 'single', model: 'mock-cheap' };

async function rowCount(db: PotionDb): Promise<number> {
  return (await db.select().from(evalResults)).length;
}

describe('chaos: db killed mid-eval', () => {
  it(
    'run rejects with a typed db error; partial rows remain; resume re-run is idempotent',
    { timeout: 120_000 },
    async () => {
      const dataDir = mkdtempSync(`${tmpdir()}/potion-chaos-db-`);
      const handle = await createDb(`pglite://${dataDir}`);
      await migrate(handle.db);

      // Kill switch: poll the row count on the SAME handle; once the runner
      // has persisted a few rows, close the db out from under it.
      let killed = false;
      const killer = (async () => {
        while (!killed) {
          try {
            const n = await rowCount(handle.db);
            if (n >= 3) {
              killed = true;
              await handle.close();
              return;
            }
          } catch {
            // db already closed / query raced the kill — done either way
            return;
          }
        }
      })();

      const err = await runEval(
        {
          suiteIds: ['chaos-extraction'],
          strategies: [STRATEGY],
          budgetCapUsd: 100,
          provider: 'mock',
        },
        { db: handle, suitesDir: suiteDir, pricesPath: PRICES_PATH },
      ).then(
        () => null,
        (e: unknown) => e,
      );
      await killer;
      expect(killed).toBe(true);

      // Typed error: drizzle 0.45 wraps driver failures in DrizzleQueryError;
      // the cause chain carries the driver detail ("PGlite is closed").
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).constructor.name).toBe('DrizzleQueryError');
      const chain: string[] = [];
      for (let cur: unknown = err; cur instanceof Error; cur = (cur as { cause?: unknown }).cause) {
        chain.push(cur.message);
      }
      expect(chain.join(' | ')).toMatch(/PGlite is clos(ed|ing)/i);

      // Partial semantics: rows exist for the items completed BEFORE the
      // kill, and ONLY those — never all ITEM_COUNT.
      // (The handle is closed, so read via a fresh handle on the same dir.)
      const reopened = await createDb(`pglite://${dataDir}`);
      const partialRows = await reopened.db.select().from(evalResults);
      expect(partialRows.length).toBeGreaterThanOrEqual(3);
      expect(partialRows.length).toBeLessThan(ITEM_COUNT);
      await reopened.close();

      // Idempotent re-run: resume:true on the same data dir reuses the
      // partial rows and completes the run — no duplicates, one row per item.
      const handle2 = await createDb(`pglite://${dataDir}`);
      try {
        const summary = await runEval(
          {
            suiteIds: ['chaos-extraction'],
            strategies: [STRATEGY],
            budgetCapUsd: 100,
            provider: 'mock',
            resume: true,
          },
          { db: handle2, suitesDir: suiteDir, pricesPath: PRICES_PATH },
        );
        expect(summary.executed + summary.cacheHits).toBe(ITEM_COUNT);
        expect(summary.cacheHits).toBe(partialRows.length); // partial work reused, not redone
        const finalRows = await handle2.db.select().from(evalResults);
        expect(finalRows).toHaveLength(ITEM_COUNT);
        const keys = new Set(finalRows.map((r) => r.cacheKey));
        expect(keys.size).toBe(ITEM_COUNT); // zero duplicates
      } finally {
        await handle2.close();
      }
    },
  );
});
