import { describe, expect, it } from 'vitest';
import { createDb, migrate, createOrg } from './index.js';
import { getOrgIncumbents, upsertOrgIncumbents } from './repos/org-incumbents.js';
import { getLearningProposal, insertLearningProposal, latestProposalsByCluster, learningSpendSince, listLearningProposals, markProposalApplied } from './repos/learning-proposals.js';

async function fresh() {
  const h = await createDb();
  await migrate(h.db);
  await createOrg(h.db, { id: 'org-lp', name: 'LP' });
  return h;
}

describe('learning period repos', () => {
  it('incumbents: absent until set; upsert replaces; consent is an explicit flag', async () => {
    const h = await fresh();
    expect(await getOrgIncumbents(h.db, 'org-lp')).toBeNull();
    const a = await upsertOrgIncumbents(h.db, { orgId: 'org-lp', models: ['or-gpt-full', 'or-sonnet'], other: null, samplingConsent: false });
    expect(a.models).toEqual(['or-gpt-full', 'or-sonnet']);
    expect(a.samplingConsent).toBe(false);
    expect(a.sampleCapPerCluster).toBe(40);
    const b = await upsertOrgIncumbents(h.db, { orgId: 'org-lp', models: [], other: 'my fine-tune', samplingConsent: true });
    expect(b.models).toEqual([]);
    expect(b.other).toBe('my fine-tune');
    expect(b.samplingConsent).toBe(true);
    await h.close();
  });

  it('proposals: newest per cluster, one-shot apply, spend since', async () => {
    const h = await fresh();
    const base = {
      orgId: 'org-lp', suiteId: 'classification-replays-v1', incumbentModel: 'or-gpt-full', incumbentHash: 'h-inc', incumbentQuality: 0.96,
      incumbentCostPer1K: 0.54, servingHash: 'h-srv', servingModel: 'or-gpt-mini', servingQuality: 0.95, servingCostPer1K: 0.035,
      retention: { mean: 0.99 }, suggestedFloor: 0.96, projectedSaving: 0.93, items: 12, spendUsd: 0.4,
    };
    await insertLearningProposal(h.db, { ...base, id: 'lp-1', clusterId: 'classification', createdAt: new Date('2026-08-20T00:00:00Z') });
    await insertLearningProposal(h.db, { ...base, id: 'lp-2', clusterId: 'classification', createdAt: new Date('2026-08-22T00:00:00Z'), spendUsd: 0.6 });
    await insertLearningProposal(h.db, { ...base, id: 'lp-3', clusterId: 'extraction', createdAt: new Date('2026-08-22T01:00:00Z'), spendUsd: 0.5 });
    expect((await listLearningProposals(h.db, 'org-lp')).map((p) => p.id)).toEqual(['lp-3', 'lp-2', 'lp-1']);
    const latest = await latestProposalsByCluster(h.db, 'org-lp');
    expect(latest.get('classification')?.id).toBe('lp-2');
    expect(latest.get('extraction')?.id).toBe('lp-3');
    expect(await markProposalApplied(h.db, 'org-lp', 'lp-2', 'pol-x')).toBe(true);
    expect(await markProposalApplied(h.db, 'org-lp', 'lp-2', 'pol-y')).toBe(false);
    expect((await getLearningProposal(h.db, 'org-lp', 'lp-2'))?.appliedPolicyId).toBe('pol-x');
    expect(await learningSpendSince(h.db, 'org-lp', new Date('2026-08-21T00:00:00Z'))).toBeCloseTo(1.1, 6);
    await h.close();
  });
});
