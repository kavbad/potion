// Staleness engine (ROADMAP M1a item 6): eval evidence is only as fresh as
// the versions it was measured under. markStale flags eval_results rows whose
//   · prices_version      != the current prices.json version,
//   · judge version        != the current judge model (llm-judge scorers embed
//                            it in the scorer string 'llm-judge:<model>'), or
//   · any model version    != the current resolved version for an alias the
//                            row actually used
// by setting stale = true. Downstream, pareto's aggregatesFromEvalResults
// excludes stale rows by default (includeStale override) so recomputed
// frontiers never mix drifted evidence into fresh aggregates.
import { and, eq, like, ne, or, sql, type SQL } from 'drizzle-orm';
import { evalResults, type PotionDb } from '@potion/db';

/** The versions evidence is compared against. A cause is only checked when
 * its current value is supplied. */
export interface StalenessCurrent {
  /** Current prices.json version (rows with any other prices_version flag). */
  pricesVersion?: string;
  /** Current resolved judge model; llm-judge rows scored by any other judge
   * flag. Deterministic scorers ('exact', 'code-exec', 'field-match') are
   * never flagged by this cause. */
  judgeModel?: string;
  /** alias → current resolved version. A row flags when it USED the alias
   * (jsonb key present) under a different version; rows that never used the
   * alias are untouched. */
  modelVersions?: Record<string, string>;
}

export interface StaleCounts {
  /** Rows newly flagged per cause (a row can match several causes). */
  byCause: {
    pricesVersion: number;
    judgeModel: number;
    modelVersions: number;
  };
  /** Distinct rows matching ≥1 cause that were not already stale. */
  newlyFlagged: number;
  /** Rows already carrying stale=true before this run. */
  alreadyStale: number;
  /** Total rows in eval_results. */
  scanned: number;
}

interface CauseConds {
  pricesVersion?: SQL | undefined;
  judgeModel?: SQL | undefined;
  modelVersions?: SQL | undefined;
  any?: SQL | undefined;
}

function causeConditions(current: StalenessCurrent): CauseConds {
  const out: CauseConds = {};
  if (current.pricesVersion !== undefined) {
    out.pricesVersion = ne(evalResults.pricesVersion, current.pricesVersion);
  }
  if (current.judgeModel !== undefined) {
    out.judgeModel = and(
      like(evalResults.scorer, 'llm-judge:%'),
      ne(evalResults.scorer, `llm-judge:${current.judgeModel}`),
    );
  }
  const perAlias = Object.entries(current.modelVersions ?? {}).map(
    ([alias, version]) =>
      sql`(${evalResults.modelVersions} ? ${alias}) AND (${evalResults.modelVersions} ->> ${alias} IS DISTINCT FROM ${version})`,
  );
  if (perAlias.length === 1) out.modelVersions = perAlias[0];
  else if (perAlias.length > 1) out.modelVersions = or(...perAlias);
  const causes = [out.pricesVersion, out.judgeModel, out.modelVersions].filter(
    (c): c is SQL => c !== undefined,
  );
  if (causes.length === 1) out.any = causes[0];
  else if (causes.length > 1) out.any = or(...causes);
  return out;
}

async function countWhere(db: PotionDb, cond: SQL | undefined): Promise<number> {
  if (!cond) return 0;
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(evalResults)
    .where(cond);
  return rows[0]?.n ?? 0;
}

/**
 * Inspect (without modifying) the staleness state of eval_results against
 * `current`: how many rows WOULD be newly flagged per cause.
 */
export async function stalenessReport(db: PotionDb, current: StalenessCurrent): Promise<StaleCounts> {
  const c = causeConditions(current);
  const notStale = eq(evalResults.stale, false);
  const [pricesVersion, judgeModel, modelVersions, newlyFlagged, alreadyStale, scanned] =
    await Promise.all([
      countWhere(db, c.pricesVersion ? and(notStale, c.pricesVersion) : undefined),
      countWhere(db, c.judgeModel ? and(notStale, c.judgeModel) : undefined),
      countWhere(db, c.modelVersions ? and(notStale, c.modelVersions) : undefined),
      countWhere(db, c.any ? and(notStale, c.any) : undefined),
      countWhere(db, eq(evalResults.stale, true)),
      countWhere(db, sql`true`),
    ]);
  return {
    byCause: { pricesVersion, judgeModel, modelVersions },
    newlyFlagged,
    alreadyStale,
    scanned,
  };
}

/**
 * markStale(db, current) — UPDATE eval_results SET stale = true for every row
 * whose prices/judge/model versions differ from the supplied current ones.
 * Idempotent (only non-stale rows are touched). Returns the same counts a
 * dry-run stalenessReport produced just before the update.
 */
export async function markStale(db: PotionDb, current: StalenessCurrent): Promise<StaleCounts> {
  const report = await stalenessReport(db, current);
  const c = causeConditions(current);
  if (c.any && report.newlyFlagged > 0) {
    await db
      .update(evalResults)
      .set({ stale: true })
      .where(and(eq(evalResults.stale, false), c.any));
  }
  return report;
}
