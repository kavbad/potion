// Programmatic entry points + a minimal argv CLI (run / resume / answer /
// kill / show). The answer channel in Step 3 is the CLI — routes are L4.
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import {
  answerLabRun,
  createDb,
  createLabRun,
  getLabRun,
  killLabRun,
  listLabSteps,
  migrate,
} from '@potion/db';
import { parseHarnessSpecText, type HarnessSpec } from '@potion/lab-spec';
import { runLeg, type LabTool, type LegOutcome } from './loop.js';
import { ServingClient } from './serving-client.js';
import { spansForSteps } from './spans.js';

export interface StartRunOptions {
  db: Parameters<typeof createLabRun>[0];
  client: ServingClient;
  orgId: string;
  specText: string;
  tools?: LabTool[];
  /** Step 10: typed leg-start superpower records, threaded to the loop. */
  legNotes?: Array<{ toolName: string; note: unknown }>;
  /** Step 11: authored package guidance for the loaded connectors. */
  toolGuidance?: readonly string[];
  runId?: string;
  maxStepsPerLeg?: number;
  /** Step 8 per-slot policy pins, threaded to the loop. */
  policyRefs?: { brain?: string; tools?: string };
  /** X8: the steering inlet, threaded to the loop. */
  readSteers?: () => Promise<Array<{ id: string; text: string }>>;
  markSteersConsumed?: (ids: string[], seq: number) => Promise<void>;
}

/** Parse+validate the spec (every Step 2 gate applies), create the run,
 * execute the first leg, emit spans for whatever got checkpointed. */
export async function startRun(opts: StartRunOptions): Promise<{ runId: string; outcome: LegOutcome }> {
  const parsed = parseHarnessSpecText(opts.specText);
  if (!parsed.ok) {
    const first = parsed.issues[0]!;
    throw new Error(`invalid harness spec: [${first.code}] ${first.path}: ${first.message}`);
  }
  const runId = opts.runId ?? `run-${randomUUID().slice(0, 8)}`;
  await createLabRun(opts.db, {
    id: runId,
    orgId: opts.orgId,
    harnessHash: parsed.hash,
    harnessName: parsed.spec.name,
    spec: parsed.spec,
  });
  const outcome = await executeLeg(opts, runId, parsed.spec, parsed.hash);
  return { runId, outcome };
}

export async function resumeRun(
  opts: StartRunOptions & { runId: string; answer?: string },
): Promise<LegOutcome> {
  const parsed = parseHarnessSpecText(opts.specText);
  if (!parsed.ok) throw new Error('invalid harness spec on resume');
  if (opts.answer !== undefined) {
    await answerLabRun(opts.db, opts.runId, opts.orgId, opts.answer);
  }
  return executeLeg(opts, opts.runId, parsed.spec, parsed.hash);
}

async function executeLeg(
  opts: StartRunOptions,
  runId: string,
  spec: HarnessSpec,
  hash: string,
): Promise<LegOutcome> {
  const outcome = await runLeg({
    db: opts.db,
    client: opts.client,
    runId,
    orgId: opts.orgId,
    spec,
    harnessHash: hash,
    ...(opts.tools !== undefined ? { tools: opts.tools } : {}),
    ...(opts.legNotes !== undefined ? { legNotes: opts.legNotes } : {}),
    ...(opts.toolGuidance !== undefined ? { toolGuidance: opts.toolGuidance } : {}),
    ...(opts.maxStepsPerLeg !== undefined ? { maxStepsPerLeg: opts.maxStepsPerLeg } : {}),
    ...(opts.policyRefs !== undefined ? { policyRefs: opts.policyRefs } : {}),
    ...(opts.readSteers !== undefined ? { readSteers: opts.readSteers } : {}),
    ...(opts.markSteersConsumed !== undefined ? { markSteersConsumed: opts.markSteersConsumed } : {}),
  });
  // Span emission after the leg: idempotent, safe to re-send on resume.
  const steps = await listLabSteps(opts.db, runId, opts.orgId);
  const spans = spansForSteps(runId, steps);
  if (spans.length > 0) await opts.client.emitSpans(spans);
  return outcome;
}

/** argv entry: node cli.js <run|resume|answer|kill|show> … */
export async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  const env = (name: string): string => {
    const v = process.env[name];
    if (v === undefined || v === '') throw new Error(`${name} is required`);
    return v;
  };
  const h = await createDb();
  await migrate(h.db);
  const client = new ServingClient({ baseUrl: env('POTION_API'), apiKey: env('POTION_SERVING_KEY') });
  const orgId = env('POTION_ORG_ID');
  try {
    if (cmd === 'run') {
      const specText = readFileSync(rest[0]!, 'utf8');
      const { runId, outcome } = await startRun({ db: h.db, client, orgId, specText });
      console.log(JSON.stringify({ runId, outcome }));
      return 0;
    }
    if (cmd === 'resume') {
      const runId = rest[0]!;
      const specText = readFileSync(rest[rest.indexOf('--spec') + 1]!, 'utf8');
      const answerIdx = rest.indexOf('--answer');
      const outcome = await resumeRun({
        db: h.db, client, orgId, specText, runId,
        ...(answerIdx >= 0 ? { answer: rest[answerIdx + 1]! } : {}),
      });
      console.log(JSON.stringify({ runId, outcome }));
      return 0;
    }
    if (cmd === 'kill') {
      console.log(JSON.stringify({ killed: await killLabRun(h.db, rest[0]!, orgId) }));
      return 0;
    }
    if (cmd === 'show') {
      const run = await getLabRun(h.db, rest[0]!, orgId);
      const steps = await listLabSteps(h.db, rest[0]!, orgId);
      console.log(JSON.stringify({ run, steps: steps.length }));
      return 0;
    }
    console.error('usage: lab-runtime <run|resume|kill|show> …');
    return 2;
  } finally {
    await h.close();
  }
}
