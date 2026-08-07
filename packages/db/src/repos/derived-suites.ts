// Derived-suite storage repo (G1.3, migration 0021): trace-synthesized
// suites in governed db storage. The MERGE/CAP/VERSION-BUMP semantics mirror
// the pre-G1.3 file writer exactly: new items merge via onConflictDoNothing,
// the roster is the deterministic id-ordered head up to the cap, and the
// suite's patch version bumps only when the item roster changed.
import { and, asc, eq, lt, sql } from 'drizzle-orm';
import type { EvalItem } from '@potion/core';
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
 * Retention purge (G1.3): delete an org's derived items older than `cutoff`,
 * or ALL its items (`'all'` — the retention-0 "metadata only" semantic: the
 * provenance row + manifest remain as the stub). Idempotent.
 */
export async function purgeDerivedSuiteItems(
  db: PotionDb,
  orgId: string,
  cutoff: Date | 'all',
): Promise<{ itemsDeleted: number; suitesEmptied: number }> {
  const suiteRows = await db
    .select({ suiteId: derivedSuites.suiteId })
    .from(derivedSuites)
    .where(eq(derivedSuites.orgId, orgId));
  let itemsDeleted = 0;
  let suitesEmptied = 0;
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
    if (deleted.length > 0) {
      const remaining = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(derivedSuiteItems)
        .where(eq(derivedSuiteItems.suiteId, suiteId));
      if ((remaining[0]?.n ?? 0) === 0) suitesEmptied += 1;
    }
  }
  return { itemsDeleted, suitesEmptied };
}
