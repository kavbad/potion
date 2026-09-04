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
import { ServingClient, type ServingRequest, type ServingResult } from './serving-client.js';

const SPEC: HarnessSpec = {
  specVersion: 1, name: 'file claims harness',
  brain: { policy: { type: 'min_cost', qualityFloor: 0 } },
  mission: { kind: 'task', goal: 'analyze the data and produce files', doneDefinition: 'files exist' },
  superpowers: [], memory: { enabled: false }, rules: [],
  fuel: { maxUsdPerRun: 1, hardStop: true }, checkIns: [],
};

function scripted(results: ServingResult[]): ServingClient {
  const queue = [...results];
  // A REAL ServingClient with its outbound methods scripted, so the stub's
  // replies are type-checked against ServingResult.
  const client = new ServingClient({ baseUrl: 'http://serving.invalid', apiKey: 'test-key' });
  client.complete = async (_req: ServingRequest) => {
    const next = queue.shift();
    if (!next) throw new Error('scripted client exhausted');
    return next;
  };
  client.emitSpans = async () => true;
  return client;
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

  it('THE WRAP-UP IS UNDER THE LAW (run-32b24af3): a file-free stop passes the main check, the wrap-up names an absent file — annulled, repaired, produced, replay clean', async () => {
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
        // The specimen: the tools slot stops with prose that names NO
        // files (the main law has nothing to flag)…
        ok({ text: 'I finished the analysis and computed every figure; the workbook details follow in the summary.' }),
        // …and the wrap-up — the report the customer reads — names a
        // deliverable the run does not hold.
        ok({ text: 'Wrap-up: computed every figure; analysis.xlsx holds the totals, by-day and by-customer sheets.' }),
        // The annulled completion continues the mission: write it…
        ok({ text: '', finishReason: 'tool_calls', toolCalls: [{ id: 'w1', type: 'function', function: { name: 'write_out', arguments: '{}' } }] }),
        // …stop honestly, and the second wrap-up rides to completion.
        ok({ text: 'analysis.xlsx is now truly written with every computed sheet in place. done.' }),
        ok({ text: 'Wrap-up: produced analysis.xlsx after the repair; done.' }),
      ]),
      runId: 'run-fc', orgId: ORG_A, spec: SPEC, harnessHash: hash, tools: [writer],
    });
    expect(leg.status).toBe('completed');
    const steps = await listLabSteps(h.db, 'run-fc', ORG_A);
    const stamped = steps.filter((x) => (x.payload as { fileClaimRepair?: string[] }).fileClaimRepair !== undefined);
    expect(stamped.length).toBe(1);
    expect((stamped[0]!.payload as { fileClaimRepair: string[]; slot?: string }).fileClaimRepair).toEqual(['analysis.xlsx']);
    expect((stamped[0]!.payload as { slot?: string }).slot).toBe('brain'); // the stamp sits on the WRAP step
    const rec = await recordOf(h);
    const res = replayRun(SPEC, rec.steps, rec.terminal);
    expect(res.ok, JSON.stringify(!res.ok ? res.divergences : [])).toBe(true);
    await h.close();
  }, 60_000);

  it('THE EMPTY-STOP LAW (run-4638e4a1): a zero-token stop mid-mission is not a completion — one repair, real work follows, replay clean', async () => {
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
        // The specimen: the cheap route answers a fresh mission with a
        // ZERO-TOKEN stop — and keeps doing it through both unrecorded
        // retries. Report bar unmet → repair, not completion.
        ok({ text: '' }),
        ok({ text: '' }),
        ok({ text: '' }),
        // The repair round does the actual work…
        ok({ text: '', finishReason: 'tool_calls', toolCalls: [{ id: 'w1', type: 'function', function: { name: 'write_out', arguments: '{}' } }] }),
        // …and stops with a real report; the wrap-up rides to completion.
        ok({ text: 'analysis.xlsx is written with totals, by-day and by-customer sheets. done.' }),
        ok({ text: 'Wrap-up: wrote analysis.xlsx after the nudge; done.' }),
      ]),
      runId: 'run-fc', orgId: ORG_A, spec: SPEC, harnessHash: hash, tools: [writer],
    });
    expect(leg.status).toBe('completed');
    const steps = await listLabSteps(h.db, 'run-fc', ORG_A);
    const stamped = steps.filter((x) => (x.payload as { emptyStopRepair?: boolean }).emptyStopRepair === true);
    expect(stamped.length).toBe(1);
    expect(stamped[0]!.seq).toBe(1);
    const rec = await recordOf(h);
    const res = replayRun(SPEC, rec.steps, rec.terminal);
    expect(res.ok, JSON.stringify(!res.ok ? res.divergences : [])).toBe(true);
    await h.close();
  }, 60_000);

  it('empty-stop law: one round only — a second empty stop completes (report-less, the record is honest about it)', async () => {
    const { h, hash } = await fresh();
    const leg = await runLeg({
      db: h.db,
      client: scripted([
        // First empty stop: two unrecorded retries, then the stamped repair.
        ok({ text: '' }),
        ok({ text: '' }),
        ok({ text: '' }),
        // Second empty stop (retries exhausted again): the one-round guard
        // is consumed, so this one completes report-less.
        ok({ text: '' }),
        ok({ text: '' }),
        ok({ text: '' }),
        // toolDefs exist even when the tool list is empty at runLeg's level
        // for tool-bearing specs; the wrap-up still rides on completion.
        ok({ text: 'Wrap-up: the mission stopped without producing a report.' }),
      ]),
      runId: 'run-fc', orgId: ORG_A, spec: SPEC, harnessHash: hash, tools: [],
    });
    expect(leg.status).toBe('completed');
    const steps = await listLabSteps(h.db, 'run-fc', ORG_A);
    expect(steps.filter((x) => (x.payload as { emptyStopRepair?: boolean }).emptyStopRepair === true).length).toBe(1);
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

// THE INTENTION-STOP LAW (2026-09-04) — from the production teardown: two
// thirds of the runs scoring 0–2 ended by ANNOUNCING the next action and
// stopping. The strings below are verbatim final words from real records.
describe('THE INTENTION-STOP LAW: a promise is not a deliverable', () => {
  it('the production specimen "Let me re-run." gets one repair, then the work actually lands', async () => {
    const { h, hash } = await fresh();
    const writer: LabTool = {
      name: 'write_out', description: 'write the file', parameters: { type: 'object' },
      external: false,
      run: async () => {
        await upsertLabRunFile(h.db, { orgId: ORG_A, runId: 'run-fc', name: 'verdict.json', content: Buffer.from('{}') });
        return { wrote: 'verdict.json' };
      },
    };
    const leg = await runLeg({
      db: h.db,
      client: scripted([
        ok({ text: 'Syntax error from the apostrophe in the customer name. Let me re-run.' }),
        ok({ text: '', finishReason: 'tool_calls', toolCalls: [{ id: 'w1', type: 'function', function: { name: 'write_out', arguments: '{}' } }] }),
        ok({ text: 'verdict.json is written with all 20 checks recomputed and passing. done.' }),
        ok({ text: 'Wrap-up: wrote the verdict after the nudge.' }),
      ]),
      runId: 'run-fc', orgId: ORG_A, spec: SPEC, harnessHash: hash, tools: [writer],
    });
    expect(leg.status).toBe('completed');
    const steps = await listLabSteps(h.db, 'run-fc', ORG_A);
    const stamped = steps.filter((x) => (x.payload as { intentionStopRepair?: boolean }).intentionStopRepair === true);
    expect(stamped.length).toBe(1);
    expect(stamped[0]!.seq).toBe(1);
    const rec = await recordOf(h);
    const res = replayRun(SPEC, rec.steps, rec.terminal);
    expect(res.ok, JSON.stringify(!res.ok ? res.divergences : [])).toBe(true);
    await h.close();
  }, 60_000);

  it('the participle form — "— now writing up all 20 checks" — trips it too', async () => {
    const { h, hash } = await fresh();
    const leg = await runLeg({
      db: h.db,
      client: scripted([
        ok({ text: 'Fixed the status issue — now writing up all 20 checks I have recomputed.' }),
        ok({ text: 'I could not finish it: the sandbox rejected the path. Reporting that plainly rather than promising again.' }),
        ok({ text: 'Wrap-up: blocked on the write, said so.' }),
      ]),
      runId: 'run-fc', orgId: ORG_A, spec: SPEC, harnessHash: hash, tools: [],
    });
    expect(leg.status).toBe('completed');
    const rec = await recordOf(h);
    expect(replayRun(SPEC, rec.steps, rec.terminal).ok).toBe(true);
    await h.close();
  }, 60_000);

  it('a real report that MENTIONS its plan but delivers still completes — only the last sentence is read', async () => {
    const { h, hash } = await fresh();
    const leg = await runLeg({
      db: h.db,
      client: scripted([
        ok({
          text:
            'First I said I would compute the daily totals, so let me walk through what I found. ' +
            'Saturday leads at $1,778.40 across 87 checks, Friday is weakest at $612.10. ' +
            'Every figure comes from the attached file. Let me know if you want the by-customer cut too.',
        }),
        ok({ text: 'Wrap-up: reported the totals.' }),
      ]),
      runId: 'run-fc', orgId: ORG_A, spec: SPEC, harnessHash: hash, tools: [],
    });
    expect(leg.status).toBe('completed');
    const steps = await listLabSteps(h.db, 'run-fc', ORG_A);
    expect(steps.filter((x) => (x.payload as { intentionStopRepair?: boolean }).intentionStopRepair === true).length).toBe(0);
    await h.close();
  }, 60_000);

  it('once per run: a second promise-stop completes rather than looping forever', async () => {
    const { h, hash } = await fresh();
    const leg = await runLeg({
      db: h.db,
      client: scripted([
        ok({ text: 'Good. Let me run the analysis now.' }),
        ok({ text: 'Almost there. Let me run it now.' }),
        ok({ text: 'Wrap-up: it kept promising; the record says so.' }),
      ]),
      runId: 'run-fc', orgId: ORG_A, spec: SPEC, harnessHash: hash, tools: [],
    });
    expect(leg.status).toBe('completed');
    const steps = await listLabSteps(h.db, 'run-fc', ORG_A);
    expect(steps.filter((x) => (x.payload as { intentionStopRepair?: boolean }).intentionStopRepair === true).length).toBe(1);
    const rec = await recordOf(h);
    expect(replayRun(SPEC, rec.steps, rec.terminal).ok).toBe(true);
    await h.close();
  }, 60_000);
});

describe('ONE LAW PER STEP', () => {
  it('a promise that ALSO names a missing file is claimed by file-claims alone — two stamps would make an honest run read as drift', async () => {
    const { h, hash } = await fresh();
    const leg = await runLeg({
      db: h.db,
      client: scripted([
        // The real record's words: a promise AND a file claim in one stop.
        ok({ text: 'The previous run was interrupted and did not produce verdict.json. Let me write it now.' }),
        ok({ text: 'Corrected: nothing was written, and I am reporting that rather than claiming it.' }),
        ok({ text: 'Wrap-up: honest about the missing file.' }),
      ]),
      runId: 'run-fc', orgId: ORG_A, spec: SPEC, harnessHash: hash, tools: [],
    });
    expect(leg.status).toBe('completed');
    const steps = await listLabSteps(h.db, 'run-fc', ORG_A);
    const first = steps[0]!.payload as { fileClaimRepair?: string[]; intentionStopRepair?: boolean };
    expect(first.fileClaimRepair).toEqual(['verdict.json']);
    expect(first.intentionStopRepair).toBeUndefined();
    const rec = await recordOf(h);
    const res = replayRun(SPEC, rec.steps, rec.terminal);
    expect(res.ok, JSON.stringify(!res.ok ? res.divergences : [])).toBe(true);
    await h.close();
  }, 60_000);
});
