// THE FILE-CLAIMS LAW (2026-09-01) — born from the flagship's resurrected
// run: the model computed everything, got stranded before the write,
// resumed, and ASSERTED the deliverables existed. A completion whose text
// names files the run does not hold gets ONE repair round: produce them
// or correct the report. Mirrored in replay.
import { describe, expect, it } from 'vitest';
import {
  createDb,
  createLabRun,
  getLabRun,
  listLabSteps,
  migrate,
  seedIsolationOrgs,
  upsertLabRunFile,
  ORG_A,
  type DbHandle,
} from '@potion/db';
import { harnessSpecHash, type HarnessSpec } from '@potion/lab-spec';
import { missingClaimedFiles, runLeg, type LabTool } from './loop.js';
import { replayRun, type RecordedStep, type RecordedTerminal } from './replay.js';
import type { ServingClient, ServingRequest, ServingResult } from './serving-client.js';

const SPEC: HarnessSpec = {
  specVersion: 1, name: 'file claims harness',
  brain: { policy: { type: 'min_cost', qualityFloor: 0 } },
  mission: { kind: 'task', goal: 'analyze the data and produce files', doneDefinition: 'files exist' },
  superpowers: [], memory: { enabled: false }, rules: [],
  fuel: { maxUsdPerRun: 1, hardStop: true }, checkIns: [],
};

function scripted(results: ServingResult[]): ServingClient {
  const queue = [...results];
  return {
    complete: async (_req: ServingRequest) => {
      const next = queue.shift();
      if (!next) throw new Error('scripted client exhausted');
      return next;
    },
    emitSpans: async () => true,
  } as unknown as ServingClient;
}
function ok(over: Partial<Extract<ServingResult, { kind: 'ok' }>> = {}): ServingResult {
  return {
    kind: 'ok', completionId: `chatcmpl-${Math.random().toString(36).slice(2, 10)}`,
    text: 'done.', toolCalls: [], finishReason: 'stop',
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    frontierTrace: 'cluster=code-gen;strategy=test;frontier=v1;policy=min_cost;fallback=0;provenance=mock',
    ...over,
  };
}
async function fresh(): Promise<{ h: DbHandle; hash: string }> {
  const h = await createDb();
  await migrate(h.db);
  await seedIsolationOrgs(h.db);
  const hash = harnessSpecHash(SPEC);
  await createLabRun(h.db, { id: 'run-fc', orgId: ORG_A, harnessHash: hash, harnessName: SPEC.name, spec: SPEC });
  return { h, hash };
}
async function recordOf(h: DbHandle): Promise<{ steps: RecordedStep[]; terminal: RecordedTerminal }> {
  const rows = await listLabSteps(h.db, 'run-fc', ORG_A);
  const run = (await getLabRun(h.db, 'run-fc', ORG_A))!;
  return {
    steps: rows.map((r) => ({ seq: r.seq, kind: r.kind, payload: r.payload })) as RecordedStep[],
    terminal: { state: run.state } as RecordedTerminal,
  };
}

describe('missingClaimedFiles — the pure check', () => {
  it('flags claimed-but-absent names; input files and real files never trigger; paths match by basename', () => {
    expect(missingClaimedFiles('Files: analysis.xlsx and chart.png are ready; input was orders.csv.', ['orders.csv'])).toEqual(['analysis.xlsx', 'chart.png']);
    expect(missingClaimedFiles('deliverables/report.md is written', ['deliverables/report.md'])).toEqual([]);
    expect(missingClaimedFiles('see report.md', ['deliverables/report.md'])).toEqual([]);
    expect(missingClaimedFiles('no file names here at all', [])).toEqual([]);
  });
});

describe('the law in the loop', () => {
  it('a completion claiming absent files gets ONE repair; producing them then completes; replay clean', async () => {
    const { h, hash } = await fresh();
    const writer: LabTool = {
      name: 'write_out', description: 'write the file', parameters: { type: 'object' },
      external: false,
      run: async () => {
        await upsertLabRunFile(h.db, { orgId: ORG_A, runId: 'run-fc', name: 'analysis.xlsx', content: Buffer.from('PK') });
        return { wrote: 'analysis.xlsx' };
      },
    };
    const leg = await runLeg({
      db: h.db,
      client: scripted([
        ok({ text: 'All done. The workbook analysis.xlsx contains the four sheets with every computed number.' }),
        // the repair round: the model actually writes, then reports honestly
        ok({ text: '', finishReason: 'tool_calls', toolCalls: [{ id: 'w1', type: 'function', function: { name: 'write_out', arguments: '{}' } }] }),
        ok({ text: 'Corrected: analysis.xlsx is now truly written with the four computed sheets. done.' }),
        ok({ text: 'Wrap-up: produced the file after the repair; done.' }),
      ]),
      runId: 'run-fc', orgId: ORG_A, spec: SPEC, harnessHash: hash, tools: [writer],
    });
    expect(leg.status).toBe('completed');
    const steps = await listLabSteps(h.db, 'run-fc', ORG_A);
    const stamped = steps.find((x) => (x.payload as { fileClaimRepair?: string[] }).fileClaimRepair !== undefined);
    expect(stamped).toBeDefined();
    expect((stamped!.payload as { fileClaimRepair: string[] }).fileClaimRepair).toEqual(['analysis.xlsx']);
    const rec = await recordOf(h);
    const res = replayRun(SPEC, rec.steps, rec.terminal);
    expect(res.ok, JSON.stringify(!res.ok ? res.divergences : [])).toBe(true);
    await h.close();
  }, 60_000);

  it('one round only: a second false claim completes anyway (the judge takes it from there)', async () => {
    const { h, hash } = await fresh();
    const leg = await runLeg({
      db: h.db,
      client: scripted([
        ok({ text: 'The workbook results.xlsx has been produced with everything computed inside it.' }),
        ok({ text: 'I checked again and results.xlsx definitely exists with all the computed numbers in it.' }),
        ok({ text: 'Wrap-up: reported; done.' }),
      ]),
      runId: 'run-fc', orgId: ORG_A, spec: SPEC, harnessHash: hash, tools: [],
    });
    expect(leg.status).toBe('completed');
    const rec = await recordOf(h);
    const res = replayRun(SPEC, rec.steps, rec.terminal);
    expect(res.ok, JSON.stringify(!res.ok ? res.divergences : [])).toBe(true);
    await h.close();
  }, 60_000);
});
