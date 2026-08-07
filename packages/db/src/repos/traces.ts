// Trace repository (M5, ROADMAP #36, SPEC §14, migration 0015_traces).
// Unlike frontiers/recipes, trace spans are ORG-SCOPED — payloads may carry
// customer data. Idempotent ingest on (orgId, traceId, spanId); retention
// purge + redaction for §14.3; read models for the session rollup and the
// agent-cluster synthesis (§14.2).
import { and, asc, desc, eq, gte, lt, ne, sql, type SQL } from 'drizzle-orm';
import { redactAttrs } from '@potion/core';
import type { PotionDb } from '../db.js';
import { orgs, traceSpans, type NewTraceSpan, type TraceSpanRow } from '../schema.js';

/** Insert a batch of spans idempotently: rows already present for
 * (orgId, traceId, spanId) are skipped, so retries/overlapping uploads are
 * safe. Returns accepted (inserted) and duplicates (skipped) counts. */
export async function insertTraceSpans(
  db: PotionDb,
  rows: NewTraceSpan[],
): Promise<{ accepted: number; duplicates: number }> {
  if (rows.length === 0) return { accepted: 0, duplicates: 0 };
  const inserted = await db
    .insert(traceSpans)
    .values(rows)
    .onConflictDoNothing({ target: [traceSpans.orgId, traceSpans.traceId, traceSpans.spanId] })
    .returning({ id: traceSpans.id });
  return { accepted: inserted.length, duplicates: rows.length - inserted.length };
}

/** Spans for one org in an optional time window, newest trace activity first
 * (caller groups by trace). */
export async function listOrgTraceSpans(
  db: PotionDb,
  orgId: string,
  opts: { from?: Date | undefined; to?: Date | undefined; limit?: number | undefined } = {},
): Promise<TraceSpanRow[]> {
  const conds: SQL[] = [eq(traceSpans.orgId, orgId)];
  if (opts.from !== undefined) conds.push(gte(traceSpans.ts, opts.from));
  if (opts.to !== undefined) conds.push(lt(traceSpans.ts, opts.to));
  return db
    .select()
    .from(traceSpans)
    .where(and(...conds))
    .orderBy(desc(traceSpans.ts), asc(traceSpans.traceId), asc(traceSpans.spanId))
    .limit(opts.limit ?? 5000);
}

/** One trace's spans in waterfall order (ts, then spanId for stable ties). */
export async function listSpansForTrace(
  db: PotionDb,
  orgId: string,
  traceId: string,
): Promise<TraceSpanRow[]> {
  return db
    .select()
    .from(traceSpans)
    .where(and(eq(traceSpans.orgId, orgId), eq(traceSpans.traceId, traceId)))
    .orderBy(asc(traceSpans.ts), asc(traceSpans.spanId));
}

/** The org's retention setting (null = unknown org). */
export async function getOrgTraceRetentionDays(
  db: PotionDb,
  orgId: string,
): Promise<number | null> {
  const rows = await db
    .select({ days: orgs.traceRetentionDays })
    .from(orgs)
    .where(eq(orgs.id, orgId));
  return rows[0]?.days ?? null;
}

/** Update the org's retention setting (admin). Returns false for unknown orgs. */
export async function setOrgTraceRetentionDays(
  db: PotionDb,
  orgId: string,
  days: number,
): Promise<boolean> {
  const updated = await db
    .update(orgs)
    .set({ traceRetentionDays: days })
    .where(eq(orgs.id, orgId))
    .returning({ id: orgs.id });
  return updated.length > 0;
}

/** Org ids that currently hold any spans (purge job fan-out). */
export async function listOrgIdsWithSpans(db: PotionDb): Promise<string[]> {
  const rows = await db.selectDistinct({ orgId: traceSpans.orgId }).from(traceSpans);
  return rows.map((r) => r.orgId);
}

/** SPEC §14.3 retention>0: delete spans older than the cutoff. Returns the
 * deleted count. */
export async function deleteSpansOlderThan(
  db: PotionDb,
  orgId: string,
  cutoff: Date,
): Promise<number> {
  const deleted = await db
    .delete(traceSpans)
    .where(and(eq(traceSpans.orgId, orgId), lt(traceSpans.ts, cutoff)))
    .returning({ id: traceSpans.id });
  return deleted.length;
}

/** SPEC §14.3 retention=0 ("metadata only"): redact the payload column but
 * keep span metadata (model/usage/cost/timestamps/names). Returns the number
 * of rows redacted this call (idempotent — already-empty attrs are skipped). */
/**
 * G1.1 backfill: re-run the platform PII redactor over EXISTING span attrs
 * (rows ingested before ingest-time redaction, or seeded directly at the
 * repo layer). Idempotent by construction — redactPii is a no-op on already
 * redacted text, and unchanged rows are not rewritten. Returns the number
 * of rows actually updated.
 */
export async function backfillRedactSpans(
  db: PotionDb,
  orgId?: string,
): Promise<{ scanned: number; updated: number }> {
  const rows = await db
    .select({ id: traceSpans.id, attrs: traceSpans.attrs })
    .from(traceSpans)
    .where(
      and(
        orgId !== undefined ? eq(traceSpans.orgId, orgId) : undefined,
        ne(traceSpans.attrs, {}),
      ),
    );
  let updated = 0;
  for (const row of rows) {
    const redacted = redactAttrs(row.attrs as Record<string, unknown>);
    if (JSON.stringify(redacted) !== JSON.stringify(row.attrs)) {
      await db.update(traceSpans).set({ attrs: redacted }).where(eq(traceSpans.id, row.id));
      updated += 1;
    }
  }
  return { scanned: rows.length, updated };
}

export async function redactSpanAttrs(db: PotionDb, orgId: string): Promise<number> {
  const updated = await db
    .update(traceSpans)
    .set({ attrs: {} })
    .where(and(eq(traceSpans.orgId, orgId), ne(traceSpans.attrs, {})))
    .returning({ id: traceSpans.id });
  return updated.length;
}

// ---------------------------------------------------------------------------
// §14.2 read model for agent clustering: one row per trace with the first
// user message (attrs.gen_ai.prompt on the earliest span that carries it) and
// the ordered tool-name sequence (spans whose attrs.gen_ai.operation.name is
// 'execute_tool', or whose name is prefixed 'tool.'). Payload text leaves the
// org only AFTER the caller redacts it.
// ---------------------------------------------------------------------------
export interface TraceClusterSource {
  orgId: string;
  traceId: string;
  firstMessage: string | null;
  toolSequence: string[];
  spanCount: number;
  totalCostUsd: number;
  startedAt: Date;
}

export async function listTracesForClustering(
  db: PotionDb,
  opts: { since?: Date | undefined; limit?: number | undefined } = {},
): Promise<TraceClusterSource[]> {
  const limit = opts.limit ?? 500;
  const rows = await db
    .select()
    .from(traceSpans)
    .where(opts.since !== undefined ? gte(traceSpans.ts, opts.since) : undefined)
    .orderBy(asc(traceSpans.traceId), asc(traceSpans.ts), asc(traceSpans.spanId))
    .limit(50_000);

  const byTrace = new Map<string, TraceSpanRow[]>();
  for (const r of rows) {
    const list = byTrace.get(r.traceId) ?? [];
    list.push(r);
    byTrace.set(r.traceId, list);
  }
  const out: TraceClusterSource[] = [];
  for (const [traceId, spans] of byTrace) {
    if (spans.length === 0) continue;
    const first = spans.find((s) => {
      const attrs = s.attrs as Record<string, unknown>;
      return typeof attrs['gen_ai.prompt'] === 'string' && attrs['gen_ai.prompt'].length > 0;
    });
    const toolSequence = spans
      .filter((s) => {
        const attrs = s.attrs as Record<string, unknown>;
        return attrs['gen_ai.operation.name'] === 'execute_tool' || s.name.startsWith('tool.');
      })
      .map((s) => s.name.replace(/^tool\./, ''));
    out.push({
      orgId: spans[0]!.orgId,
      traceId,
      firstMessage: first ? String((first.attrs as Record<string, unknown>)['gen_ai.prompt']) : null,
      toolSequence,
      spanCount: spans.length,
      totalCostUsd: spans.reduce((sum, s) => sum + s.costUsd, 0),
      startedAt: spans[0]!.ts,
    });
    if (out.length >= limit) break;
  }
  return out.sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime() || a.traceId.localeCompare(b.traceId));
}

// ---------------------------------------------------------------------------
// §14.1 loop detection (pure): a tool-call signature is name + canonical
// attrs JSON; a trace loops when one signature repeats ≥ LOOP_THRESHOLD times.
// ---------------------------------------------------------------------------
export const LOOP_SIGNATURE_THRESHOLD = 3;

export interface LoopSignal {
  signature: string;
  count: number;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const rec = value as Record<string, unknown>;
  return `{${Object.keys(rec)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(rec[k])}`)
    .join(',')}}`;
}

/** Tool-call signature for one span: name + stable attrs JSON (operation
 * args included — same tool with different args is NOT a loop). */
export function toolSignatureOf(span: Pick<TraceSpanRow, 'name' | 'attrs'>): string {
  return `${span.name}:${stableStringify(span.attrs)}`;
}

/** Repeated-signature loop signals for a set of spans (one trace), sorted by
 * count desc. Only tool-ish spans participate (execute_tool op or tool.*
 * name) — an agent re-reading its own notes is not a loop. */
export function detectLoopSignals(
  spans: Array<Pick<TraceSpanRow, 'name' | 'attrs'>>,
): LoopSignal[] {
  const counts = new Map<string, number>();
  for (const s of spans) {
    const attrs = s.attrs as Record<string, unknown>;
    const isTool = attrs['gen_ai.operation.name'] === 'execute_tool' || s.name.startsWith('tool.');
    if (!isTool) continue;
    const sig = toolSignatureOf(s);
    counts.set(sig, (counts.get(sig) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, count]) => count >= LOOP_SIGNATURE_THRESHOLD)
    .map(([signature, count]) => ({ signature, count }))
    .sort((a, b) => b.count - a.count || a.signature.localeCompare(b.signature));
}
