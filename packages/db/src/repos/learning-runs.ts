// AUTONOMOUS LEARNING LEDGER (SERVING-ROADMAP S7 L4).
//
// Reads and writes for the row the probe writes instead of a human. The one
// query that matters is `spentTodayUsd`: it is what a standing daily cap
// means operationally, and it deliberately counts a RUNNING row's projection
// as spent (see below) rather than only completed actuals.
import { and, desc, gte, lt, sql } from 'drizzle-orm';
import type { PotionDb } from '../db.js';
import { learningRuns, type LearningRunRow, type NewLearningRun } from '../schema.js';

export async function insertLearningRun(db: PotionDb, row: NewLearningRun): Promise<void> {
  await db.insert(learningRuns).values(row);
}

export async function updateLearningRun(
  db: PotionDb,
  id: string,
  patch: Partial<NewLearningRun>,
): Promise<void> {
  await db.update(learningRuns).set(patch).where(sql`${learningRuns.id} = ${id}`);
}

/** UTC day bounds for a timestamp. */
export function utcDayBounds(at: Date): { start: Date; end: Date } {
  const start = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start, end };
}

/**
 * What autonomous learning has committed today, in USD.
 *
 * A RUNNING row counts at its PROJECTION, not at zero. A cap that only
 * counted finished runs would authorize a second run while the first is
 * still buying tokens, and two concurrent runs could each spend the whole
 * day's budget. Over-counting an in-flight run delays the next probe by
 * minutes; under-counting it doubles the day's spend.
 *
 * 'refused' rows contribute nothing — they never spent.
 */
export async function spentTodayUsd(db: PotionDb, at: Date = new Date()): Promise<number> {
  const { start, end } = utcDayBounds(at);
  const rows = await db
    .select({
      total: sql<number>`coalesce(sum(
        case
          when ${learningRuns.status} = 'refused' then 0
          when ${learningRuns.status} = 'planned' then 0
          when ${learningRuns.actualUsd} is not null then ${learningRuns.actualUsd}
          else ${learningRuns.projectedUsd}
        end
      ), 0)::float8`,
    })
    .from(learningRuns)
    .where(and(gte(learningRuns.startedAt, start), lt(learningRuns.startedAt, end)));
  return Number(rows[0]?.total ?? 0);
}

export async function listLearningRuns(db: PotionDb, limit = 50): Promise<LearningRunRow[]> {
  return db.select().from(learningRuns).orderBy(desc(learningRuns.startedAt)).limit(limit);
}
