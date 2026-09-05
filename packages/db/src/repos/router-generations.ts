// G2 rung 4 (migration 0092) — ROUTER GENERATIONS.
//
// A generation is an immutable set of per-cluster frontier ids with a
// lifecycle. The transitions live HERE rather than in the route, because
// every one of them is an invariant worth testing without an HTTP server:
//
//   · at most ONE 'serving' generation per org, ever;
//   · promoting writes the generation's pins ATOMICALLY — a half-applied
//     routing change is the failure mode this feature exists to prevent;
//   · rolling back re-applies the PREVIOUS serving generation's pins, which
//     is only possible because a generation stores the whole surface rather
//     than a diff;
//   · nothing is deleted. A superseded or rolled-back generation keeps its
//     pins so it can be promoted again — "put it back" must not depend on
//     recomputing what used to be true.
import { and, desc, eq, gt, gte, ne } from 'drizzle-orm';
import type { PotionDb } from '../db.js';
import {
  frontierPins,
  qualitySamples,
  requestLogs,
  routerGenerations,
  type GenerationPin,
  type RouterGenerationRow,
} from '../schema.js';

export type GenerationStatus = 'candidate' | 'serving' | 'superseded' | 'rolled-back';

export async function insertRouterGeneration(
  db: PotionDb,
  row: { id: string; orgId: string; pins: Record<string, GenerationPin>; routerVersion?: number | null; note?: string | null },
): Promise<RouterGenerationRow> {
  const [inserted] = await db
    .insert(routerGenerations)
    .values({
      id: row.id,
      orgId: row.orgId,
      status: 'candidate',
      pins: row.pins,
      routerVersion: row.routerVersion ?? null,
      note: row.note ?? null,
    })
    .returning();
  return inserted!;
}

export async function listRouterGenerations(db: PotionDb, orgId: string): Promise<RouterGenerationRow[]> {
  return db
    .select()
    .from(routerGenerations)
    .where(eq(routerGenerations.orgId, orgId))
    .orderBy(desc(routerGenerations.createdAt));
}

export async function getRouterGeneration(
  db: PotionDb,
  orgId: string,
  id: string,
): Promise<RouterGenerationRow | null> {
  const rows = await db
    .select()
    .from(routerGenerations)
    .where(and(eq(routerGenerations.orgId, orgId), eq(routerGenerations.id, id)))
    .limit(1);
  return rows[0] ?? null;
}

/** The generation whose pins are in force, if any. */
export async function servingGeneration(db: PotionDb, orgId: string): Promise<RouterGenerationRow | null> {
  const rows = await db
    .select()
    .from(routerGenerations)
    .where(and(eq(routerGenerations.orgId, orgId), eq(routerGenerations.status, 'serving')))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Write a generation's pins as THE pin set for the org: every cluster it
 * names is pinned to its recorded frontier, and every cluster it does NOT
 * name is released.
 *
 * The release half is the part that is easy to forget and expensive to get
 * wrong. A generation describes the whole routing surface, so a cluster
 * absent from it must be absent from the pins too — otherwise promoting a
 * generation captured before some cluster existed would leave that cluster
 * frozen at whatever the last generation happened to pin, and no reading of
 * the generation would explain why.
 */
async function applyPins(db: PotionDb, orgId: string, pins: Record<string, GenerationPin>, by: string): Promise<void> {
  await db.delete(frontierPins).where(eq(frontierPins.orgId, orgId));
  const rows = Object.entries(pins).map(([clusterId, p]) => ({
    orgId,
    clusterId,
    instrument: p.instrument,
    frontierId: p.frontierId,
    frontierVersion: p.frontierVersion,
    pinnedBy: by,
  }));
  if (rows.length > 0) await db.insert(frontierPins).values(rows);
}

export interface GenerationTransition {
  ok: boolean;
  /** Why not, when ok is false — the route turns this into a 409 message. */
  reason?: string;
  generation?: RouterGenerationRow;
  /** The generation that was serving before this call, if any. */
  previous?: RouterGenerationRow | null;
}

/**
 * Promote a candidate: its pins become the org's pin set, the generation
 * that was serving is marked superseded, and this one becomes 'serving'.
 * Refuses anything that is not a candidate — a promoted generation is
 * re-promoted through `rollbackTo`, which says what it is doing.
 */
export async function promoteGeneration(
  db: PotionDb,
  orgId: string,
  id: string,
  by = 'generation:promote',
): Promise<GenerationTransition> {
  const gen = await getRouterGeneration(db, orgId, id);
  if (gen === null) return { ok: false, reason: 'unknown generation' };
  if (gen.status !== 'candidate') return { ok: false, reason: `generation is '${gen.status}', not a candidate` };
  const previous = await servingGeneration(db, orgId);
  await applyPins(db, orgId, gen.pins, by);
  if (previous !== null) {
    await db
      .update(routerGenerations)
      .set({ status: 'superseded', endedAt: new Date() })
      .where(and(eq(routerGenerations.orgId, orgId), eq(routerGenerations.id, previous.id)));
  }
  const [updated] = await db
    .update(routerGenerations)
    .set({ status: 'serving', promotedAt: new Date(), endedAt: null, canaryRate: 0 })
    .where(and(eq(routerGenerations.orgId, orgId), eq(routerGenerations.id, id)))
    .returning();
  return { ok: true, generation: updated!, previous };
}

/**
 * Put a previous generation back. The current serving generation is marked
 * 'rolled-back' (not 'superseded' — the difference is the whole point of a
 * rollback record: someone decided this routing was wrong), and the named
 * generation serves again with its stored pins.
 */
export async function rollbackTo(
  db: PotionDb,
  orgId: string,
  id: string,
  by = 'generation:rollback',
): Promise<GenerationTransition> {
  const target = await getRouterGeneration(db, orgId, id);
  if (target === null) return { ok: false, reason: 'unknown generation' };
  if (target.status === 'serving') return { ok: false, reason: 'that generation is already serving' };
  if (target.status === 'candidate') {
    return { ok: false, reason: 'a candidate has never served — promote it instead of rolling back to it' };
  }
  const current = await servingGeneration(db, orgId);
  await applyPins(db, orgId, target.pins, by);
  if (current !== null) {
    await db
      .update(routerGenerations)
      .set({ status: 'rolled-back', endedAt: new Date() })
      .where(and(eq(routerGenerations.orgId, orgId), eq(routerGenerations.id, current.id)));
  }
  const [updated] = await db
    .update(routerGenerations)
    .set({ status: 'serving', promotedAt: new Date(), endedAt: null, canaryRate: 0 })
    .where(and(eq(routerGenerations.orgId, orgId), eq(routerGenerations.id, id)))
    .returning();
  return { ok: true, generation: updated!, previous: current };
}

/**
 * A canary is a fraction of traffic served by a CANDIDATE's frontiers.
 *
 * Capped, because this is a rollout dial and not a traffic splitter: half is
 * already an aggressive slice for a routing change nobody has promoted, and
 * an unbounded value here would let a typo move every request onto an
 * unpromoted generation without anyone deciding to.
 */
export const CANARY_MAX_RATE = 0.5;

/** At most ONE candidate canaries at a time. Two would make every request's
 * routing depend on which coin landed first, and the evidence for promoting
 * either would be measured against a moving comparator. */
export async function setCanaryRate(
  db: PotionDb,
  orgId: string,
  id: string,
  rate: number,
): Promise<GenerationTransition> {
  const gen = await getRouterGeneration(db, orgId, id);
  if (gen === null) return { ok: false, reason: 'unknown generation' };
  if (gen.status !== 'candidate') {
    return { ok: false, reason: `only a candidate can canary — this one is '${gen.status}'` };
  }
  if (!Number.isFinite(rate) || rate < 0 || rate > CANARY_MAX_RATE) {
    return { ok: false, reason: `canary rate must be between 0 and ${CANARY_MAX_RATE}` };
  }
  if (rate > 0) {
    const others = await db
      .select({ id: routerGenerations.id })
      .from(routerGenerations)
      .where(and(eq(routerGenerations.orgId, orgId), ne(routerGenerations.id, id), gt(routerGenerations.canaryRate, 0)));
    if (others.length > 0) {
      return { ok: false, reason: `generation '${others[0]!.id}' is already canarying — stop it first` };
    }
  }
  const [updated] = await db
    .update(routerGenerations)
    .set({ canaryRate: rate })
    .where(and(eq(routerGenerations.orgId, orgId), eq(routerGenerations.id, id)))
    .returning();
  return { ok: true, generation: updated! };
}

/** The candidate currently taking a slice, if any. */
export async function canaryingGeneration(db: PotionDb, orgId: string): Promise<RouterGenerationRow | null> {
  const rows = await db
    .select()
    .from(routerGenerations)
    .where(
      and(
        eq(routerGenerations.orgId, orgId),
        eq(routerGenerations.status, 'candidate'),
        gt(routerGenerations.canaryRate, 0),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export interface GenerationSideSamples {
  requests: number;
  /** Per-request cost in USD, one entry per served request. Raw, because
   * the interval has to be computed over the samples — a mean handed across
   * a boundary cannot be given a confidence interval afterwards. */
  costs: number[];
  /** Serve-judge scores for those requests, when the sampler took any. */
  qualities: number[];
}

export interface GenerationEvidence {
  /** Requests the canary actually routed. */
  canary: GenerationSideSamples;
  /** Requests the PROMOTED routing served in the same window — the
   * comparator. Concurrent by construction: both sides are drawn from the
   * same traffic over the same period, which is the whole reason a canary
   * is better evidence than a suite. */
  control: GenerationSideSamples;
  /** Where the window starts — the first request this generation routed. */
  since: string | null;
}

/**
 * What a canary has measured so far: its own requests against the promoted
 * routing's, over the same window.
 *
 * HOLDOUT ROWS ARE EXCLUDED FROM BOTH SIDES. A holdout served the org's
 * incumbent, so it is evidence about the baseline and about neither
 * generation; leaving it in the control would drag the comparator toward
 * the incumbent's cost and quietly flatter any canary.
 */
export async function generationEvidence(
  db: PotionDb,
  orgId: string,
  generationId: string,
): Promise<GenerationEvidence> {
  const firstRow = await db
    .select({ ts: requestLogs.ts })
    .from(requestLogs)
    .where(and(eq(requestLogs.orgId, orgId), eq(requestLogs.generationId, generationId)))
    .orderBy(requestLogs.ts)
    .limit(1);
  const since = firstRow[0]?.ts ?? null;
  if (since === null) {
    return { canary: { requests: 0, costs: [], qualities: [] }, control: { requests: 0, costs: [], qualities: [] }, since: null };
  }

  const rows = await db
    .select({
      generationId: requestLogs.generationId,
      usage: requestLogs.usage,
      completionId: requestLogs.completionId,
    })
    .from(requestLogs)
    .where(
      and(
        eq(requestLogs.orgId, orgId),
        eq(requestLogs.status, 'ok'),
        eq(requestLogs.holdout, false),
        gte(requestLogs.ts, since),
      ),
    );

  // Serve-judge scores, joined by the completion id the sampler records.
  const scored = new Map<string, number[]>();
  for (const q of await db
    .select({ requestId: qualitySamples.requestId, quality: qualitySamples.quality })
    .from(qualitySamples)
    .where(and(eq(qualitySamples.orgId, orgId), gte(qualitySamples.createdAt, since)))) {
    if (q.requestId === null) continue;
    const list = scored.get(q.requestId) ?? [];
    list.push(q.quality);
    scored.set(q.requestId, list);
  }

  const side = (): GenerationSideSamples => ({ requests: 0, costs: [], qualities: [] });
  const out: GenerationEvidence = { canary: side(), control: side(), since: since.toISOString() };
  for (const r of rows) {
    // Only THIS generation's rows count as canary. Another generation's
    // label belongs to neither side of this comparison.
    const bucket =
      r.generationId === generationId ? out.canary : r.generationId === null ? out.control : null;
    if (bucket === null) continue;
    bucket.requests += 1;
    const cost = (r.usage as { costUsd?: number } | null)?.costUsd;
    if (typeof cost === 'number' && Number.isFinite(cost)) bucket.costs.push(cost);
    for (const q of (r.completionId !== null ? scored.get(r.completionId) : undefined) ?? []) {
      bucket.qualities.push(q);
    }
  }
  return out;
}

/**
 * Record that a human promoted a generation THE EVIDENCE CONDEMNED, and
 * what the evidence said at the time. Appended to the note rather than
 * replacing it: the override is a fact about this generation that outlives
 * whoever typed it, and a promotion against measurement is exactly the
 * thing a future reader will want explained.
 */
export async function noteGenerationOverride(
  db: PotionDb,
  orgId: string,
  id: string,
  why: string,
): Promise<void> {
  const gen = await getRouterGeneration(db, orgId, id);
  if (gen === null) return;
  const stamp = `[promoted over adverse evidence ${new Date().toISOString()}] ${why}`;
  await db
    .update(routerGenerations)
    .set({ note: gen.note === null || gen.note === '' ? stamp : `${gen.note}\n${stamp}` })
    .where(and(eq(routerGenerations.orgId, orgId), eq(routerGenerations.id, id)));
}

/** Every generation an org could roll back TO: promoted at some point, not
 * serving now. Newest first — the one you most likely want is on top. */
export async function rollbackCandidates(db: PotionDb, orgId: string): Promise<RouterGenerationRow[]> {
  return db
    .select()
    .from(routerGenerations)
    .where(
      and(
        eq(routerGenerations.orgId, orgId),
        ne(routerGenerations.status, 'serving'),
        ne(routerGenerations.status, 'candidate'),
      ),
    )
    .orderBy(desc(routerGenerations.promotedAt));
}
