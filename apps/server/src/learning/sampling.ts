// Sampling for the learning period: under consent, the serving path keeps a
// PII-redacted sample of an org's requests (prompt + answer) as trace spans
// — the same store the derived-suite builder already reads — capped per
// kind of work. No consent, no rows. Ever.
import { and, eq, sql } from 'drizzle-orm';
import { redactAttrs } from '@potion/core';
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

export interface LearningSample {
  orgId: string;
  requestId: string;
  clusterId: string;
  model: string | null;
  prompt: string;
  completion: string;
  costUsd: number;
  usage: Record<string, unknown>;
}

/**
 * Keep one request for the learning period, if the org consented and the
 * cap for that kind of work is not reached. Returns what happened; never
 * throws into the serving path.
 */
export async function maybeKeepLearningSample(db: PotionDb, s: LearningSample): Promise<'kept' | 'no-consent' | 'cap' | 'error'> {
  try {
    const inc = await getOrgIncumbents(db, s.orgId);
    if (!inc || !inc.samplingConsent) return 'no-consent';
    const counts = await learningSampleCounts(db, s.orgId);
    if ((counts[s.clusterId] ?? 0) >= inc.sampleCapPerCluster) return 'cap';
    const attrs = redactAttrs({
      'gen_ai.operation.name': 'chat',
      'gen_ai.prompt': s.prompt.slice(0, 8000),
      'gen_ai.completion': s.completion.slice(0, 8000),
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
    return 'kept';
  } catch {
    return 'error';
  }
}
