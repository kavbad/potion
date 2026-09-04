// Review outcome 2 (Step 8): CATALOG EDITS NEVER TOUCH RUN-FROZEN SPECS.
// The 0037 lab_harnesses catalog is a mutable convenience surface; a run's
// replay inputs are its OWN frozen spec + durable steps + terminal — none of
// which may move when the catalog row they were born from is edited. This
// ties 0037 to the Step 4 replay invariants: after an aggressive in-place
// edit of the catalog row (name, specText, sidecar, clusterId), a pre-edit
// run's replay input bytes and replay verdict are IDENTICAL.
import { describe, expect, it } from 'vitest';
import {
  createDb,
  createLabRun,
  getLabHarness,
  getLabRun,
  listLabSteps,
  migrate,
  seedIsolationOrgs,
  upsertLabHarness,
  ORG_A,
} from '@potion/db';
import { harnessSpecHash, type HarnessSpec } from '@potion/lab-spec';
import { runLeg, type LabTool } from './loop.js';
import { replayRun, type RecordedStep, type RecordedTerminal } from './replay.js';
import { ServingClient, type ServingRequest, type ServingResult } from './serving-client.js';

const ORG = ORG_A;

function spec(over: Partial<HarnessSpec> = {}): HarnessSpec {
  return {
    specVersion: 1,
    name: 'catalog invariance harness',
    brain: { policy: { type: 'min_cost', qualityFloor: 0 } },
    mission: { kind: 'task', goal: 'do the thing', doneDefinition: 'the thing is done' },
    superpowers: [],
    memory: { enabled: true },
    rules: ['be terse'],
    fuel: { maxUsdPerRun: 1, hardStop: true },
    checkIns: [],
    ...over,
  };
}

function ok(over: Partial<Extract<ServingResult, { kind: 'ok' }>> = {}): ServingResult {
  return {
    kind: 'ok',
    completionId: 'chatcmpl-fixed-for-replay',
    text: 'done.',
    toolCalls: [],
    finishReason: 'stop',
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    frontierTrace: 'cluster=code-gen;strategy=test;frontier=v1;policy=min_cost;fallback=0;provenance=mock',
    ...over,
  };
}

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

describe('0037 catalog ↔ Step 4 replay invariants', () => {
  it('editing the lab_harnesses row leaves a pre-edit run byte-identical under replay', async () => {
    const h = await createDb();
    await migrate(h.db);
    await seedIsolationOrgs(h.db);
    const s = spec();
    const hash = harnessSpecHash(s);

    // The catalog row the run is born from.
    await upsertLabHarness(h.db, {
      orgId: ORG,
      harnessHash: hash,
      name: s.name,
      specText: JSON.stringify(s),
      sidecar: { specHash: hash, note: 'original sidecar' },
      clusterId: 'code-gen',
    });

    // A TOOL-BEARING run: model → tool → model → wrap-up, so the replay
    // exercises the richest recorded shape (incl. the Step 8 wrap-up rule).
    await createLabRun(h.db, { id: 'run-inv', orgId: ORG, harnessHash: hash, harnessName: s.name, spec: s });
    const noteTool: LabTool = {
      name: 'record_note', description: 'record a note', parameters: { type: 'object' },
      external: false,
      run: async (input) => ({ noted: input }),
    };
    const outcome = await runLeg({
      db: h.db, client: scripted([
        ok({ text: '', finishReason: 'tool_calls', toolCalls: [{ id: 't1', type: 'function', function: { name: 'record_note', arguments: '{"text":"hi"}' } }] }),
        ok({ text: 'noted and done.' }),
        ok({ text: 'Wrap-up: recorded the note; done.' }),
      ]),
      runId: 'run-inv', orgId: ORG, spec: s, harnessHash: hash, tools: [noteTool],
    });
    expect(outcome.status).toBe('completed');

    // Snapshot the run's ENTIRE replay input, as bytes.
    const snapshot = async (): Promise<{ bytes: string; result: string }> => {
      const run = (await getLabRun(h.db, 'run-inv', ORG))!;
      const steps = await listLabSteps(h.db, 'run-inv', ORG);
      const recorded: RecordedStep[] = steps.map((x) => ({
        seq: x.seq, kind: x.kind as RecordedStep['kind'], payload: x.payload as RecordedStep['payload'],
      }));
      const terminal: RecordedTerminal = { state: run.state, reason: run.stateReason ?? null };
      const replaySpec = run.spec as HarnessSpec;
      return {
        bytes: JSON.stringify({ spec: replaySpec, steps: recorded, terminal }),
        result: JSON.stringify(replayRun(replaySpec, recorded, terminal)),
      };
    };

    const before = await snapshot();
    expect(JSON.parse(before.result).ok).toBe(true);

    // The EDIT: every mutable catalog column moves, same (orgId, harnessHash).
    // `hardStop` stays true — the schema pins it (`z.literal(true)`,
    // lab-spec/src/schema.ts): the fuel hard stop is not a thing a spec may
    // switch off, so a fixture setting it false was building a harness the
    // real parse path would refuse. The moved fuel value is maxUsdPerRun,
    // which is what this assertion actually needs.
    const edited = spec({ name: 'EDITED harness', fuel: { maxUsdPerRun: 99, hardStop: true } });
    await upsertLabHarness(h.db, {
      orgId: ORG,
      harnessHash: hash,
      name: edited.name,
      specText: JSON.stringify(edited),
      sidecar: { specHash: 'rewritten', note: 'sidecar replaced wholesale' },
      clusterId: 'chat',
    });
    // The edit really landed on the catalog…
    const row = (await getLabHarness(h.db, ORG, hash))!;
    expect(row.name).toBe('EDITED harness');
    expect(row.clusterId).toBe('chat');

    // …and the pre-edit run did not move by a byte: same replay input,
    // same replay verdict.
    const after = await snapshot();
    expect(after.bytes).toBe(before.bytes);
    expect(after.result).toBe(before.result);

    await h.close();
  }, 60_000);
});
