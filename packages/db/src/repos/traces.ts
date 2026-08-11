// Trace repository (M5, ROADMAP #36, SPEC §14, migration 0015_traces).
// Unlike frontiers/recipes, trace spans are ORG-SCOPED — payloads may carry
// customer data. Idempotent ingest on (orgId, traceId, spanId); retention
// purge + redaction for §14.3; read models for the session rollup and the
// agent-cluster synthesis (§14.2).
import { and, asc, desc, eq, gte, lt, ne, type SQL } from 'drizzle-orm';
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
export async function listOrgIdsWithSpans(db: PotionDb, since?: Date): Promise<string[]> {
  const rows = await db
    .selectDistinct({ orgId: traceSpans.orgId })
    .from(traceSpans)
    .where(since !== undefined ? gte(traceSpans.ts, since) : undefined);
  return rows.map((r) => r.orgId).sort();
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
/** One entry of the context a model call saw, in session order (post-capstone
 * item 2). All text was redacted at ingest. */
export type TraceStepContext =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string }
  | { kind: 'tool'; name: string; args?: string; result?: string };

/**
 * One text-producing model call inside an agentic session (an `llm.call`
 * span, converter v2). THE PAIRING IS THE POINT: pre-v2 the read model
 * flattened prompts into `turns` and let the last completion win, which is
 * what forced whole-session replay — the measurement Decision 1 recorded as
 * invalid (incumbent 0.2000 on its own traffic). `contextBefore` is folded
 * from the ordered prior siblings (user turns, earlier step completions,
 * tool calls with payloads); `completion` is what THIS call produced.
 */
export interface TraceStep {
  spanId: string;
  /** Converter-stamped potion.step_index when present, else fold order. */
  stepIndex: number;
  completion: string;
  model: string | null;
  usage: { inputTokens: number; outputTokens: number } | null;
  contextBefore: TraceStepContext[];
}

export interface TraceClusterSource {
  orgId: string;
  traceId: string;
  /** turns[0] — kept for compat. */
  firstMessage: string | null;
  /** G1.4: ALL gen_ai.prompt texts, ts asc — ordered user turns. */
  turns: string[];
  /** G1.4: the session's final assistant answer (LAST gen_ai.completion in
   * ts order), redacted at ingest — the replay item's reference. */
  referenceAnswer: string | null;
  /** G1.4: tool activity with payloads (redacted) — replay context. The
   * names-only toolSequence stays for signature slugging. */
  toolTranscript: Array<{ name: string; args?: string; result?: string }>;
  toolSequence: string[];
  /** Post-capstone item 2: per-model-call steps with preserved
   * prompt↔completion pairing. Empty for pre-v2 traces (no llm.call spans)
   * — synthesis falls back to the session item; no flag day. */
  steps: TraceStep[];
  spanCount: number;
  totalCostUsd: number;
  startedAt: Date;
}

export async function listTracesForClustering(
  db: PotionDb,
  opts: { orgId?: string | undefined; since?: Date | undefined; limit?: number | undefined } = {},
): Promise<TraceClusterSource[]> {
  const limit = opts.limit ?? 500;
  // G1.2: org predicate IN SQL — an org-scoped run can never be starved by
  // other tenants' volume filling the scan window.
  const rows = await db
    .select()
    .from(traceSpans)
    .where(
      and(
        opts.orgId !== undefined ? eq(traceSpans.orgId, opts.orgId) : undefined,
        opts.since !== undefined ? gte(traceSpans.ts, opts.since) : undefined,
      ),
    )
    .orderBy(asc(traceSpans.orgId), asc(traceSpans.traceId), asc(traceSpans.ts), asc(traceSpans.spanId))
    .limit(50_000);

  // G1.2: group key is (org, trace) — customer-supplied trace ids are only
  // unique per org, and two orgs' identical ids must never merge.
  const byTrace = new Map<string, TraceSpanRow[]>();
  for (const r of rows) {
    const key = `${r.orgId}\u0000${r.traceId}`;
    const list = byTrace.get(key) ?? [];
    list.push(r);
    byTrace.set(key, list);
  }
  const out: TraceClusterSource[] = [];
  for (const [, spans] of byTrace) {
    if (spans.length === 0) continue;
    const traceId = spans[0]!.traceId;
    // G1.4: collect ALL user turns (ts asc — the scan order guarantees it),
    // the LAST completion (the session's final answer), and the tool
    // transcript with payloads. All values were redacted at ingest.
    const turns: string[] = [];
    let referenceAnswer: string | null = null;
    const toolTranscript: Array<{ name: string; args?: string; result?: string }> = [];
    const toolSpans = spans.filter((s) => {
      const attrs = s.attrs as Record<string, unknown>;
      return attrs['gen_ai.operation.name'] === 'execute_tool' || s.name.startsWith('tool.');
    });
    // Post-capstone item 2: fold the step view in the SAME ordered scan.
    // Running context accumulates what the session has produced so far; each
    // llm.call span snapshots it as contextBefore, then contributes its own
    // completion. The terminal chat span (no llm_call marker) is NOT a step
    // — it keeps its pre-v2 role as the session reference.
    const steps: TraceStep[] = [];
    const runningContext: TraceStepContext[] = [];
    const isToolSpan = (s: TraceSpanRow): boolean => {
      const attrs = s.attrs as Record<string, unknown>;
      return attrs['gen_ai.operation.name'] === 'execute_tool' || s.name.startsWith('tool.');
    };
    for (const s of spans) {
      const attrs = s.attrs as Record<string, unknown>;
      const prompt = attrs['gen_ai.prompt'];
      if (typeof prompt === 'string' && prompt.length > 0) {
        turns.push(prompt);
        runningContext.push({ kind: 'user', text: prompt });
      }
      const completion = attrs['gen_ai.completion'];
      if (typeof completion === 'string' && completion.length > 0) referenceAnswer = completion;
      if (isToolSpan(s)) {
        const args = attrs['tool.args'];
        const result = attrs['tool.result'];
        const entry = {
          name: s.name.replace(/^tool\./, ''),
          ...(args !== undefined ? { args: typeof args === 'string' ? args : JSON.stringify(args) } : {}),
          ...(result !== undefined
            ? { result: typeof result === 'string' ? result : JSON.stringify(result) }
            : {}),
        };
        toolTranscript.push(entry);
        runningContext.push({ kind: 'tool', ...entry });
        continue;
      }
      const isLlmCall = attrs['gen_ai.operation.name'] === 'llm_call' || s.name === 'llm.call';
      if (isLlmCall && typeof completion === 'string' && completion.length > 0) {
        const stamped = attrs['potion.step_index'];
        const usage = s.usage as { input_tokens?: number; output_tokens?: number } | null;
        steps.push({
          spanId: s.spanId,
          stepIndex: typeof stamped === 'number' ? stamped : steps.length + 1,
          completion,
          model: s.model ?? null,
          usage:
            usage && (usage.input_tokens !== undefined || usage.output_tokens !== undefined)
              ? { inputTokens: usage.input_tokens ?? 0, outputTokens: usage.output_tokens ?? 0 }
              : null,
          contextBefore: [...runningContext],
        });
        runningContext.push({ kind: 'assistant', text: completion });
      }
    }
    const toolSequence = toolSpans.map((s) => s.name.replace(/^tool\./, ''));
    out.push({
      orgId: spans[0]!.orgId,
      traceId,
      firstMessage: turns[0] ?? null,
      turns,
      referenceAnswer,
      toolTranscript,
      toolSequence,
      steps,
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
