import { describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createDb, migrate, createOrg, traceSpans, upsertOrgIncumbents } from '@potion/db';
import { LEARNING_SPAN_NAME, learningSampleCounts, maybeKeepLearningSample } from '../src/learning/sampling.js';

describe('learning-period sampling', () => {
  it('no consent → no rows; consent → a redacted row; the per-cluster cap holds', async () => {
    const h = await createDb();
    await migrate(h.db);
    await createOrg(h.db, { id: 'org-s', name: 'S' });
    const sample = (n: number) => ({
      orgId: 'org-s', requestId: `r${n}`, clusterId: 'classification', model: 'or-gpt-mini',
      prompt: `Is this positive? Email me at jane.doe@example.com · ${n}`, completion: 'negative', costUsd: 0.00002, usage: { inputTokens: 10 },
    });
    expect(await maybeKeepLearningSample(h.db, sample(0))).toBe('no-consent');
    await upsertOrgIncumbents(h.db, { orgId: 'org-s', models: ['or-gpt-full'], other: null, samplingConsent: false });
    expect(await maybeKeepLearningSample(h.db, sample(0))).toBe('no-consent');
    await upsertOrgIncumbents(h.db, { orgId: 'org-s', models: ['or-gpt-full'], other: null, samplingConsent: true });
    expect(await maybeKeepLearningSample(h.db, sample(0))).toBe('kept');
    const rows = await h.db.select().from(traceSpans).where(and(eq(traceSpans.orgId, 'org-s'), eq(traceSpans.name, LEARNING_SPAN_NAME)));
    expect(rows).toHaveLength(1);
    const attrs = rows[0]!.attrs as Record<string, string>;
    expect(attrs['gen_ai.prompt']).not.toContain('jane.doe@example.com');
    expect(attrs['potion.cluster_id']).toBe('classification');
    // the cap: 40 per cluster by default
    for (let i = 1; i < 45; i++) await maybeKeepLearningSample(h.db, sample(i));
    expect((await learningSampleCounts(h.db, 'org-s')).classification).toBe(40);
    expect(await maybeKeepLearningSample(h.db, sample(99))).toBe('cap');
    await h.close();
  });
});
