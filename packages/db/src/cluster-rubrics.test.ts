// Cluster-rubric lifecycle (G1.5, migration 0022): only 'approved' is in
// force (at most one per cluster — partial unique index); approve is a
// transaction that demotes the prior approved rubric AND restamps the
// suite's items; rejected rubrics stay listed with their reason (owner
// rule: status + evidence always attached, failures visible).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  approveClusterRubric,
  approvedRubricForCluster,
  createDb,
  createOrg,
  getClusterRubric,
  insertClusterRubric,
  insertJudgeCalibration,
  listClusterRubrics,
  loadDerivedSuite,
  migrate,
  rejectClusterRubric,
  upsertDerivedSuite,
  type DbHandle,
} from './index.js';

let handle: DbHandle;
const db = () => handle.db;

const ORG = 'org_rub';
const CLUSTER = 'agent-abc123-def456';
const SUITE = `${CLUSTER}-replays-v1`;

function judgeItem(id: string, rubric: string) {
  return {
    id,
    clusterId: CLUSTER,
    prompt: [{ role: 'user' as const, content: `replay ${id}` }],
    scoring: {
      kind: 'llm-judge' as const,
      rubric,
      judgeModel: 'mock-judge',
      scale: [0, 1] as [number, number],
    },
  };
}

function rubricRow(overrides: Partial<Parameters<typeof insertClusterRubric>[1]> = {}) {
  return {
    orgId: ORG,
    clusterId: CLUSTER,
    suiteId: SUITE,
    rubricText: 'Grade correctness proportionally.',
    rubricHash: 'hash-a',
    generatorModel: 'mock-cheap',
    providerMode: 'mock',
    exemplarCount: 3,
    ...overrides,
  };
}

beforeEach(async () => {
  handle = await createDb();
  await migrate(handle.db);
  await createOrg(handle.db, { id: ORG, name: 'Rubrics' });
  // A mixed-rubric suite (the G1.4-era drift restamp must homogenize).
  await upsertDerivedSuite(db(), {
    suiteId: SUITE,
    clusterId: CLUSTER,
    orgId: ORG,
    manifest: {},
    items: [judgeItem(`${SUITE}-aaaa`, 'old rubric one'), judgeItem(`${SUITE}-bbbb`, 'old rubric two')],
    itemCap: 25,
  });
});

afterEach(async () => {
  await handle.close();
});

describe('lifecycle', () => {
  it('approve demotes prior approved to superseded, restamps the suite homogeneous', async () => {
    const first = await insertClusterRubric(db(), rubricRow({ rubricText: 'rubric v1' }));
    expect(await approveClusterRubric(db(), first)).toBe(2); // both items restamped
    expect((await approvedRubricForCluster(db(), CLUSTER))?.id).toBe(first);
    let items = (await loadDerivedSuite(db(), SUITE))!.items;
    expect(
      items.map((i) => (i.scoring.kind === 'llm-judge' ? i.scoring.rubric : null)),
    ).toEqual(['rubric v1', 'rubric v1']);

    // Second approval supersedes the first atomically.
    const second = await insertClusterRubric(db(), rubricRow({ rubricText: 'rubric v2', rubricHash: 'hash-b' }));
    await approveClusterRubric(db(), second);
    expect((await approvedRubricForCluster(db(), CLUSTER))?.id).toBe(second);
    const firstRow = await getClusterRubric(db(), first);
    expect(firstRow?.status).toBe('superseded');
    expect(firstRow?.statusReason).toContain('superseded by');
    items = (await loadDerivedSuite(db(), SUITE))!.items;
    expect(
      items.map((i) => (i.scoring.kind === 'llm-judge' ? i.scoring.rubric : null)),
    ).toEqual(['rubric v2', 'rubric v2']);
  });

  it('only pending can be approved/rejected; rejection keeps the row + reason', async () => {
    const id = await insertClusterRubric(db(), rubricRow());
    await rejectClusterRubric(db(), id, 'failed calibration at r=0.61 and was not deployed');
    const row = await getClusterRubric(db(), id);
    expect(row?.status).toBe('rejected');
    expect(row?.statusReason).toBe('failed calibration at r=0.61 and was not deployed');
    // rejected rows are NOT hidden from the list
    const listed = await listClusterRubrics(db(), ORG);
    expect(listed.some((r) => r.rubric.id === id && r.rubric.status === 'rejected')).toBe(true);
    // and cannot be approved afterwards
    await expect(approveClusterRubric(db(), id)).rejects.toThrow(/only pending/);
    await expect(rejectClusterRubric(db(), id, 'again')).rejects.toThrow(/only pending/);
  });

  it('list pairs every row with its calibration evidence; org-scoped', async () => {
    const calId = await insertJudgeCalibration(db(), {
      clusterId: CLUSTER,
      suiteId: SUITE,
      judgeModel: 'mock-judge',
      judgeResolvedModel: 'mock-judge-v1',
      answererModel: 'synthetic-perturbation',
      pricesVersion: 'test',
      providerMode: 'mock',
      n: 9,
      pearsonVsTruth: 0.91,
      spearmanVsTruth: 0.9,
      meanAbsErr: 0.1,
      flagged: false,
      rubricHash: 'hash-a',
    });
    await insertClusterRubric(db(), rubricRow({ calibrationId: calId }));
    await insertClusterRubric(
      db(),
      rubricRow({ rubricHash: 'hash-c', statusReason: 'insufficient referenced items (2 < 3) — uncalibrated' }),
    );
    const listed = await listClusterRubrics(db(), ORG);
    expect(listed).toHaveLength(2);
    const withCal = listed.find((r) => r.rubric.calibrationId !== null)!;
    expect(withCal.calibration?.pearsonVsTruth).toBe(0.91);
    const uncal = listed.find((r) => r.rubric.calibrationId === null)!;
    expect(uncal.calibration).toBeNull();
    expect(uncal.rubric.statusReason).toContain('uncalibrated');
    // another org sees nothing
    expect(await listClusterRubrics(db(), 'org_other')).toEqual([]);
  });
});
