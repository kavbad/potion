// Lab Step 8 — lab:run key custody (review outcome 1): the ephemeral
// run-scoped serve key DIES at every exit — completed, failed, killed-budget
// (fuel and org hard-stop), awaiting-human, crash — and the fence/reclaim
// entry sweep reaps any key a zombie invocation left behind, including on a
// run that already reached a terminal state. Scripted serving double: every
// state is drivable at $0 (the real serving contract is proven in the
// walkthrough against buildServer).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  apiKeys,
  createDb,
  createLabRun,
  getLabRun,
  insertApiKey,
  killLabRun,
  migrate,
  seedIsolationOrgs,
  ORG_A,
  ORG_B,
  type DbHandle,
} from '@potion/db';
import { and, eq, like } from 'drizzle-orm';
import { harnessSpecHash, type HarnessSpec } from '@potion/lab-spec';
import { materializeDialPolicy } from '@potion/lab-dial';
import type { ServingClient, ServingRequest, ServingResult } from '@potion/lab-runtime';
import { createLabRunHandler, DEFAULT_PRICES_PATH, type JobContext } from './handlers.js';

const ORG = ORG_A;
const SERVING_URL = 'http://serving.test';

let db: DbHandle;

beforeEach(async () => {
  db = await createDb();
  await migrate(db.db);
  await seedIsolationOrgs(db.db);
  process.env.POTION_SERVING_URL = SERVING_URL;
});

afterEach(async () => {
  delete process.env.POTION_SERVING_URL;
  await db.close();
});

function ctx(): JobContext {
  return { db: db.db, dbHandle: db, pricesPath: DEFAULT_PRICES_PATH };
}

function spec(over: Partial<HarnessSpec> = {}): HarnessSpec {
  return {
    specVersion: 1,
    name: 'custody test harness',
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
    completionId: `chatcmpl-${Math.random().toString(36).slice(2, 10)}`,
    text: 'done.',
    toolCalls: [],
    finishReason: 'stop',
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    frontierTrace: 'cluster=code-gen;strategy=test;frontier=v1;policy=min_cost;fallback=0;provenance=mock',
    ...over,
  };
}

/** Scripted client factory: pops one result per complete(); records the
 * apiKey the handler minted so tests can assert the raw is the one in use. */
function scriptedFactory(results: ServingResult[]): {
  factory: (opts: { baseUrl: string; apiKey: string; clusterHint?: string }) => ServingClient;
  seen: { apiKey?: string; baseUrl?: string; requests: ServingRequest[] };
} {
  const queue = [...results];
  const seen: { apiKey?: string; baseUrl?: string; requests: ServingRequest[] } = { requests: [] };
  const factory = (opts: { baseUrl: string; apiKey: string; clusterHint?: string }): ServingClient => {
    seen.apiKey = opts.apiKey;
    seen.baseUrl = opts.baseUrl;
    return {
      complete: async (req: ServingRequest) => {
        seen.requests.push(req);
        const next = queue.shift();
        if (!next) throw new Error('scripted client exhausted');
        return next;
      },
      emitSpans: async () => true,
    } as unknown as ServingClient;
  };
  return { factory, seen };
}

async function seedRun(runId: string, s: HarnessSpec): Promise<string> {
  const hash = harnessSpecHash(s);
  await createLabRun(db.db, { id: runId, orgId: ORG, harnessHash: hash, harnessName: s.name, spec: s });
  return hash;
}

/** All ephemeral key rows for a run, by the custody naming convention. */
async function keysForRun(runId: string): Promise<Array<{ id: string; revokedAt: Date | null }>> {
  return db.db
    .select({ id: apiKeys.id, revokedAt: apiKeys.revokedAt })
    .from(apiKeys)
    .where(and(eq(apiKeys.orgId, ORG), like(apiKeys.name, `lab-run-${runId}-%`)));
}

async function expectAllKeysDead(runId: string, count: number): Promise<void> {
  const rows = await keysForRun(runId);
  expect(rows).toHaveLength(count);
  for (const row of rows) expect(row.revokedAt).not.toBeNull();
}

describe('lab:run key custody — death at every exit', () => {
  it('completed: one key minted, used by the client, revoked after', async () => {
    await seedRun('run-c1', spec());
    const { factory, seen } = scriptedFactory([ok(), ok({ text: 'Wrap-up: done-definition met.' })]);
    const res = await createLabRunHandler({ clientFactory: factory })({ orgId: ORG, runId: 'run-c1' }, ctx());
    expect(res.state).toBe('completed');
    expect((await getLabRun(db.db, 'run-c1', ORG))!.state).toBe('completed');
    expect(seen.baseUrl).toBe(SERVING_URL);
    expect(seen.apiKey).toMatch(/^pk_labrun_/); // the raw rides only in-process
    await expectAllKeysDead('run-c1', 1);
  });

  it('failed (serving error): key revoked', async () => {
    await seedRun('run-f1', spec());
    const { factory } = scriptedFactory([{ kind: 'error', status: 500, code: 'boom', detail: 'upstream' }]);
    const res = await createLabRunHandler({ clientFactory: factory })({ orgId: ORG, runId: 'run-f1' }, ctx());
    expect(res.state).toBe('failed');
    await expectAllKeysDead('run-f1', 1);
  });

  it('killed-budget (fuel exhausted): key revoked', async () => {
    // est = totalTokens/1000 × $0.01 = $0.00015 per scripted call ≥ the cap.
    await seedRun('run-kb1', spec({ fuel: { maxUsdPerRun: 0.0001, hardStop: true } }));
    const { factory } = scriptedFactory([ok({ text: 'still going', finishReason: 'length' })]);
    const res = await createLabRunHandler({ clientFactory: factory })({ orgId: ORG, runId: 'run-kb1' }, ctx());
    expect(res.state).toBe('killed-budget');
    await expectAllKeysDead('run-kb1', 1);
  });

  it('killed-budget (org hard stop from serving): key revoked', async () => {
    await seedRun('run-kb2', spec());
    const { factory } = scriptedFactory([{ kind: 'budget-exceeded', detail: 'org budget hard stop' }]);
    const res = await createLabRunHandler({ clientFactory: factory })({ orgId: ORG, runId: 'run-kb2' }, ctx());
    expect(res.state).toBe('killed-budget');
    await expectAllKeysDead('run-kb2', 1);
  });

  it('awaiting-human: the key NEVER lives across the wait', async () => {
    // fraction 0.5 × $0.0002 = $0.0001 crossed by the first call's $0.00015,
    // which stays under the $0.0002 kill line → check-in, not kill.
    await seedRun(
      'run-ah1',
      spec({
        fuel: { maxUsdPerRun: 0.0002, hardStop: true },
        checkIns: [{ trigger: 'on-budget-fraction', fraction: 0.5 }],
      }),
    );
    const { factory } = scriptedFactory([ok({ text: 'still going', finishReason: 'length' })]);
    const res = await createLabRunHandler({ clientFactory: factory })({ orgId: ORG, runId: 'run-ah1' }, ctx());
    expect(res.state).toBe('awaiting-human');
    expect((await getLabRun(db.db, 'run-ah1', ORG))!.state).toBe('awaiting-human');
    await expectAllKeysDead('run-ah1', 1);
  });

  it('crash (client throws mid-leg): handler rethrows AND the key is revoked', async () => {
    await seedRun('run-x1', spec());
    const { factory } = scriptedFactory([]); // first complete() throws
    await expect(
      createLabRunHandler({ clientFactory: factory })({ orgId: ORG, runId: 'run-x1' }, ctx()),
    ).rejects.toThrow('scripted client exhausted');
    await expectAllKeysDead('run-x1', 1);
  });

  it('missing POTION_SERVING_URL: fail-closed BEFORE any key is minted', async () => {
    await seedRun('run-env1', spec());
    delete process.env.POTION_SERVING_URL;
    const { factory } = scriptedFactory([ok(), ok({ text: 'Wrap-up: done-definition met.' })]);
    await expect(
      createLabRunHandler({ clientFactory: factory })({ orgId: ORG, runId: 'run-env1' }, ctx()),
    ).rejects.toThrow('POTION_SERVING_URL');
    expect(await keysForRun('run-env1')).toHaveLength(0);
  });
});

describe('lab:run fence/reclaim — the zombie-key sweep', () => {
  /** Plant an unrevoked key AS IF a prior invocation crashed before its
   * finally. policyId must be real — materialize the run's own brain row. */
  async function plantZombie(runId: string, harnessHash: string, s: HarnessSpec, keySuffix: string, orgId = ORG): Promise<string> {
    const row = await materializeDialPolicy(db.db, {
      orgId,
      harnessHash,
      slot: 'brain',
      policy: s.brain.policy,
    });
    const id = `key-labrun-${runId}-${keySuffix}`;
    await insertApiKey(db.db, {
      id,
      keyHash: `hash-${runId}-${keySuffix}`,
      name: `lab-run-${runId}-${keySuffix}`,
      orgId,
      policyId: row.id,
      rateRps: 50,
      dailyCap: 10_000,
    });
    return id;
  }

  it('reclaim sweeps the zombie, scoped to THIS run — a sibling run key survives', async () => {
    const s = spec();
    const hash = await seedRun('run-z1', s);
    await seedRun('run-z2', s);
    await plantZombie('run-z1', hash, s, 'zombie1');
    const siblingId = await plantZombie('run-z2', hash, s, 'alive1');

    const { factory } = scriptedFactory([ok(), ok({ text: 'Wrap-up: done-definition met.' })]);
    const res = await createLabRunHandler({ clientFactory: factory })({ orgId: ORG, runId: 'run-z1' }, ctx());
    expect(res.state).toBe('completed');

    // run-z1: the zombie AND the invocation's own key are both dead.
    await expectAllKeysDead('run-z1', 2);
    // run-z2's key is untouched — the sweep never crosses runs.
    const sibling = await keysForRun('run-z2');
    expect(sibling).toHaveLength(1);
    expect(sibling[0]!.id).toBe(siblingId);
    expect(sibling[0]!.revokedAt).toBeNull();
  });

  it('terminal no-op STILL reaps: a key orphaned between the terminal transition and its finally dies on re-entry, and no new key is minted', async () => {
    const s = spec();
    const hash = await seedRun('run-z3', s);
    await killLabRun(db.db, 'run-z3', ORG); // state: killed-operator (terminal)
    await plantZombie('run-z3', hash, s, 'orphan1');

    const { factory, seen } = scriptedFactory([ok(), ok({ text: 'Wrap-up: done-definition met.' })]);
    const res = await createLabRunHandler({ clientFactory: factory })({ orgId: ORG, runId: 'run-z3' }, ctx());
    expect(res).toEqual({ state: 'killed-operator', noop: true });
    expect(seen.requests).toHaveLength(0); // no serving traffic on a no-op
    await expectAllKeysDead('run-z3', 1); // the orphan died; nothing new minted
  });

  it('the sweep is org-scoped: an identically named key in ANOTHER org is not touched', async () => {
    const s = spec();
    const hash = await seedRun('run-z4', s);
    // Same run-id naming, different org — tenancy boundary must hold.
    const foreignId = await plantZombie('run-z4', hash, s, 'foreign1', ORG_B);

    const { factory } = scriptedFactory([ok(), ok({ text: 'Wrap-up: done-definition met.' })]);
    await createLabRunHandler({ clientFactory: factory })({ orgId: ORG, runId: 'run-z4' }, ctx());

    const foreign = await db.db
      .select({ id: apiKeys.id, revokedAt: apiKeys.revokedAt })
      .from(apiKeys)
      .where(and(eq(apiKeys.orgId, ORG_B), eq(apiKeys.id, foreignId)));
    expect(foreign).toHaveLength(1);
    expect(foreign[0]!.revokedAt).toBeNull();
  });
});

describe('lab:run fence/reclaim — the sweep never kills a LIVE invocation', () => {
  it('a duplicate job arriving while a claim is HELD leaves the live key untouched', async () => {
    const s = spec();
    const hash = await seedRun('run-live1', s);
    // Invocation A holds an unexpired claim (mid-leg) with its key live.
    const { claimLabRun } = await import('@potion/db');
    const claim = await claimLabRun(db.db, {
      runId: 'run-live1', orgId: ORG, expectedHarnessHash: hash, leaseMs: 60_000,
    });
    if (!claim.ok) throw new Error(`claim failed: ${claim.reason}`);
    const liveKeyId = await (async () => {
      const row = await materializeDialPolicy(db.db, { orgId: ORG, harnessHash: hash, slot: 'brain', policy: s.brain.policy });
      const id = 'key-labrun-run-live1-live1';
      await insertApiKey(db.db, {
        id, keyHash: 'hash-live1', name: 'lab-run-run-live1-live1', orgId: ORG,
        policyId: row.id, rateRps: 50, dailyCap: 10_000,
      });
      return id;
    })();

    // The duplicate invocation: must NOT sweep (claim is live); its own
    // resume attempt bounces off the held claim.
    const { factory } = scriptedFactory([ok(), ok({ text: 'Wrap-up: done-definition met.' })]);
    await createLabRunHandler({ clientFactory: factory })({ orgId: ORG, runId: 'run-live1' }, ctx()).catch(() => {
      /* claim-held surfaces however resumeRun surfaces it — custody is the assertion */
    });
    const live = await db.db
      .select({ id: apiKeys.id, revokedAt: apiKeys.revokedAt })
      .from(apiKeys)
      .where(and(eq(apiKeys.orgId, ORG), eq(apiKeys.id, liveKeyId)));
    expect(live).toHaveLength(1);
    expect(live[0]!.revokedAt, 'the LIVE invocation key must survive a duplicate job').toBeNull();
  });
});

describe('X1 — the code superpower against a REAL sandbox (integration)', () => {
  it('a granted code worker executes python; produced files persist in the run workspace', async () => {
    const { spawn, execSync } = await import('node:child_process');
    let python = '';
    try { python = execSync('command -v python3').toString().trim(); } catch { /* absent */ }
    if (python === '') return; // no python on this machine — the unit layer covers the tool
    const { fileURLToPath } = await import('node:url');
    const serverPath = fileURLToPath(new URL('../../../deploy/sandbox/sandbox_server.py', import.meta.url));
    const port = 18790 + Math.floor(Math.random() * 200);
    const proc = spawn(python, [serverPath], { env: { ...process.env, SANDBOX_PORT: String(port) }, stdio: 'ignore' });
    try {
      // wait for the sandbox to listen
      let up = false;
      for (let i = 0; i < 40 && !up; i++) {
        await new Promise((r) => setTimeout(r, 150));
        up = await fetch(`http://127.0.0.1:${port}/healthz`).then((r) => r.ok).catch(() => false);
      }
      expect(up, 'sandbox failed to start').toBe(true);

      const s = spec({
        name: 'analyst harness',
        superpowers: [{ id: 'code', scopes: ['exec:python'] }],
        checkIns: [],
      });
      const runId = 'run-code-x1';
      await seedRun(runId, s);
      // The grant: enabling a builtin is a permission grant, nothing more.
      const { upsertLabGrant } = await import('@potion/db');
      await upsertLabGrant(db.db, {
        id: 'grant-code-x1', orgId: ORG, connectorId: 'code', superpowerId: 'code',
        scopesGranted: ['exec:python'], tokenEnvelope: 'builtin:no-credential', grantedBy: 'test',
      });
      // Script: one tool call producing a file, then a clean stop.
      const toolCall = {
        id: 'call-1',
        type: 'function' as const,
        function: {
          name: 'run_python',
          arguments: JSON.stringify({ code: "with open('answer.csv','w') as f: f.write('day,revenue\\nSat,1778\\n')\nprint('computed')" }),
        },
      };
      const { factory } = scriptedFactory([
        ok({ text: 'computing', toolCalls: [toolCall], finishReason: 'tool_calls' }),
        ok({ text: 'the thing is done' }),
        // the tool-bearing task's deliberate tool-free WRAP-UP call
        ok({ text: 'the thing is done' }),
      ]);
      const res = await createLabRunHandler({
        clientFactory: factory,
        codeToolDeps: { sandboxUrl: `http://127.0.0.1:${port}` },
      })({ orgId: ORG, runId }, ctx());
      expect(res.state).toBe('completed');

      const { listLabRunFiles, getLabRunFile } = await import('@potion/db');
      const files = await listLabRunFiles(db.db, ORG, runId);
      expect(files.map((f) => f.name)).toEqual(['answer.csv']);
      const file = await getLabRunFile(db.db, ORG, runId, 'answer.csv');
      expect(file!.content.toString()).toContain('Sat,1778');
      expect(file!.meta.mime).toBe('text/csv');
    } finally {
      proc.kill();
    }
  }, 60_000);

  it('an unconfigured sandbox degrades to a typed leg note, never a crash', async () => {
    delete process.env.POTION_SANDBOX_URL;
    const s = spec({ name: 'no sandbox harness', superpowers: [{ id: 'code', scopes: ['exec:python'] }] });
    const runId = 'run-code-nosb';
    await seedRun(runId, s);
    const { upsertLabGrant, listLabSteps } = await import('@potion/db');
    await upsertLabGrant(db.db, {
      id: 'grant-code-nosb', orgId: ORG, connectorId: 'code', superpowerId: 'code',
      scopesGranted: ['exec:python'], tokenEnvelope: 'builtin:no-credential', grantedBy: 'test',
    });
    const { factory } = scriptedFactory([ok({ text: 'the thing is done' }), ok({ text: 'Wrap-up: done-definition met.' })]);
    const res = await createLabRunHandler({ clientFactory: factory })({ orgId: ORG, runId }, ctx());
    expect(res.state).toBe('completed');
    const steps = await listLabSteps(db.db, runId, ORG);
    const note = steps.find((st) => JSON.stringify(st.payload).includes('superpowerUnavailable'));
    expect(note, 'expected the typed sandbox-unconfigured leg note').toBeDefined();
    expect(JSON.stringify(note!.payload)).toContain('POTION_SANDBOX_URL');
  });
});

describe('X3 — the judge and the notifications', () => {
  beforeEach(async () => {
    const { createUser, createMembership } = await import('@potion/db');
    await createUser(db.db, { id: 'usr-x3-admin', email: 'x3-admin@org.dev', name: 'x3' });
    await createMembership(db.db, { orgId: ORG, userId: 'usr-x3-admin', role: 'admin' });
  });

  const BRIEF = JSON.stringify({
    headline: [{ claim: 'Northwind cut Pro 20%', sourceUrl: 'https://example.com/pricing' }],
    byEntity: [{ entity: 'Northwind', items: [{ note: 'Pro $49 to $39', sourceUrl: 'https://example.com/pricing' }] }],
    quiet: ['Fabrikam'],
    coverage: { checked: 2 },
  });
  const JUDGMENT = JSON.stringify({
    overall: 8,
    criteria: [{ name: 'sourced', score: 9, note: 'every claim carries a URL' }],
    rationale: 'tight and sourced',
  });

  function standingContractSpec(): HarnessSpec {
    return spec({
      name: 'judged harness',
      mission: { kind: 'standing', goal: 'watch the market' },
      rules: ['Done well means: sourced, no filler'],
      contract: { type: 'brief' },
      exemplar: 'ACT NOW · Northwind cut Pro 20% (pricing page)',
    });
  }

  it('a completed contract check is judged (stored, advisory) and admins are notified', async () => {
    const runId = 'run-judged';
    await seedRun(runId, standingContractSpec());
    const { factory } = scriptedFactory([
      ok({ text: BRIEF }),      // the check's deliverable
      ok({ text: JUDGMENT }),   // the judge's verdict
    ]);
    const sent: Array<{ to: string; subject: string }> = [];
    const res = await createLabRunHandler({
      clientFactory: factory,
      sendNotify: async (m) => { sent.push({ to: m.to, subject: m.subject }); },
    })({ orgId: ORG, runId }, ctx());
    expect(res.state).toBe('completed');

    const run = await getLabRun(db.db, runId, ORG);
    const judge = run!.judge as { overall: number; criteria: Array<{ score: number }>; rationale: string; calibrated: boolean };
    expect(judge.overall).toBe(8);
    expect(judge.criteria[0]!.score).toBe(9);
    expect(judge.calibrated).toBe(false);

    expect(sent.length).toBeGreaterThanOrEqual(1);
    expect(sent[0]!.subject).toContain('filed its check');
  });

  it('an unparseable judgment is a TYPED miss, and the run still completes', async () => {
    const runId = 'run-judge-miss';
    await seedRun(runId, standingContractSpec());
    const { factory } = scriptedFactory([
      ok({ text: BRIEF }),
      ok({ text: 'I think it is pretty good!' }), // not JSON — a miss
    ]);
    const res = await createLabRunHandler({ clientFactory: factory, sendNotify: async () => {} })({ orgId: ORG, runId }, ctx());
    expect(res.state).toBe('completed');
    const run = await getLabRun(db.db, runId, ORG);
    expect((run!.judge as { error: string }).error).toContain('unparseable');
  });

  it('a failed run notifies with the reason', async () => {
    const runId = 'run-notify-fail';
    // standing, no contract: two identical no-tool responses on 'length' → stalled
    const s = spec({ name: 'stall harness', mission: { kind: 'standing', goal: 'loop forever' } });
    await seedRun(runId, s);
    const { factory } = scriptedFactory([
      ok({ text: 'same thing', finishReason: 'length' }),
      ok({ text: 'same thing', finishReason: 'length' }),
    ]);
    const sent: Array<{ subject: string }> = [];
    const res = await createLabRunHandler({
      clientFactory: factory,
      sendNotify: async (m) => { sent.push({ subject: m.subject }); },
    })({ orgId: ORG, runId }, ctx());
    expect(res.state).toBe('failed');
    expect(sent[0]!.subject).toContain('needs attention');
  });
});
