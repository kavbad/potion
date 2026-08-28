// P1 contract law (the mouth) — loop + replay in lockstep. A
// contract-bearing standing check completes ONLY on a parsed deliverable;
// one paid repair round; then a typed failure. Contract-less standing is
// byte-identical to the 2026-08-27 law.
import { describe, expect, it } from 'vitest';
import {
  createDb,
  createLabRun,
  getLabRun,
  listLabSteps,
  migrate,
  type DbHandle,
} from '@potion/db';
import { harnessSpecHash, type HarnessSpec } from '@potion/lab-spec';
import { seedIsolationOrgs, ORG_A } from '@potion/db';
import { runLeg } from './loop.js';
import { replayRun, type RecordedStep } from './replay.js';
import { extractDeliverable } from './deliverable.js';
import type { ServingClient, ServingRequest, ServingResult } from './serving-client.js';

function standingSpec(withContract: boolean): HarnessSpec {
  return {
    specVersion: 1,
    name: 'contract law harness',
    brain: { policy: { type: 'min_cost', qualityFloor: 0 } },
    mission: { kind: 'standing', goal: 'watch the market' },
    superpowers: [],
    memory: { enabled: true },
    rules: [],
    fuel: { maxUsdPerRun: 1, hardStop: true },
    checkIns: [],
    ...(withContract ? { contract: { type: 'brief' as const } } : {}),
  };
}

const GOOD_BRIEF = JSON.stringify({
  headline: [{ claim: 'Northwind cut Pro 20%', sourceUrl: 'https://northwind.example/pricing' }],
  byEntity: [],
  quiet: ['Fabrikam'],
  coverage: { checked: 3 },
});

function scripted(results: ServingResult[]): ServingClient {
  const queue = [...results];
  const client = {
    complete: async (_req: ServingRequest) => {
      const next = queue.shift();
      if (!next) throw new Error('scripted client exhausted');
      return next;
    },
    emitSpans: async () => true,
  };
  return client as unknown as ServingClient;
}

function ok(text: string): ServingResult {
  return {
    kind: 'ok', completionId: 'chatcmpl-contract', text, toolCalls: [], finishReason: 'stop',
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    frontierTrace: 'cluster=x;strategy=t;frontier=v1;policy=min_cost;fallback=0;provenance=mock',
  };
}

async function fresh(s: HarnessSpec): Promise<{ h: DbHandle; hash: string }> {
  const h = await createDb();
  await migrate(h.db);
  await seedIsolationOrgs(h.db);
  const hash = harnessSpecHash(s);
  await createLabRun(h.db, { id: 'run-contract', orgId: ORG_A, harnessHash: hash, harnessName: s.name, spec: s });
  return { h, hash };
}

async function replayOf(h: DbHandle, s: HarnessSpec): Promise<ReturnType<typeof replayRun>> {
  const steps = await listLabSteps(h.db, 'run-contract', ORG_A);
  const run = await getLabRun(h.db, 'run-contract', ORG_A);
  return replayRun(
    s,
    steps.map((st) => ({ seq: st.seq, kind: st.kind, payload: st.payload }) as RecordedStep),
    { state: run!.state, reason: run!.stateReason },
  );
}

describe('the contract law — loop side', () => {
  it('a valid deliverable completes the check, and extractDeliverable finds it', async () => {
    const s = standingSpec(true);
    const { h, hash } = await fresh(s);
    const outcome = await runLeg({
      db: h.db, client: scripted([ok(GOOD_BRIEF)]), runId: 'run-contract', orgId: ORG_A, spec: s, harnessHash: hash,
    });
    expect(outcome.status).toBe('completed');
    const run = await getLabRun(h.db, 'run-contract', ORG_A);
    expect(run!.stateReason).toContain('deliverable filed');
    const steps = await listLabSteps(h.db, 'run-contract', ORG_A);
    const found = extractDeliverable(s, steps.map((st) => ({ seq: st.seq, kind: st.kind, payload: st.payload as never })));
    expect(found?.brief.headline[0]?.claim).toBe('Northwind cut Pro 20%');
    expect((await replayOf(h, s)).ok).toBe(true);
    await h.close();
  });

  it('an invalid reply gets ONE repair round, then a valid one completes', async () => {
    const s = standingSpec(true);
    const { h, hash } = await fresh(s);
    const outcome = await runLeg({
      db: h.db, client: scripted([ok('all quiet today, nothing to report!'), ok(GOOD_BRIEF)]),
      runId: 'run-contract', orgId: ORG_A, spec: s, harnessHash: hash,
    });
    expect(outcome.status).toBe('completed');
    const steps = await listLabSteps(h.db, 'run-contract', ORG_A);
    expect(steps.filter((st) => st.kind === 'model')).toHaveLength(2);
    // The second request must carry the repair message — and replay must
    // re-derive it identically or the record reads as drift.
    const second = steps.filter((st) => st.kind === 'model')[1]!.payload as { requestPayload: { messages: Array<{ role: string; content: string }> } };
    expect(second.requestPayload.messages.some((m) => m.role === 'user' && m.content.startsWith('Contract violation'))).toBe(true);
    expect((await replayOf(h, s)).ok).toBe(true);
    await h.close();
  });

  it('repairs exhausted → failed contract-violation; replay derives the same terminal', async () => {
    const s = standingSpec(true);
    const { h, hash } = await fresh(s);
    const outcome = await runLeg({
      db: h.db, client: scripted([ok('nope'), ok('still prose, sorry')]),
      runId: 'run-contract', orgId: ORG_A, spec: s, harnessHash: hash,
    });
    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') expect(outcome.reason).toBe('contract-violation');
    const run = await getLabRun(h.db, 'run-contract', ORG_A);
    expect(run!.state).toBe('failed');
    expect(run!.stateReason).toContain('contract-violation');
    expect((await replayOf(h, s)).ok).toBe(true);
    await h.close();
  });

  it('contract-less standing is byte-identical to the old law (completes on prose)', async () => {
    const s = standingSpec(false);
    const { h, hash } = await fresh(s);
    const outcome = await runLeg({
      db: h.db, client: scripted([ok('all quiet today')]), runId: 'run-contract', orgId: ORG_A, spec: s, harnessHash: hash,
    });
    expect(outcome.status).toBe('completed');
    const run = await getLabRun(h.db, 'run-contract', ORG_A);
    expect(run!.stateReason).toBe('check complete — a standing mission rests until its next check');
    expect((await replayOf(h, s)).ok).toBe(true);
    await h.close();
  });
});
