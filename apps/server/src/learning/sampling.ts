// Sampling for the learning period: under consent, the serving path keeps a
// PII-redacted sample of an org's requests (prompt + answer) as trace spans
// — the same store the derived-suite builder already reads — capped per
// kind of work. No consent, no rows. Ever.
//
// FULL-REQUEST CAPTURE (2026-09-01, G1 — external review §7): the sample
// now keeps the WHOLE served message array (system + prior turns + last
// user) plus the structural facts (tool count, response_format, multimodal
// part count) — the measured task must be the served task, and the old
// last-user-turn-only capture measured a conversation by its final
// sentence. Two honesty rules ride along:
//   · NEVER truncate-into-a-different-task. The old .slice(0, 8000)
//     silently mutilated long prompts and references; an over-cap request
//     is now EXCLUDED with a typed status ('too-large') instead. That
//     biases the sample toward shorter requests — visibly, by design.
//   · Multimodal parts are STRIPPED (never at rest — base64 payloads) and
//     counted; tool-carrying and part-carrying spans are captured as
//     metadata but excluded from derived suites (the replay cannot execute
//     the customer's tools or see their attachments, so measuring the
//     text-only remainder would measure a different task).
import { and, eq, sql } from 'drizzle-orm';
import { redactAttrs, type ChatMessage } from '@potion/core';
import { getOrgIncumbents, insertTraceSpans, traceSpans, type PotionDb } from '@potion/db';

export const LEARNING_SPAN_NAME = 'potion.learning.sample';

/** Sampled prompts per kind of work for the org. */
export async function learningSampleCounts(db: PotionDb, orgId: string): Promise<Record<string, number>> {
  const rows = await db
    .select({ clusterId: sql<string>`${traceSpans.attrs} ->> 'potion.cluster_id'`, n: sql<number>`count(*)` })
    .from(traceSpans)
    .where(and(eq(traceSpans.orgId, orgId), eq(traceSpans.name, LEARNING_SPAN_NAME)))
    .groupBy(sql`${traceSpans.attrs} ->> 'potion.cluster_id'`);
  const out: Record<string, number> = {};
  for (const r of rows) if (r.clusterId) out[r.clusterId] = Number(r.n);
  return out;
}

/** Character caps for a keepable sample. Over either → 'too-large': the
 * task is excluded rather than truncated into a different task. */
export const LEARNING_SAMPLE_MAX_PROMPT_CHARS = 32_000;
export const LEARNING_SAMPLE_MAX_COMPLETION_CHARS = 16_000;

export interface LearningSample {
  orgId: string;
  requestId: string;
  clusterId: string;
  model: string | null;
  /** The served conversation, verbatim (multimodal parts stripped here). */
  messages: ChatMessage[];
  completion: string;
  /** body.tools count — tool-carrying samples are metadata-only. */
  toolCount: number;
  /** body.response_format.type when the request constrained output. */
  responseFormat: string | null;
  costUsd: number;
  usage: Record<string, unknown>;
}

/**
 * Keep one request for the learning period, if the org consented and the
 * cap for that kind of work is not reached. Returns what happened; never
 * throws into the serving path.
 */
/** Enough samples of one kind of work to measure it. Mirrors the worker's LEARNING_PERIOD_MIN_ITEMS. */
export const LEARNING_MIN_ITEMS = 8;

export async function maybeKeepLearningSample(
  db: PotionDb,
  s: LearningSample,
  onThreshold?: (clusterId: string) => void,
): Promise<'kept' | 'no-consent' | 'cap' | 'too-large' | 'error'> {
  try {
    const inc = await getOrgIncumbents(db, s.orgId);
    if (!inc || !inc.samplingConsent) return 'no-consent';
    const counts = await learningSampleCounts(db, s.orgId);
    const before = counts[s.clusterId] ?? 0;
    if (before >= inc.sampleCapPerCluster) return 'cap';
    // Strip multimodal parts BEFORE anything is stored — base64 payloads
    // never reach rest — and count them so the derivation can exclude the
    // span (a vision task measured text-only is a different task).
    let partCount = 0;
    const messages: ChatMessage[] = s.messages.map((m) => {
      const parts = (m as { parts?: unknown[] }).parts;
      if (Array.isArray(parts)) partCount += parts.length;
      return { role: m.role, content: m.content };
    });
    const promptChars = messages.reduce((n, m) => n + m.content.length, 0);
    if (promptChars > LEARNING_SAMPLE_MAX_PROMPT_CHARS || s.completion.length > LEARNING_SAMPLE_MAX_COMPLETION_CHARS) {
      return 'too-large';
    }
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    const attrs = redactAttrs({
      'gen_ai.operation.name': 'chat',
      // Legacy pair kept for display + pre-capture spans' consumers; the
      // derivation prefers potion.messages.
      'gen_ai.prompt': (lastUser?.content ?? '').slice(0, 8000),
      'gen_ai.completion': s.completion,
      'potion.messages': messages as unknown as Record<string, unknown>[],
      'potion.tool_count': s.toolCount,
      ...(s.responseFormat !== null ? { 'potion.response_format': s.responseFormat } : {}),
      ...(partCount > 0 ? { 'potion.multimodal_parts': partCount } : {}),
      'potion.cluster_id': s.clusterId,
      'potion.sampled_for': 'learning-period',
    });
    await insertTraceSpans(db, [
      {
        orgId: s.orgId,
        traceId: `learn-${s.requestId}`,
        spanId: 'chat',
        parentId: null,
        name: LEARNING_SPAN_NAME,
        model: s.model,
        usage: s.usage,
        costUsd: s.costUsd,
        attrs,
        ts: new Date(),
      },
    ]);
    // the moment a kind of work has enough, measure it — no waiting for the clock
    if (before + 1 === LEARNING_MIN_ITEMS && onThreshold) onThreshold(s.clusterId);
    return 'kept';
  } catch {
    return 'error';
  }
}
