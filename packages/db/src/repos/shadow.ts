// Shadow-mode evidence repository (M3, ROADMAP #21, SPEC §12.4, migration
// 0007). shadow_results is append-only tenant data: the serving path's
// fire-and-forget shadow executor inserts one row per candidate execution;
// the savings report reads org-scoped windows grouped by candidate.
// Also home to the strategy_configs lookup used to resolve explicit
// candidate strategyHashes → StrategyConfig (the table predates #21 but had
// no repository until now).
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { StrategyConfig } from '@potion/core';
import type { PotionDb } from '../db.js';
import {
  shadowResults,
  strategyConfigs,
  type NewShadowResult,
  type ShadowResultRow,
} from '../schema.js';
import { isDayString, type UsageRange } from './usage.js';

/** Insert one shadow candidate outcome. Returns the generated uuid. */
export async function insertShadowResult(db: PotionDb, row: NewShadowResult): Promise<string> {
  const inserted = await db.insert(shadowResults).values(row).returning({ id: shadowResults.id });
  return inserted[0]!.id;
}

/**
 * Shadow rows for one org in [fromDay, toDay] (UTC days, inclusive — the
 * same window semantics as the usage rollup), oldest first. Org scoping is
 * mandatory: cross-org reads are impossible by construction.
 */
export async function listShadowResults(
  db: PotionDb,
  orgId: string,
  range: UsageRange,
): Promise<ShadowResultRow[]> {
  if (!isDayString(range.fromDay) || !isDayString(range.toDay)) {
    throw new Error(`days must be YYYY-MM-DD (got ${range.fromDay}..${range.toDay})`);
  }
  return db
    .select()
    .from(shadowResults)
    .where(
      and(
        eq(shadowResults.orgId, orgId),
        sql`to_char(${shadowResults.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD') BETWEEN ${range.fromDay} AND ${range.toDay}`,
      ),
    )
    .orderBy(asc(shadowResults.createdAt));
}

/** strategy_configs rows for a set of hashes (unknown hashes are simply
 * absent from the result). Used by the shadow executor to resolve explicit
 * candidate hashes and by the savings report to label candidates. */
export async function getStrategyConfigs(
  db: PotionDb,
  hashes: string[],
): Promise<Array<{ hash: string; config: StrategyConfig }>> {
  if (hashes.length === 0) return [];
  return db
    .select({ hash: strategyConfigs.hash, config: strategyConfigs.config })
    .from(strategyConfigs)
    .where(inArray(strategyConfigs.hash, hashes));
}

/** Upsert a strategy config by hash (idempotent — the hash IS the content
 * address, so a conflict means the same config). */
export async function upsertStrategyConfig(
  db: PotionDb,
  hash: string,
  config: StrategyConfig,
): Promise<void> {
  await db
    .insert(strategyConfigs)
    .values({ hash, config })
    .onConflictDoNothing({ target: strategyConfigs.hash });
}
