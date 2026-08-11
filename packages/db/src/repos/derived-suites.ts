// Derived-suite storage repo (G1.3, migration 0021): trace-synthesized
// suites in governed db storage. The MERGE/CAP/VERSION-BUMP semantics mirror
// the pre-G1.3 file writer exactly: new items merge via onConflictDoNothing,
// the roster is the deterministic id-ordered head up to the cap, and the
// suite's patch version bumps only when the item roster changed.
import { and, asc, eq, lt, sql } from 'drizzle-orm';
import { suiteContentHash, type EvalItem } from '@potion/core';
import type { PotionDb } from '../db.js';
import {
  derivedSuiteItems,
  derivedSuites,
  type DerivedSuiteItemRow,
  type DerivedSuiteRow,
} from '../schema.js';

export interface DerivedSuiteUpsert {
  suiteId: string;
  clusterId: string;
  orgId: string;
  manifest: Record<string, unknown>;
  /** Candidate items (item ids must be suite-unique; dupes are skipped). */
  items: Array<EvalItem & { sourceTraceId?: string }>;
  /** Deterministic roster cap (id-ordered head — pre-G1.3 semantics). */
  itemCap: number;
}

export interface DerivedSuiteUpsertResult {
  created: boolean;
  itemsAdded: number;
  version: string;
}

function bumpPatch(version: string): string {
  const [maj, min, patch] = version.split('.').map((v) => Number(v));
  return `${maj ?? 1}.${min ?? 0}.${(patch ?? 0) + 1}`;
}

/** Create-or-merge a derived suite. Returns creation flag, items actually
 * added (post-dedupe, post-cap), and the resulting version. */
export async function upsertDerivedSuite(
  db: PotionDb,
  input: DerivedSuiteUpsert,
): Promise<DerivedSuiteUpsertResult> {
  const existing = await db
    .select()
    .from(derivedSuites)
    .where(eq(derivedSuites.suiteId, input.suiteId));
  const created = existing.length === 0;
  if (created) {
    await db.insert(derivedSuites).values({
      suiteId: input.suiteId,
      clusterId: input.clusterId,
      orgId: input.orgId,
      manifest: input.manifest,
      version: '1.0.0',
    });
  }
  const before = await db
    .select({ itemId: derivedSuiteItems.itemId })
    .from(derivedSuiteItems)
    .where(eq(derivedSuiteItems.suiteId, input.suiteId));
  const beforeIds = new Set(before.map((r) => r.itemId));

  // Deterministic roster: existing ∪ candidates, id-ordered head up to cap.
  const candidateById = new Map(input.items.map((i) => [i.id, i]));
  const rosterIds = [...new Set([...beforeIds, ...candidateById.keys()])]
    .sort()
    .slice(0, input.itemCap);
  let itemsAdded = 0;
  for (const id of rosterIds) {
    if (beforeIds.has(id)) continue;
    const item = candidateById.get(id);
    if (!item) continue;
    await db
      .insert(derivedSuiteItems)
      .values({
        suiteId: input.suiteId,
        itemId: item.id,
        clusterId: item.clusterId,
        prompt: item.prompt,
        reference: item.reference ?? null,
        scoring: item.scoring,
        sourceTraceId: item.sourceTraceId ?? null,
      })
      .onConflictDoNothing();
    itemsAdded += 1;
  }

  let version = created ? '1.0.0' : (existing[0]!.version ?? '1.0.0');
  if (!created && itemsAdded > 0) {
    version = bumpPatch(version);
    await db
      .update(derivedSuites)
      .set({ version, updatedAt: new Date() })
      .where(eq(derivedSuites.suiteId, input.suiteId));
  }
  return { created, itemsAdded, version };
}

export interface LoadedDerivedSuite {
  suite: DerivedSuiteRow;
  items: EvalItem[];
}

/**
 * Resolve a cluster's CURRENT derived suite id (post-capstone item 2): the
 * step-level generation (`-replays-v2`) when it exists with items, else the
 * session-level `-replays-v1`. One resolver instead of three hardcoded
 * `${clusterId}-replays-v1` call sites — when a cluster flips to step-level
 * synthesis, every consumer (suite-verify, live-sweep, rubric generation)
 * follows in the same commit, and legacy clusters keep resolving to v1.
 */
export async function derivedSuiteIdFor(db: PotionDb, clusterId: string): Promise<string> {
  const v2 = `${clusterId}-replays-v2`;
  const rows = await db
    .select({ itemId: derivedSuiteItems.itemId })
    .from(derivedSuiteItems)
    .where(eq(derivedSuiteItems.suiteId, v2))
    .limit(1);
  return rows.length > 0 ? v2 : `${clusterId}-replays-v1`;
}

/** Load a derived suite + items (id-ordered). null when unknown. */
export async function loadDerivedSuite(
  db: PotionDb,
  suiteId: string,
): Promise<LoadedDerivedSuite | null> {
  const rows = await db.select().from(derivedSuites).where(eq(derivedSuites.suiteId, suiteId));
  const suite = rows[0];
  if (!suite) return null;
  const itemRows = await db
    .select()
    .from(derivedSuiteItems)
    .where(eq(derivedSuiteItems.suiteId, suiteId))
    .orderBy(asc(derivedSuiteItems.itemId));
  return { suite, items: itemRows.map(toEvalItem) };
}

function toEvalItem(row: DerivedSuiteItemRow): EvalItem {
  return {
    id: row.itemId,
    clusterId: row.clusterId,
    prompt: row.prompt,
    ...(row.reference !== null ? { reference: row.reference } : {}),
    scoring: row.scoring,
  };
}

/** Suites (provenance rows), optionally narrowed to one org. */
export async function listDerivedSuites(
  db: PotionDb,
  opts: { orgId?: string } = {},
): Promise<DerivedSuiteRow[]> {
  return db
    .select()
    .from(derivedSuites)
    .where(opts.orgId !== undefined ? eq(derivedSuites.orgId, opts.orgId) : undefined)
    .orderBy(asc(derivedSuites.suiteId));
}

/**
 * Restamp every llm-judge item of a suite to a new rubric text (G1.5).
 * Appends skip existing ids, so a rubric change would otherwise leave a
 * suite scoring different items under different rubrics — approval makes
 * the suite homogeneous in one UPDATE. Non-llm-judge rows are untouched.
 * Returns the number of restamped items.
 */
export async function restampDerivedSuiteRubric(
  db: PotionDb,
  suiteId: string,
  rubricText: string,
): Promise<number> {
  const updated = await db
    .update(derivedSuiteItems)
    .set({
      scoring: sql`jsonb_set(${derivedSuiteItems.scoring}, '{rubric}', ${JSON.stringify(rubricText)}::jsonb)`,
    })
    .where(
      and(
        eq(derivedSuiteItems.suiteId, suiteId),
        sql`${derivedSuiteItems.scoring}->>'kind' = 'llm-judge'`,
      ),
    )
    .returning({ itemId: derivedSuiteItems.itemId });
  // F7: re-scoring every item against a different rubric is the single
  // largest change to what a suite means. Same prompts, different question.
  if (updated.length > 0) await bumpSuiteVersion(db, suiteId);
  return updated.length;
}

/**
 * Retention purge (G1.3): delete an org's derived items older than `cutoff`,
 * or ALL its items (`'all'` — the retention-0 "metadata only" semantic: the
 * provenance row + manifest remain as the stub). Idempotent.
 */
export async function purgeDerivedSuiteItems(
  db: PotionDb,
  orgId: string,
  cutoff: Date | 'all',
): Promise<{ itemsDeleted: number; suitesEmptied: number; purgedItemIds: string[] }> {
  const suiteRows = await db
    .select({ suiteId: derivedSuites.suiteId })
    .from(derivedSuites)
    .where(eq(derivedSuites.orgId, orgId));
  let itemsDeleted = 0;
  let suitesEmptied = 0;
  // G1.6: purged ids feed evidence retirement — eval_results built from
  // these items are marked stale and affected frontiers recomputed.
  const purgedItemIds: string[] = [];
  for (const { suiteId } of suiteRows) {
    const deleted = await db
      .delete(derivedSuiteItems)
      .where(
        and(
          eq(derivedSuiteItems.suiteId, suiteId),
          cutoff === 'all' ? undefined : lt(derivedSuiteItems.createdAt, cutoff),
        ),
      )
      .returning({ itemId: derivedSuiteItems.itemId });
    itemsDeleted += deleted.length;
    purgedItemIds.push(...deleted.map((d) => d.itemId));
    if (deleted.length > 0) {
      // F7: removal changes what the suite measures, so the version moves.
      // It used to move only on ADDITION, which let a retention cutoff halve
      // an instrument while its label — and its certification — stood still.
      await bumpSuiteVersion(db, suiteId);
      const remaining = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(derivedSuiteItems)
        .where(eq(derivedSuiteItems.suiteId, suiteId));
      if ((remaining[0]?.n ?? 0) === 0) suitesEmptied += 1;
    }
  }
  return { itemsDeleted, suitesEmptied, purgedItemIds };
}

/**
 * The CURRENT content hash of a suite (F7) — recomputed from the live rows,
 * never cached, because the whole point is to notice when it has drifted from
 * what a certification vouched for.
 */
export async function computeSuiteContentHash(db: PotionDb, suiteId: string): Promise<string> {
  const rows = await db
    .select({
      itemId: derivedSuiteItems.itemId,
      prompt: derivedSuiteItems.prompt,
      reference: derivedSuiteItems.reference,
      scoring: derivedSuiteItems.scoring,
    })
    .from(derivedSuiteItems)
    .where(eq(derivedSuiteItems.suiteId, suiteId));
  return suiteContentHash(
    rows.map((r) => ({
      itemId: r.itemId,
      prompt: r.prompt,
      reference: r.reference,
      scoring: r.scoring,
    })),
  );
}

/** Bump a suite's patch version (F7: removal and restamp change what the
 * suite means, so the human-readable label must move too — it used to move
 * only on ADDITION, which made it quietly misleading). */
export async function bumpSuiteVersion(db: PotionDb, suiteId: string): Promise<string | null> {
  const rows = await db
    .select({ version: derivedSuites.version })
    .from(derivedSuites)
    .where(eq(derivedSuites.suiteId, suiteId));
  if (rows.length === 0) return null;
  const next = bumpPatch(rows[0]!.version ?? '1.0.0');
  await db
    .update(derivedSuites)
    .set({ version: next, updatedAt: new Date() })
    .where(eq(derivedSuites.suiteId, suiteId));
  return next;
}
