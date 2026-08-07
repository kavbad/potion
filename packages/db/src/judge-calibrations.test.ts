// Judge-calibration evidence repo (G0.2, migration 0018).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDb, migrate, type DbHandle } from './index.js';
import {
  insertJudgeCalibration,
  latestJudgeCalibration,
  listJudgeCalibrations,
} from './repos/judge-calibrations.js';

let handle: DbHandle;

beforeEach(async () => {
  handle = await createDb();
  await migrate(handle.db);
});

afterEach(async () => {
  await handle.close();
});

describe('judge_calibrations repo', () => {
  it('round-trips a record; latest is mode-filtered (mock never reads as live)', async () => {
    const id = await insertJudgeCalibration(handle.db, {
      clusterId: 'extraction',
      suiteId: 'extraction-authored-v1',
      judgeModel: 'judge-class',
      judgeResolvedModel: 'anthropic/claude-sonnet-4.5',
      answererModel: 'oa-mini',
      pricesVersion: '2026-08-04-or2',
      providerMode: 'live',
      n: 30,
      pearsonVsTruth: 0.91,
      judgeAgreement: 0.88,
      meanAbsErr: 0.07,
      flagged: false,
      spendUsd: 0.12,
      pairs: [{ itemId: 'x-01', truth: 1, scores: { 'judge-class': 0.75 } }],
    });
    expect(id).toBeTruthy();
    const live = await latestJudgeCalibration(handle.db, { judgeModel: 'judge-class', providerMode: 'live' });
    expect(live?.pearsonVsTruth).toBeCloseTo(0.91, 10);
    expect(live?.pairs[0]).toEqual({ itemId: 'x-01', truth: 1, scores: { 'judge-class': 0.75 } });
    // provider-mode filter: no mock record exists
    expect(await latestJudgeCalibration(handle.db, { judgeModel: 'judge-class', providerMode: 'mock' })).toBeNull();
    // unknown judge → null
    expect(await latestJudgeCalibration(handle.db, { judgeModel: 'nope' })).toBeNull();
    expect(await listJudgeCalibrations(handle.db)).toHaveLength(1);
  });

  it('latest wins across multiple records for the same judge', async () => {
    const base = {
      judgeModel: 'mock-judge',
      judgeResolvedModel: 'mock-judge-v1',
      answererModel: 'mock-cheap',
      pricesVersion: 'v',
      providerMode: 'mock',
      flagged: false,
      spendUsd: 0,
      pairs: [],
    };
    await insertJudgeCalibration(handle.db, { ...base, n: 10, pearsonVsTruth: 0.7, createdAt: new Date(Date.now() - 60_000) });
    await insertJudgeCalibration(handle.db, { ...base, n: 30, pearsonVsTruth: 0.9 });
    const latest = await latestJudgeCalibration(handle.db, { judgeModel: 'mock-judge' });
    expect(latest?.n).toBe(30);
  });
});
