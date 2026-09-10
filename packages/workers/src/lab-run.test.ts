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
import type { ServingClientLike } from '@potion/lab-runtime';
import type { ServingRequest, ServingResult, StepPayload } from '@potion/lab-runtime';

/** lab_run_steps.payload is a jsonb column, so drizzle types it `unknown`.
 *  A recorded step payload always carries the step kind — which is exactly
 *  what replayRun dispatches on — so that is the narrowing, done for real
 *  rather than asserted. */
function isStepPayload(p: unknown): p is StepPayload {
  return typeof p === 'object' && p !== null && 'kind' in p;
}

function recordedPayload(p: unknown): StepPayload {
  if (!isStepPayload(p)) throw new Error(`lab step payload is not a recorded step: ${typeof p}`);
  return p;
}
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
 * apiKey the handler minted so tests can assert the raw is the one in use.
 *
 * A plain object: the handler's clientFactory takes ServingClientLike, so a
 * double no longer has to be a subclass of a class it will never use the
 * private state of. Nothing can dial out, because there is no client. */
function scriptedFactory(results: ServingResult[]): {
  factory: (opts: { baseUrl: string; apiKey: string; clusterHint?: string }) => ServingClientLike;
  seen: { apiKey?: string; baseUrl?: string; requests: ServingRequest[] };
} {
  const queue = [...results];
  const seen: { apiKey?: string; baseUrl?: string; requests: ServingRequest[] } = { requests: [] };
  const factory = (opts: { baseUrl: string; apiKey: string; clusterHint?: string }): ServingClientLike => {
    seen.apiKey = opts.apiKey;
    seen.baseUrl = opts.baseUrl;
    return {
      complete: async (req: ServingRequest): Promise<ServingResult> => {
        seen.requests.push(req);
        const next = queue.shift();
        if (!next) throw new Error('scripted client exhausted');
        return next;
      },
      emitSpans: async (): Promise<boolean> => true,
    };
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
    // HONEST START (2026-08-31): a code worker with no sandbox does not
    // fake-complete — it fails fast with the actual remediation, and burns
    // no model call doing it.
    expect(res.state).toBe('failed');
    const steps = await listLabSteps(db.db, runId, ORG);
    const note = steps.find((st) => JSON.stringify(st.payload).includes('superpowerUnavailable'));
    expect(note, 'expected the typed sandbox-unconfigured leg note').toBeDefined();
    expect(JSON.stringify(note!.payload)).toContain('POTION_SANDBOX_URL');
    const run = await getLabRun(db.db, runId, ORG);
    expect(run!.stateReason).toContain('POTION_SANDBOX_URL');
    expect(steps.every((st) => st.kind !== 'model')).toBe(true);
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
      ok({ text: 'still not JSON, sorry' }), // the ONE bounded retry also misses
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

describe('BYO-MCP — a registered endpoint is a real superpower (integration)', () => {
  const MASTER_BYO = Buffer.from('a'.repeat(64), 'hex');
  const provider = { getMasterKey: async () => MASTER_BYO, describe: () => 'test-fixed' };

  async function seedByo(mcpUrl: string, bearer: string | null) {
    const { upsertLabCustomConnector, upsertLabGrant } = await import('@potion/db');
    const { sealEnvelope } = await import('@potion/custody');
    await upsertLabCustomConnector(db.db, {
      orgId: ORG, connectorId: 'our-crm', displayName: 'Our CRM', endpointUrl: mcpUrl,
      serverName: 'mock-mcp',
      tools: [{ name: 'crm_update', description: 'Update a customer record.', inputSchema: { type: 'object' } }],
      createdBy: 'test',
    });
    await upsertLabGrant(db.db, {
      id: 'grant-byo-run', orgId: ORG, connectorId: 'our-crm', superpowerId: 'our-crm',
      scopesGranted: ['mcp:pinned'],
      // The register route ALWAYS seals a real envelope ('' = no credential).
      tokenEnvelope: sealEnvelope(MASTER_BYO, bearer ?? ''), grantedBy: 'test',
    });
  }

  it('the pinned tool loads through the sealed bearer and fires the pore (act, fail-closed)', async () => {
    const { MockMcpServer } = await import('@potion/lab-mcp/mock-server');
    const mock = await MockMcpServer.start({
      tools: [{ name: 'crm_update', description: 'server text (never forwarded)', handler: () => 'updated' }],
      requireBearer: 'byo-bearer-1234567890',
    });
    try {
      await seedByo(mock.mcpUrl, 'byo-bearer-1234567890');
      const s = spec({
        name: 'byo harness',
        superpowers: [{ id: 'our-crm', scopes: [] }],
        checkIns: [{ trigger: 'before-external-action' }],
      });
      const runId = 'run-byo-pore';
      await seedRun(runId, s);
      const toolCall = {
        id: 'call-byo', type: 'function' as const,
        function: { name: 'our-crm.crm_update', arguments: JSON.stringify({ email: 'x@y.dev' }) },
      };
      const { factory } = scriptedFactory([ok({ text: 'updating', toolCalls: [toolCall], finishReason: 'tool_calls' })]);
      const res = await createLabRunHandler({ clientFactory: factory, masterKeyProvider: provider })(
        { orgId: ORG, runId }, ctx(),
      );
      // The act gates at the pore — the FIRST external call of a BYO tool
      // asks a human, exactly like a catalog connector's act.
      expect(res.state).toBe('awaiting-human');
      const { listLabSteps } = await import('@potion/db');
      const steps = await listLabSteps(db.db, runId, ORG);
      const pore = steps.find((st) => JSON.stringify(st.payload).includes('before-external-action'));
      expect(pore, 'expected the before-external-action check-in').toBeDefined();
      expect(JSON.stringify(pore!.payload)).toContain('our-crm.crm_update');
    } finally {
      await mock.close();
    }
  }, 30_000);

  it('a tokenless registration (sealed empty bearer) opens with NO auth header and the tool runs', async () => {
    const { MockMcpServer } = await import('@potion/lab-mcp/mock-server');
    const mock = await MockMcpServer.start({
      tools: [{ name: 'crm_update', description: 'server text', handler: () => ({ updated: true }) }],
    });
    try {
      await seedByo(mock.mcpUrl, null);
      const s = spec({ name: 'byo open harness', superpowers: [{ id: 'our-crm', scopes: [] }], checkIns: [] });
      const runId = 'run-byo-open';
      await seedRun(runId, s);
      // W1: externals always gate — this test is about the WIRE (no auth
      // header), so the class carries an earned grant and the call flows.
      {
        const { ensureActionGrant, acceptGraduation } = await import('@potion/db');
        const { harnessSpecHash } = await import('@potion/lab-spec');
        const g = await ensureActionGrant(db.db, { orgId: ORG, harnessHash: harnessSpecHash(s), actionClass: 'our-crm.crm_update', riskTier: 'reversible-act' });
        await acceptGraduation(db.db, g.id, {});
      }
      const toolCall = {
        id: 'call-byo2', type: 'function' as const,
        function: { name: 'our-crm.crm_update', arguments: '{}' },
      };
      const { factory } = scriptedFactory([
        ok({ text: 'updating', toolCalls: [toolCall], finishReason: 'tool_calls' }),
        ok({ text: 'the thing is done' }),
        ok({ text: 'Wrap-up: done-definition met.' }),
      ]);
      const res = await createLabRunHandler({ clientFactory: factory, masterKeyProvider: provider })(
        { orgId: ORG, runId }, ctx(),
      );
      expect(res.state).toBe('completed');
      // '' means no credential — the wire must carry NO Authorization header,
      // never 'Bearer ' (the empty-token seam this feature fixed).
      expect(mock.requests.length).toBeGreaterThan(0);
      expect(mock.requests.every((r) => r.authorization === null)).toBe(true);
      const { listLabSteps } = await import('@potion/db');
      const steps = await listLabSteps(db.db, runId, ORG);
      const toolStep = steps.find((st) => JSON.stringify(st.payload).includes('"toolName":"our-crm.crm_update"'));
      expect(toolStep, 'expected the executed tool step').toBeDefined();
    } finally {
      await mock.close();
    }
  }, 30_000);
});

describe('P5 — the watchdog: quiet checks never email, fired ones do', () => {
  beforeEach(async () => {
    const { createUser, createMembership } = await import('@potion/db');
    await createUser(db.db, { id: 'usr-p5-admin', email: 'p5-admin@org.dev', name: 'p5' });
    await createMembership(db.db, { orgId: ORG, userId: 'usr-p5-admin', role: 'admin' });
  });

  const QUIET_BRIEF = JSON.stringify({
    headline: [],
    byEntity: [],
    quiet: ['pricing page', 'changelog'],
    coverage: { checked: 2, note: 'both stable since yesterday' },
  });
  const FIRED_BRIEF = JSON.stringify({
    headline: [{ claim: 'Pro plan price changed $49 → $59', sourceUrl: 'https://example.com/pricing' }],
    byEntity: [],
    quiet: [],
    coverage: { checked: 2 },
  });
  const JUDGMENT = JSON.stringify({ overall: 9, criteria: [{ name: 'precision', score: 9, note: 'evidence carried' }], rationale: 'clean' });

  function watchdogSpec(): HarnessSpec {
    return spec({
      name: 'watchdog harness',
      mission: { kind: 'standing', goal: 'watch the pricing page', shape: 'watchdog' } as HarnessSpec['mission'],
      contract: { type: 'brief' },
    });
  }

  it('a QUIET check completes, is judged, and sends NOTHING', async () => {
    const runId = 'run-wd-quiet';
    await seedRun(runId, watchdogSpec());
    const { factory } = scriptedFactory([ok({ text: QUIET_BRIEF }), ok({ text: JUDGMENT })]);
    const sent: string[] = [];
    const res = await createLabRunHandler({
      clientFactory: factory,
      sendNotify: async (m) => { sent.push(m.subject); },
    })({ orgId: ORG, runId }, ctx());
    expect(res.state).toBe('completed');
    expect(sent).toHaveLength(0); // silence is the watchdog's normal deliverable
    const run = await getLabRun(db.db, runId, ORG);
    expect((run!.judge as { overall: number }).overall).toBe(9); // still judged
  });

  it('a FIRED check notifies like any completion', async () => {
    const runId = 'run-wd-fired';
    await seedRun(runId, watchdogSpec());
    const { factory } = scriptedFactory([ok({ text: FIRED_BRIEF }), ok({ text: JUDGMENT })]);
    const sent: string[] = [];
    const res = await createLabRunHandler({
      clientFactory: factory,
      sendNotify: async (m) => { sent.push(m.subject); },
    })({ orgId: ORG, runId }, ctx());
    expect(res.state).toBe('completed');
    expect(sent.length).toBeGreaterThanOrEqual(1);
  });

  it('a watchdog that FAILS still notifies — silence-by-crash is not quiet', async () => {
    const runId = 'run-wd-fail';
    const s = spec({ name: 'wd stall', mission: { kind: 'standing', goal: 'watch', shape: 'watchdog' } as HarnessSpec['mission'] });
    await seedRun(runId, s);
    const { factory } = scriptedFactory([ok({ text: 'same', finishReason: 'length' }), ok({ text: 'same', finishReason: 'length' })]);
    const sent: string[] = [];
    const res = await createLabRunHandler({
      clientFactory: factory,
      sendNotify: async (m) => { sent.push(m.subject); },
    })({ orgId: ORG, runId }, ctx());
    expect(res.state).toBe('failed');
    expect(sent.length).toBeGreaterThanOrEqual(1);
  });
});

describe('X4 — fan-out: one fuel tree, one trace (integration)', () => {
  it('the parent delegates two helpers; each is a full recorded run under its slice; the parent record replays clean', async () => {
    const s = spec({
      name: 'fanout harness',
      mission: { kind: 'task', goal: 'research two angles and synthesize', doneDefinition: 'the synthesis is filed' },
      fuel: { maxUsdPerRun: 1, hardStop: true },
      fanOut: { maxWorkers: 3 },
    } as Partial<HarnessSpec>);
    const runId = 'run-fanout';
    await seedRun(runId, s);
    const delegateCall = {
      id: 'call-fan', type: 'function' as const,
      function: {
        name: 'delegate',
        arguments: JSON.stringify({ tasks: [
          { goal: 'read angle one', doneDefinition: 'angle one summarized' },
          { goal: 'read angle two', doneDefinition: 'angle two summarized' },
        ] }),
      },
    };
    // ONE shared scripted queue; helpers run SEQUENTIALLY so the order is
    // deterministic: parent delegate → sub1 (answer + wrap-up) → sub2
    // (answer + wrap-up) → parent synthesis → parent wrap-up.
    const { factory } = scriptedFactory([
      ok({ text: '', finishReason: 'tool_calls', toolCalls: [delegateCall] }),
      ok({ text: 'angle one: the finding.' }),
      ok({ text: 'Wrap-up: angle one summarized.' }),
      ok({ text: 'angle two: the finding.' }),
      ok({ text: 'Wrap-up: angle two summarized.' }),
      ok({ text: 'the synthesis is filed: both angles combined.' }),
      ok({ text: 'Wrap-up: synthesis filed.' }),
    ]);
    const res = await createLabRunHandler({ clientFactory: factory })({ orgId: ORG, runId }, ctx());
    expect(res.state).toBe('completed');

    // ONE TRACE: two helper rows, linked, each a full completed run.
    const { listLabRunChildren, listLabSteps } = await import('@potion/db');
    const children = await listLabRunChildren(db.db, ORG, runId);
    expect(children).toHaveLength(2);
    expect(children.map((c) => c.state)).toEqual(['completed', 'completed']);
    const subSpec = children[0]!.spec as HarnessSpec;
    expect(subSpec.fanOut).toBeUndefined(); // depth 1
    expect(subSpec.checkIns).toEqual([]); // helpers cannot park
    const subSteps = await listLabSteps(db.db, children[0]!.id, ORG);
    expect(subSteps.length).toBeGreaterThan(0); // its own recorded trace

    // The parent recorded ONE delegate step carrying both verdicts.
    const parentSteps = await listLabSteps(db.db, runId, ORG);
    const fanStep = parentSteps.find((st) => (st.payload as { toolName?: string }).toolName === 'delegate');
    const helpers = (fanStep!.payload as { toolOutput: { helpers: Array<{ runId: string; state: string; result: string; estUsd: number }> } }).toolOutput.helpers;
    expect(helpers).toHaveLength(2);
    expect(helpers[0]!.result).toContain('angle one');
    expect(helpers.every((x) => typeof x.estUsd === 'number')).toBe(true);

    // ONE FUEL TREE: the family total is bounded by the parent cap.
    let family = parentSteps.reduce((a, x) => a + (((x.payload as { estCostUsd?: number }).estCostUsd) ?? 0), 0);
    for (const c of children) {
      const stepsC = await listLabSteps(db.db, c.id, ORG);
      family += stepsC.reduce((a, x) => a + (((x.payload as { estCostUsd?: number }).estCostUsd) ?? 0), 0);
    }
    expect(family).toBeLessThanOrEqual(1);

    // THE MIRROR: the parent record (with its delegate step) replays clean.
    const { replayRun } = await import('@potion/lab-runtime');
    const verdict = replayRun(
      s,
      parentSteps.map((x) => ({ seq: x.seq, kind: x.kind, payload: recordedPayload(x.payload) })),
      { state: 'completed', reason: null },
    );
    expect(verdict.ok).toBe(true);
  }, 60_000);

  it('a starved budget refuses the fan-out with a reason — no helpers spawned', async () => {
    const s = spec({
      name: 'starved fanout harness',
      mission: { kind: 'task', goal: 'try to delegate', doneDefinition: 'done' },
      fuel: { maxUsdPerRun: 0.05, hardStop: true },
      fanOut: { maxWorkers: 5 },
    } as Partial<HarnessSpec>);
    const runId = 'run-fanout-starved';
    await seedRun(runId, s);
    const call = {
      id: 'call-starve', type: 'function' as const,
      function: { name: 'delegate', arguments: JSON.stringify({ tasks: Array.from({ length: 5 }, (_, i) => ({ goal: `t${i}`, doneDefinition: 'd' })) }) },
    };
    const { factory } = scriptedFactory([
      ok({ text: '', finishReason: 'tool_calls', toolCalls: [call] }),
      ok({ text: 'done without helpers.' }),
      ok({ text: 'Wrap-up: done.' }),
    ]);
    const res = await createLabRunHandler({ clientFactory: factory })({ orgId: ORG, runId }, ctx());
    expect(res.state).toBe('completed');
    const { listLabRunChildren, listLabSteps } = await import('@potion/db');
    expect(await listLabRunChildren(db.db, ORG, runId)).toHaveLength(0);
    const steps = await listLabSteps(db.db, runId, ORG);
    const fanStep = steps.find((st) => (st.payload as { toolName?: string }).toolName === 'delegate');
    expect(JSON.stringify((fanStep!.payload as { toolOutput: unknown }).toolOutput)).toContain('not enough budget');
  });
});

describe('X6 — the browser hand: reads free, every act at the pore', () => {
  function scriptedBrowser(): typeof fetch {
    let sessions = 0;
    return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const path = String(input).replace(/^https?:\/\/[^/]+/, '');
      if (path === '/session' && init?.method === 'POST') {
        sessions += 1;
        return new Response(JSON.stringify({ sessionId: `bs-${sessions}` }), { status: 200 });
      }
      if (path.endsWith('/goto')) {
        return new Response(JSON.stringify({ url: 'https://app.example/board', title: 'Board', text: 'Sprint 12 · 4 cards', interactables: [{ ref: 'p1', tag: 'button', label: 'Add card' }] }), { status: 200 });
      }
      if (path.endsWith('/act')) {
        return new Response(JSON.stringify({ url: 'https://app.example/board', title: 'Board', text: 'Sprint 12 · 5 cards — card added', interactables: [] }), { status: 200 });
      }
      if (path.endsWith('/state')) {
        return new Response(JSON.stringify({ url: 'https://app.example/board', title: 'Board', text: 'Sprint 12 · 4 cards', interactables: [{ ref: 'p1', tag: 'button', label: 'Add card' }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;
  }

  async function grantBrowser() {
    const { upsertLabGrant } = await import('@potion/db');
    await upsertLabGrant(db.db, {
      id: 'grant-browser-x6', orgId: ORG, connectorId: 'browser', superpowerId: 'browser',
      scopesGranted: ['browse'], tokenEnvelope: 'builtin:no-credential', grantedBy: 'test',
    });
  }

  it('browser_open runs freely (a read); browser_act fires the pore; the approval executes exactly that act', async () => {
    await grantBrowser();
    const s = spec({
      name: 'browser harness',
      mission: { kind: 'task', goal: 'add a card to the board', doneDefinition: 'card added' },
      superpowers: [{ id: 'browser', scopes: ['browse'] }],
      checkIns: [{ trigger: 'before-external-action' }],
    });
    const runId = 'run-browser-pore';
    await seedRun(runId, s);
    const openCall = { id: 'b1', type: 'function' as const, function: { name: 'browser_open', arguments: JSON.stringify({ url: 'https://app.example/board' }) } };
    const actCall = { id: 'b2', type: 'function' as const, function: { name: 'browser_act', arguments: JSON.stringify({ ref: 'p1', kind: 'click' }) } };
    const { factory } = scriptedFactory([
      ok({ text: '', finishReason: 'tool_calls', toolCalls: [openCall] }),
      ok({ text: '', finishReason: 'tool_calls', toolCalls: [actCall] }),
    ]);
    const handler = createLabRunHandler({ clientFactory: factory, browserToolDeps: { browserUrl: 'http://browser.test', fetchImpl: scriptedBrowser() } });
    const res = await handler({ orgId: ORG, runId }, ctx());
    // The READ executed without a question; the ACT parked the run.
    expect(res.state).toBe('awaiting-human');
    const { listLabSteps, answerLabRun } = await import('@potion/db');
    let steps = await listLabSteps(db.db, runId, ORG);
    expect(steps.some((st) => (st.payload as { toolName?: string }).toolName === 'browser_open')).toBe(true);
    const pore = steps.find((st) => st.kind === 'check-in' && JSON.stringify(st.payload).includes('browser_act'));
    expect(pore, 'the pore must fire on the browser act').toBeDefined();

    // Approve → the resumed leg replays EXACTLY the approved click, then completes.
    await answerLabRun(db.db, runId, ORG, 'yes');
    const { factory: f2 } = scriptedFactory([
      ok({ text: 'card added' }),
      ok({ text: 'Wrap-up: card added.' }),
    ]);
    const res2 = await createLabRunHandler({ clientFactory: f2, browserToolDeps: { browserUrl: 'http://browser.test', fetchImpl: scriptedBrowser() } })({ orgId: ORG, runId }, ctx());
    expect(res2.state).toBe('completed');
    steps = await listLabSteps(db.db, runId, ORG);
    const actStep = steps.find((st) => (st.payload as { toolName?: string }).toolName === 'browser_act');
    expect(actStep, 'the approved act executed and recorded').toBeDefined();
    expect(JSON.stringify((actStep!.payload as { toolOutput: unknown }).toolOutput)).toContain('card added');

    // W1 — EVENT-DRIVEN TIGHTENING: the terminal IS the trigger. The
    // graduation pass ran at completion, so the grant row for the observed
    // class exists WITHOUT anyone opening the permission page.
    const { listActionGrants } = await import('@potion/db');
    const { harnessSpecHash } = await import('@potion/lab-spec');
    const grants = await listActionGrants(db.db, ORG, harnessSpecHash(s));
    const actGrant = grants.find((g) => g.actionClass === 'browser_act');
    expect(actGrant, 'the terminal pass must ensure the observed grant row').toBeDefined();
    expect(actGrant!.state).toBe('supervised');
  }, 60_000);

  it('an unconfigured browser service degrades to a typed leg note, never a crash', async () => {
    await grantBrowser();
    delete process.env.POTION_BROWSER_URL;
    const s = spec({ name: 'no browser harness', superpowers: [{ id: 'browser', scopes: ['browse'] }] });
    const runId = 'run-browser-unconf';
    await seedRun(runId, s);
    const { factory } = scriptedFactory([ok({ text: 'the thing is done' }), ok({ text: 'Wrap-up: done.' })]);
    const res = await createLabRunHandler({ clientFactory: factory })({ orgId: ORG, runId }, ctx());
    // HONEST START: a browser worker with no service fails fast, not hollow.
    expect(res.state).toBe('failed');
    const { listLabSteps } = await import('@potion/db');
    const steps = await listLabSteps(db.db, runId, ORG);
    const note = steps.find((st) => JSON.stringify(st.payload).includes('POTION_BROWSER_URL'));
    expect(note, 'expected the typed browser-unconfigured leg note').toBeDefined();
  });
});

describe('X7 — the sealed shell + workspace trees (REAL sandbox integration)', () => {
  it('run_shell executes with the tree mounted, git works offline, produced tree files persist', async () => {
    const { spawn, execSync } = await import('node:child_process');
    let python = '';
    try { python = execSync('command -v python3').toString().trim(); } catch { /* absent */ }
    if (python === '') return;
    let git = '';
    try { git = execSync('command -v git').toString().trim(); } catch { /* absent */ }
    if (git === '') return;
    const { fileURLToPath } = await import('node:url');
    const serverPath = fileURLToPath(new URL('../../../deploy/sandbox/sandbox_server.py', import.meta.url));
    const port = 19000 + Math.floor(Math.random() * 200);
    // stderr CAPTURED, not discarded: a sandbox integration test that cannot say
    // WHY the sandbox failed can only be debugged by hypothesis, and this one
    // cost two wrong ones (2026-09-04). Both the server's stderr and the
    // shell's own output are surfaced in the assertion below.
    const proc = spawn(python, [serverPath], { env: { ...process.env, SANDBOX_PORT: String(port) }, stdio: ['ignore', 'ignore', 'pipe'] });
    let sandboxErr = '';
    proc.stderr?.on('data', (d: Buffer) => { sandboxErr += d.toString(); });
    try {
      let up = false;
      for (let i = 0; i < 40 && !up; i++) {
        await new Promise((r) => setTimeout(r, 150));
        up = await fetch(`http://127.0.0.1:${port}/healthz`).then((r) => r.ok).catch(() => false);
      }
      expect(up, `sandbox failed to start. stderr:\n${sandboxErr}`).toBe(true);

      const s = spec({
        name: 'dev hands harness',
        superpowers: [{ id: 'code', scopes: ['exec:python', 'exec:shell'] }],
        checkIns: [],
      });
      const runId = 'run-shell-x7';
      await seedRun(runId, s);
      const { upsertLabGrant, upsertLabRunFile, listLabRunFiles } = await import('@potion/db');
      await upsertLabGrant(db.db, {
        id: 'grant-code-x7', orgId: ORG, connectorId: 'code', superpowerId: 'code',
        scopesGranted: ['exec:python', 'exec:shell'], tokenEnvelope: 'builtin:no-credential', grantedBy: 'test',
      });
      // Pre-seed a TREE in the workspace — v2's whole point.
      await upsertLabRunFile(db.db, { orgId: ORG, runId, name: 'repo/src/lib.js', content: Buffer.from('module.exports = 41\n') });
      const toolCall = {
        id: 'sh1', type: 'function' as const,
        function: {
          name: 'run_shell',
          arguments: JSON.stringify({
            command: [
              'set -e',
              'test -f repo/src/lib.js',
              'mkdir -p out/report',
              // The identity is passed PER INVOCATION (`git -c`), never assumed
              // from the host. Without it git falls back to user@hostname, and
              // on a CI runner that resolves to `runner@fv-az…​.(none)`, which
              // git REFUSES: "unable to auto-detect email address". Under
              // `set -e` that aborts the script before the echo below, so the
              // produced file never exists and the assertion reads as "the
              // sandbox lost my output" when the shell simply stopped early.
              // This test is about git working OFFLINE, not about whether the
              // machine running it has a name configured.
              'git init -q workrepo && cd workrepo && ' +
                'git -c user.email=lab@potion.invalid -c user.name=potion ' +
                'commit -q --allow-empty -m offline && cd ..',
              'echo "tree ok, git ok" > out/report/result.txt',
            ].join('\n'),
          }),
        },
      };
      const { factory } = scriptedFactory([
        ok({ text: '', finishReason: 'tool_calls', toolCalls: [toolCall] }),
        ok({ text: 'the thing is done' }),
        ok({ text: 'Wrap-up: shell verified.' }),
      ]);
      const res = await createLabRunHandler({
        clientFactory: factory,
        codeToolDeps: { sandboxUrl: `http://127.0.0.1:${port}` },
      })({ orgId: ORG, runId }, ctx());
      expect(res.state).toBe('completed');

      const files = await listLabRunFiles(db.db, ORG, runId);
      const names = files.map((f) => f.name);
      // What the shell ITSELF reported — exit code, stdout, stderr — so a
      // failure names its cause instead of only its symptom.
      const { listLabSteps: _steps } = await import('@potion/db');
      const allSteps = await _steps(db.db, runId, ORG);
      // The TOOL steps carry the result (exit code, stdout, stderr). The model
      // step also mentions run_shell — it holds the CALL — so selecting by
      // substring picks the wrong one, as it did on 33930537416.
      const toolSteps = allSteps.filter((st) => st.kind === 'tool');
      const shellSays =
        `\n--- files that landed: ${JSON.stringify(names)}` +
        `\n--- ${toolSteps.length} tool step(s):\n` +
        toolSteps.map((st) => JSON.stringify(st.payload, null, 2).slice(0, 3000)).join('\n---\n') +
        `\n--- step kinds in order: ${JSON.stringify(allSteps.map((st) => st.kind))}` +
        `\n--- sandbox stderr:\n${sandboxErr.slice(0, 3000) || '(empty)'}`;
      // Assert the shell RAN before asserting what it produced: `repo/src/lib.js`
      // is pre-seeded above, so its presence proves nothing about run_shell, and
      // "expected [...] to include 'out/report/result.txt'" names a symptom three
      // layers from the cause. Zero tool steps means the call never executed.
      expect(toolSteps.length, shellSays).toBeGreaterThan(0);
      expect(names, shellSays).toContain('repo/src/lib.js');
      expect(names, shellSays).toContain('out/report/result.txt');
      // No loose .git objects ever persist — the storage boundary refuses them.
      expect(names.some((n) => n.includes('.git/'))).toBe(false);
      const { getLabRunFile } = await import('@potion/db');
      const result = await getLabRunFile(db.db, ORG, runId, 'out/report/result.txt');
      expect(result!.content.toString()).toContain('tree ok, git ok');
    } finally {
      proc.kill();
    }
  }, 60_000);
});

describe('the judge retry (2026-08-31 — cheap routes truncate)', () => {
  beforeEach(async () => {
    const { createUser, createMembership } = await import('@potion/db');
    await createUser(db.db, { id: 'usr-jr-admin', email: 'jr@org.dev', name: 'jr' });
    await createMembership(db.db, { orgId: ORG, userId: 'usr-jr-admin', role: 'admin' });
  });

  it('a truncated first verdict is retried once and the clean second one lands', async () => {
    const BRIEF = JSON.stringify({ headline: [{ claim: 'x', sourceUrl: 'https://e.com' }], byEntity: [], quiet: [], coverage: { checked: 1 } });
    const GOOD = JSON.stringify({ overall: 8, criteria: [{ name: 'sourced', score: 8, note: 'ok' }], rationale: 'fine' });
    const s = spec({ name: 'retry harness', mission: { kind: 'standing', goal: 'watch' }, contract: { type: 'brief' } });
    const runId = 'run-judge-retry';
    await seedRun(runId, s);
    const { factory } = scriptedFactory([
      ok({ text: BRIEF }),
      ok({ text: '{"overall": 8, "criteria": [{"name": "sour' }), // truncated mid-string — the live failure
      ok({ text: GOOD }),
    ]);
    const res = await createLabRunHandler({ clientFactory: factory, sendNotify: async () => {} })({ orgId: ORG, runId }, ctx());
    expect(res.state).toBe('completed');
    const run = await getLabRun(db.db, runId, ORG);
    expect((run!.judge as { overall: number }).overall).toBe(8);
  });

  it('a completed TASK run (no contract) gets judged on its report', async () => {
    const GOOD = JSON.stringify({ overall: 9, criteria: [{ name: 'goal', score: 9, note: 'done' }], rationale: 'solid' });
    const s = spec({ name: 'task judge harness' }); // task, no contract
    const runId = 'run-judge-task';
    await seedRun(runId, s);
    const { factory } = scriptedFactory([
      ok({ text: 'The analysis is complete: totals computed, chart written, findings stated clearly and at length.' }),
      ok({ text: 'Wrap-up: computed the totals, wrote the chart, stated the three findings — done-definition met.' }),
      ok({ text: GOOD }), // the judge on the report
    ]);
    const res = await createLabRunHandler({ clientFactory: factory, sendNotify: async () => {} })({ orgId: ORG, runId }, ctx());
    expect(res.state).toBe('completed');
    const run = await getLabRun(db.db, runId, ORG);
    expect((run!.judge as { overall: number }).overall).toBe(9);
  });
});
