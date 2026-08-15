// Golden corpus generator (Step 4) — recorded runs as fixtures, GENERATED
// never hand-written (the Step 2 pattern). Runs the REAL loop against a
// scripted client with fixed ids and a fixed clock, dumps {spec, steps,
// terminal} as stable JSON. Regeneration is byte-identical, and a test
// asserts that. Each file is secret-scanned before write — the generator
// refuses to produce a fixture the checkpoint gate would have refused.
//
//   node fixtures/generate-golden.mjs [outDir]   (default: fixtures/golden)
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createDb, createLabRun, migrate, createOrg, listLabSteps, getLabRun, answerLabRun } from '@potion/db';
import { harnessSpecHash, scanRawValue } from '@potion/lab-spec';
import { runLeg } from '../dist/loop.js';

const OUT = process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), 'golden');
mkdirSync(OUT, { recursive: true });

const ORG = 'org_golden';
const CLOCK_BASE = 1_780_000_000_000; // fixed epoch; ticks 1s per reading

function fixedClock() {
  let n = 0;
  return { now: () => CLOCK_BASE + 1000 * n++ };
}

function baseSpec(over = {}) {
  return {
    specVersion: 1,
    name: 'golden harness',
    brain: { policy: { type: 'min_cost', qualityFloor: 0 } },
    mission: { kind: 'task', goal: 'Summarize the weekly report', doneDefinition: 'A summary exists' },
    superpowers: [],
    memory: { enabled: true },
    rules: ['be terse'],
    fuel: { maxUsdPerRun: 1, hardStop: true },
    checkIns: [],
    ...over,
  };
}

let completionN = 0;
function ok(over = {}) {
  completionN += 1;
  return {
    kind: 'ok',
    completionId: `chatcmpl-golden${String(completionN).padStart(4, '0')}`,
    text: 'done.',
    toolCalls: [],
    finishReason: 'stop',
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    frontierTrace: 'cluster=summarization;strategy=golden;frontier=v1;policy=min_cost;fallback=0;provenance=mock',
    ...over,
  };
}

function scripted(results) {
  const q = [...results];
  return {
    complete: async () => {
      const next = q.shift();
      if (!next) throw new Error('scripted exhausted');
      return next;
    },
    emitSpans: async () => true,
  };
}

const searchTool = {
  name: 'search',
  description: 'search the corpus',
  parameters: { type: 'object' },
  external: false,
  run: async (input) => ({ hits: [`result for ${JSON.stringify(input)}`], _memoryWrites: { lastQuery: input } }),
};
const emailTool = {
  name: 'send_email',
  description: 'send an email',
  parameters: { type: 'object' },
  external: true,
  run: async () => ({ sent: true }),
};

async function record(name, spec, legs, { runId, tools = [], preMemoryRun = null } = {}) {
  const h = await createDb();
  await migrate(h.db);
  await createOrg(h.db, { id: ORG, name: 'Golden Org' });
  const hash = harnessSpecHash(spec);
  const clock = fixedClock();
  completionN = 0;

  if (preMemoryRun !== null) {
    // memory-carry: an earlier run of the SAME harness writes memory first.
    await createLabRun(h.db, { id: `${runId}-pre`, orgId: ORG, harnessHash: hash, harnessName: spec.name, spec });
    await runLeg({
      db: h.db, client: scripted(preMemoryRun.results), runId: `${runId}-pre`, orgId: ORG,
      spec, harnessHash: hash, tools, clock, maxStepsPerLeg: 10,
    });
  }

  await createLabRun(h.db, { id: runId, orgId: ORG, harnessHash: hash, harnessName: spec.name, spec });
  const outcomes = [];
  for (const leg of legs) {
    if (leg.answer !== undefined) await answerLabRun(h.db, runId, ORG, leg.answer);
    outcomes.push(
      await runLeg({
        db: h.db, client: scripted(leg.results), runId, orgId: ORG,
        spec, harnessHash: hash, tools, clock,
        maxStepsPerLeg: leg.maxStepsPerLeg ?? 10,
      }),
    );
  }
  const steps = (await listLabSteps(h.db, runId, ORG)).map((s) => ({ seq: s.seq, kind: s.kind, payload: s.payload }));
  const run = await getLabRun(h.db, runId, ORG);
  await h.close();

  const fixture = { name, spec, steps, terminal: { state: run.state, reason: run.stateReason }, outcomes: outcomes.map((o) => o.status) };
  const secretHits = scanRawValue(fixture).filter((i) => i.code === 'secret-material');
  if (secretHits.length > 0) throw new Error(`refusing to write ${name}: ${secretHits[0].message}`);
  writeFileSync(path.join(OUT, `${name}.json`), JSON.stringify(fixture, null, 2) + '\n');
  console.log(`${name}: ${steps.length} steps, terminal=${run.state}`);
}

await record('task-simple', baseSpec(), [
  { results: [ok({ text: 'The weekly report says all is well.' })] },
], { runId: 'golden-task-simple' });

await record('task-tools', baseSpec({ name: 'golden tools harness' }), [
  { results: [
      ok({ text: '', finishReason: 'tool_calls', toolCalls: [{ id: 't1', type: 'function', function: { name: 'search', arguments: '{"q":"weekly report"}' } }] }),
      ok({ text: 'Summary based on the search: all is well.' }),
      // Step 8: the deliberate tool-free wrap-up call of a tool-bearing run.
      ok({ text: 'Wrap-up: searched the corpus and summarized; done-definition met.' }),
  ] },
], { runId: 'golden-task-tools', tools: [searchTool] });

await record('checkin-suspend-resume',
  baseSpec({ name: 'golden checkin harness', checkIns: [{ trigger: 'before-external-action' }] }),
  [
    { results: [ok({ text: '', finishReason: 'tool_calls', toolCalls: [{ id: 't1', type: 'function', function: { name: 'send_email', arguments: '{}' } }] })] },
    // Step 12: the resumed leg replays the APPROVED call out of the check-in
    // record rather than asking the model to re-propose it, so the scripted
    // answers here are what the model says AFTER seeing the tool result.
    { answer: 'yes, send it',
      results: [
        ok({ text: 'sent; mission complete.' }),
        ok({ text: 'Wrap-up: sent the email after approval; done-definition met.' }),
      ] },
  ],
  { runId: 'golden-checkin', tools: [emailTool] });

await record('fuel-killed',
  baseSpec({ name: 'golden fuel harness', mission: { kind: 'standing', goal: 'watch the queue' }, fuel: { maxUsdPerRun: 0.0000001, hardStop: true } }),
  [{ results: [ok({ text: 'first observation.' }), ok({ text: 'never reached' })] }],
  { runId: 'golden-fuel' });

await record('standing-legcap',
  baseSpec({ name: 'golden standing harness', mission: { kind: 'standing', goal: 'watch the queue' } }),
  [{ results: [ok({ text: 'observation one.' }), ok({ text: 'observation two.' })], maxStepsPerLeg: 2 }],
  { runId: 'golden-standing' });

await record('memory-carry', baseSpec({ name: 'golden memory harness' }),
  [{ results: [
      ok({ text: 'I remember the last query; summary complete.' }),
      ok({ text: 'Wrap-up: recalled memory and summarized; done-definition met.' }),
  ] }],
  {
    runId: 'golden-memory',
    tools: [searchTool],
    preMemoryRun: { results: [
      ok({ text: '', finishReason: 'tool_calls', toolCalls: [{ id: 't1', type: 'function', function: { name: 'search', arguments: '{"q":"history"}' } }] }),
      ok({ text: 'noted.' }),
      ok({ text: 'Wrap-up: noted the search history; done-definition met.' }),
    ] },
  });

console.log('golden corpus written to', OUT);
