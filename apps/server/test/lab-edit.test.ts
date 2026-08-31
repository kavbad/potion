// Step 9 — the /edit route (the form's tap-to-edit save path) + the typed
// anomaly flags on the run DTO. The dial-motion discipline applied to the
// rest of the spec: every edit is a NEW content-addressed catalog row with
// carried provenance; the prior row and every run frozen from it are
// untouched; the closure gate refuses rather than emit a broken row.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sha256 } from '@potion/core';
import {
  createLabRun,
  createMembership,
  createOrg,
  createSession,
  createUser,
  createDb,
  getLabHarness,
  migrate,
  upsertLabHarness,
  type DbHandle,
} from '@potion/db';
import { harnessSpecHash, parseHarnessSpecText, type HarnessSpec } from '@potion/lab-spec';
import { buildServer } from '../src/server.js';

const ORG = 'org_lab_edit';
const COOKIE = 'potion_session=ps_lab_edit';

let h: DbHandle;
let app: FastifyInstance;
let devAuthBefore: string | undefined;

function spec(over: Partial<HarnessSpec> = {}): HarnessSpec {
  return {
    specVersion: 1,
    name: 'edit-route harness',
    brain: { policy: { type: 'min_cost', qualityFloor: 0 } },
    mission: { kind: 'task', goal: 'do the thing', doneDefinition: 'done', worthPerRunUsd: 1 },
    superpowers: [],
    memory: { enabled: false },
    rules: ['first rule'],
    fuel: { maxUsdPerRun: 0.25, hardStop: true },
    checkIns: [],
    ...over,
  } as HarnessSpec;
}

async function seedCatalog(s: HarnessSpec): Promise<string> {
  const hash = harnessSpecHash(s);
  await upsertLabHarness(h.db, {
    orgId: ORG,
    harnessHash: hash,
    name: s.name,
    specText: JSON.stringify({ ...s, hash }),
    sidecar: { specHash: hash, choicesHash: sha256('[]'), choices: [] },
    clusterId: 'summarization',
  });
  return hash;
}

beforeAll(async () => {
  devAuthBefore = process.env.POTION_DEV_AUTH;
  process.env.POTION_DEV_AUTH = '0';
  h = await createDb();
  await migrate(h.db);
  await createOrg(h.db, { id: ORG, name: 'Lab Edit Org' });
  await createUser(h.db, { id: 'usr_lab_edit', email: 'edit@lab.dev', name: 'edit' });
  await createMembership(h.db, { orgId: ORG, userId: 'usr_lab_edit', role: 'admin' });
  await createSession(h.db, {
    id: 'ses_lab_edit',
    userId: 'usr_lab_edit',
    tokenHash: sha256('ps_lab_edit'),
    orgId: ORG,
    expiresAt: new Date(Date.now() + 3600_000),
  });
  app = await buildServer({ db: h, seed: false });
}, 120_000);

afterAll(async () => {
  if (devAuthBefore === undefined) delete process.env.POTION_DEV_AUTH;
  else process.env.POTION_DEV_AUTH = devAuthBefore;
  await app.close();
  await h.close();
});

function post(url: string, payload: unknown) {
  return app.inject({
    method: 'POST',
    url,
    headers: { cookie: COOKIE, 'content-type': 'application/json' },
    payload: payload as Record<string, unknown>,
  });
}

describe('POST /api/lab/harnesses/:hash/edit', () => {
  it('add-rule lands a NEW content-addressed row; the prior row is untouched', async () => {
    const hash = await seedCatalog(spec());
    const res = await post(`/api/lab/harnesses/${hash}/edit`, {
      ops: [{ op: 'add-rule', rule: 'never email externally' }],
    });
    const body = res.json() as { ok: boolean; harnessHash: string; previousHash: string; unchanged: boolean };
    expect(res.statusCode, res.body).toBe(200);
    expect(body.unchanged).toBe(false);
    expect(body.harnessHash).not.toBe(hash);
    expect(body.previousHash).toBe(hash);
    // the new row parses, carries the rule, and rebinds the sidecar
    const next = (await getLabHarness(h.db, ORG, body.harnessHash))!;
    const parsed = parseHarnessSpecText(next.specText);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.spec.rules).toContain('never email externally');
    expect((next.sidecar as { specHash: string }).specHash).toBe(body.harnessHash);
    // the PRIOR row is byte-identical still
    const prior = (await getLabHarness(h.db, ORG, hash))!;
    expect(parseHarnessSpecText(prior.specText).ok).toBe(true);
    expect(prior.harnessHash).toBe(hash);
  });

  it('set-worth re-derives fuel through fuelFromWorth (dial honesty for money)', async () => {
    const hash = await seedCatalog(spec({ name: 'worth harness' }));
    const res = await post(`/api/lab/harnesses/${hash}/edit`, {
      ops: [{ op: 'set-worth', worthUsd: 2 }],
    });
    const body = res.json() as { harnessHash: string };
    const next = (await getLabHarness(h.db, ORG, body.harnessHash))!;
    const parsed = parseHarnessSpecText(next.specText);
    if (parsed.ok) {
      expect(parsed.spec.fuel.maxUsdPerRun).toBe(0.5); // 2 × 0.25 ratio
      expect((parsed.spec.mission as { worthPerRunUsd?: number }).worthPerRunUsd).toBe(2);
    }
  });

  it('declare-superpower adds the external-action gate (the generation-time default, mirrored)', async () => {
    const hash = await seedCatalog(spec({ name: 'declare harness' }));
    const res = await post(`/api/lab/harnesses/${hash}/edit`, {
      ops: [{ op: 'declare-superpower', id: 'calendar' }],
    });
    const body = res.json() as { harnessHash: string };
    const parsed = parseHarnessSpecText((await getLabHarness(h.db, ORG, body.harnessHash))!.specText);
    if (parsed.ok) {
      expect(parsed.spec.superpowers.map((s) => s.id)).toContain('calendar');
      expect(parsed.spec.checkIns.some((c) => c.trigger === 'before-external-action')).toBe(true);
    }
  });

  it('a no-op patch answers unchanged:true and writes nothing new', async () => {
    const s = spec({ name: 'noop harness' });
    const hash = await seedCatalog(s);
    const res = await post(`/api/lab/harnesses/${hash}/edit`, {
      ops: [{ op: 'undeclare-superpower', id: 'nonexistent' }],
    });
    const body = res.json() as { ok: boolean; harnessHash: string; unchanged: boolean };
    expect(body.unchanged).toBe(true);
    expect(body.harnessHash).toBe(hash);
  });

  it('out-of-range remove-rule is a 400, never a broken row', async () => {
    const hash = await seedCatalog(spec({ name: 'range harness' }));
    const res = await post(`/api/lab/harnesses/${hash}/edit`, {
      ops: [{ op: 'remove-rule', index: 99 }],
    });
    expect(res.statusCode).toBe(400);
  });

  it('a run frozen BEFORE the edit still replays its own spec (catalog invariance holds)', async () => {
    const s = spec({ name: 'frozen harness' });
    const hash = await seedCatalog(s);
    await createLabRun(h.db, { id: 'run-frozen-edit', orgId: ORG, harnessHash: hash, harnessName: s.name, spec: s });
    await post(`/api/lab/harnesses/${hash}/edit`, { ops: [{ op: 'add-rule', rule: 'post-run rule' }] });
    const run = await app.inject({ method: 'GET', url: '/api/lab/runs/run-frozen-edit', headers: { cookie: COOKIE } });
    const body = run.json() as { harnessHash: string; superpowers: unknown[] };
    expect(body.harnessHash).toBe(hash); // the run's identity did not move
  });
});

describe('run DTO anomaly flags (Step 9 typed parse)', () => {
  it('fallback=1 / latency_violated=1 in a step trace surface as booleans', async () => {
    const s = spec({ name: 'anomaly harness' });
    const hash = harnessSpecHash(s);
    await createLabRun(h.db, { id: 'run-anom-flags', orgId: ORG, harnessHash: hash, harnessName: s.name, spec: s });
    const { claimLabRun, appendLabStep } = await import('@potion/db');
    const claim = await claimLabRun(h.db, { runId: 'run-anom-flags', orgId: ORG, expectedHarnessHash: hash, leaseMs: 60_000 });
    if (!claim.ok) throw new Error(claim.reason);
    await appendLabStep(h.db, {
      runId: 'run-anom-flags', orgId: ORG, fence: claim.fence, seq: 1, kind: 'model',
      payload: {
        kind: 'model', slot: 'brain', requestPayload: { model: 'potion-auto', messages: [] },
        responseText: 'served off-frontier', toolCalls: [], finishReason: 'stop', completionId: 'cmpl-anom',
        frontierTrace: 'cluster=x;strategy=abcd1234;frontier=v1;policy=min_cost;fallback=1;latency_violated=1;provenance=live',
        usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 }, estCostUsd: 0.0001,
        clockMs: 1, rngSample: 0.5, legSeq: 1, stepInLeg: 1,
      },
      harnessHash: hash, leaseMs: 60_000,
    });
    const res = await app.inject({ method: 'GET', url: '/api/lab/runs/run-anom-flags', headers: { cookie: COOKIE } });
    const step = (res.json() as { steps: Array<{ fallback?: boolean; latencyViolated?: boolean }> }).steps[0]!;
    expect(step.fallback).toBe(true);
    expect(step.latencyViolated).toBe(true);
  });
});

describe('PUT /api/lab/harnesses/:hash/spec — the open hood (2026-08-27)', () => {
  function put(url: string, payload: unknown) {
    return app.inject({
      method: 'PUT',
      url,
      headers: { cookie: COOKIE, 'content-type': 'application/json' },
      payload: payload as Record<string, unknown>,
    });
  }

  it('a valid whole-file edit mints a NEW content-addressed row; prior row untouched; sidecar names the lineage', async () => {
    const s = spec({ name: 'hood harness' });
    const hash = await seedCatalog(s);
    const edited = { ...s, rules: ['first rule', 'Done well means: sharp and short'] };
    delete (edited as { hash?: string }).hash;
    const res = await put(`/api/lab/harnesses/${hash}/spec`, { specText: JSON.stringify(edited, null, 2) });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; harnessHash: string; previousHash: string };
    expect(body.ok).toBe(true);
    expect(body.previousHash).toBe(hash);
    expect(body.harnessHash).not.toBe(hash);
    const prior = await getLabHarness(h.db, ORG, hash);
    expect(prior?.harnessHash).toBe(hash);
    const minted = await getLabHarness(h.db, ORG, body.harnessHash);
    const sidecar = minted?.sidecar as { editedFrom?: string; choices: unknown[] };
    expect(sidecar.editedFrom).toBe(hash);
    expect(sidecar.choices).toEqual([]);
    const reparsed = parseHarnessSpecText(minted!.specText);
    expect(reparsed.ok).toBe(true);
  });

  it('an invalid edit returns the TYPED issue list (path + code), never a laundered 400', async () => {
    const s = spec({ name: 'hood harness invalid' });
    const hash = await seedCatalog(s);
    const bad = { ...s, fuel: { maxUsdPerRun: 0.25 } }; // hardStop missing — unrepresentable
    delete (bad as { hash?: string }).hash;
    const res = await put(`/api/lab/harnesses/${hash}/spec`, { specText: JSON.stringify(bad) });
    expect(res.statusCode).toBe(422);
    const body = res.json() as { ok: boolean; issues: Array<{ code: string; path: string }> };
    expect(body.ok).toBe(false);
    expect(body.issues.length).toBeGreaterThan(0);
    expect(body.issues.some((i) => i.path.startsWith('fuel'))).toBe(true);
  });

  it('a stale embedded hash is a tamper rejection; stripping it saves fine', async () => {
    const s = spec({ name: 'hood harness tamper' });
    const hash = await seedCatalog(s);
    const tampered = { ...s, rules: ['changed'], hash };
    const res = await put(`/api/lab/harnesses/${hash}/spec`, { specText: JSON.stringify(tampered) });
    expect(res.statusCode).toBe(422);
    const body = res.json() as { issues: Array<{ code: string }> };
    expect(body.issues.some((i) => i.code === 'hash-mismatch')).toBe(true);
  });

  it('an unchanged file is acknowledged, not re-minted', async () => {
    const s = spec({ name: 'hood harness unchanged' });
    const hash = await seedCatalog(s);
    const row = await getLabHarness(h.db, ORG, hash);
    const res = await put(`/api/lab/harnesses/${hash}/spec`, { specText: row!.specText });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { unchanged?: boolean }).unchanged).toBe(true);
  });
});

describe('P1 — arm/pause + the scheduler window math', () => {
  it('arming requires standing + a supported cron; pause flips state', async () => {
    const { missionWindow } = await import('../src/lab-scheduler.js');
    // Window math, pinned:
    const now = new Date('2026-08-28T10:30:00Z');
    expect(missionWindow('0 * * * *', now)).toEqual({ key: '2026-08-28T10', dueAt: new Date('2026-08-28T10:00:00Z') });
    expect(missionWindow('0 9 * * *', now)).toEqual({ key: '2026-08-28', dueAt: new Date('2026-08-28T09:00:00Z') });
    const daily = missionWindow('0 9 * * *', new Date('2026-08-28T08:59:00Z'));
    expect(daily!.key.startsWith('pre-')).toBe(true); // before 09:00 — not due
    // 2026-08-28 is a Friday → the week anchors on Monday the 24th.
    expect(missionWindow('0 9 * * 1', now)).toEqual({ key: 'wk-2026-08-24', dueAt: new Date('2026-08-24T09:00:00Z') });
    expect(missionWindow('*/5 * * * *', now)).toBeNull(); // unsupported → typed

    const s = spec({
      name: 'armable harness',
      mission: { kind: 'standing', goal: 'watch things' },
      contract: { type: 'brief' },
      checkIns: [{ trigger: 'cron', schedule: '0 9 * * *', question: 'anything meaningful?' }],
    });
    const hash = await seedCatalog(s);
    const armed = await post(`/api/lab/harnesses/${hash}/arm`, {});
    expect(armed.statusCode).toBe(200);
    const armedBody = armed.json() as { mission: { state: string; nextDueAt: string | null } };
    expect(armedBody.mission.state).toBe('armed');
    expect(armedBody.mission.nextDueAt).not.toBeNull();
    const paused = await post(`/api/lab/harnesses/${hash}/pause`, {});
    expect((paused.json() as { mission: { state: string } }).mission.state).toBe('paused');

    // A task mission cannot be armed — typed 400.
    const t = spec({ name: 'task harness p1' });
    const tHash = await seedCatalog(t);
    expect((await post(`/api/lab/harnesses/${tHash}/arm`, {})).statusCode).toBe(400);
    // A standing mission WITHOUT a schedule cannot be armed — typed 400.
    const noCron = spec({ name: 'no-cron standing', mission: { kind: 'standing', goal: 'watch' } });
    const ncHash = await seedCatalog(noCron);
    expect((await post(`/api/lab/harnesses/${ncHash}/arm`, {})).statusCode).toBe(400);
  });

  it('schedulerTick starts exactly ONE check per window, skips handled windows, and never bursts', async () => {
    const { schedulerTick } = await import('../src/lab-scheduler.js');
    const { armLabMission, getLabMission, getLabRun } = await import('@potion/db');
    const s = spec({
      name: 'tick harness',
      mission: { kind: 'standing', goal: 'watch things' },
      contract: { type: 'brief' },
      checkIns: [{ trigger: 'cron', schedule: '0 9 * * *', question: 'anything?' }],
    });
    const hash = await seedCatalog(s);
    await armLabMission(h.db, { orgId: ORG, harnessHash: hash, cadenceCron: '0 9 * * *', armedBy: 'test' });
    const enqueued: Array<{ kind: string; runId: string }> = [];
    const queue = { enqueue: async (kind: string, payload: { runId: string }) => { enqueued.push({ kind, runId: payload.runId }); return 'job-1'; } };
    const at = new Date('2026-08-28T09:05:00Z');
    await schedulerTick({ db: h, queue: queue as never }, at);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]!.runId).toBe(`chk-${hash.slice(0, 8)}-2026-08-28`);
    const run = await getLabRun(h.db, enqueued[0]!.runId, ORG);
    expect(run!.state).toBe('pending');
    // Same window, second tick: handled — nothing new (two dedups agree).
    await schedulerTick({ db: h, queue: queue as never }, new Date('2026-08-28T09:30:00Z'));
    expect(enqueued).toHaveLength(1);
    // A MISSED window is skipped, never bursted: next day's tick starts
    // one check for THAT day only.
    await schedulerTick({ db: h, queue: queue as never }, new Date('2026-08-30T09:05:00Z'));
    expect(enqueued).toHaveLength(2);
    expect(enqueued[1]!.runId).toBe(`chk-${hash.slice(0, 8)}-2026-08-30`);
    const m = await getLabMission(h.db, ORG, hash);
    expect(m!.lastWindowKey).toBe('2026-08-30');
    // Paused: nothing starts.
    const { pauseLabMission } = await import('@potion/db');
    await pauseLabMission(h.db, ORG, hash);
    await schedulerTick({ db: h, queue: queue as never }, new Date('2026-08-31T09:05:00Z'));
    expect(enqueued).toHaveLength(2);
  });
});

describe('P5 — event triggers: the webhook inlet + the feed watcher', () => {
  it('arming a webhook-carrying mission mints the inlet URL ONCE; the token wakes it; bursts and bad tokens refuse', async () => {
    const s = spec({
      name: 'inlet harness',
      mission: { kind: 'standing', goal: 'act when poked', shape: 'watchdog' },
      contract: { type: 'brief' },
      checkIns: [{ trigger: 'webhook' }],
    });
    const hash = await seedCatalog(s);
    const armed = await post(`/api/lab/harnesses/${hash}/arm`, {});
    expect(armed.statusCode).toBe(200);
    const body = armed.json() as { mission: { state: string; cadenceCron: string; hasHook: boolean }; hook?: { url: string } };
    expect(body.mission.state).toBe('armed');
    expect(body.mission.cadenceCron).toBe('event'); // armable with NO schedule
    expect(body.mission.hasHook).toBe(true);
    expect(body.hook?.url).toMatch(/\/hooks\/lab\/whk_[0-9a-f]{48}$/);
    const token = body.hook!.url.split('/hooks/lab/')[1]!;

    // The token starts a check.
    const fired = await app.inject({ method: 'POST', url: `/hooks/lab/${token}` });
    expect(fired.statusCode).toBe(202);
    const { runId } = fired.json() as { runId: string };
    expect(runId.startsWith(`hk-${hash.slice(0, 8)}-`)).toBe(true);
    const { getLabRun } = await import('@potion/db');
    expect((await getLabRun(h.db, runId, ORG))!.state).toBe('pending');

    // Same minute again: the per-minute id refuses the burst, typed.
    const burst = await app.inject({ method: 'POST', url: `/hooks/lab/${token}` });
    expect(burst.statusCode).toBe(429);

    // A wrong token and a malformed one are the uniform 404 — no oracle.
    expect((await app.inject({ method: 'POST', url: `/hooks/lab/whk_${'f'.repeat(48)}` })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/hooks/lab/not-a-token' })).statusCode).toBe(404);

    // Pausing closes the inlet: the same token now 404s uniformly.
    await post(`/api/lab/harnesses/${hash}/pause`, {});
    expect((await app.inject({ method: 'POST', url: `/hooks/lab/${token}` })).statusCode).toBe(404);
  });

  it('the feed watcher primes silently, fires on a REAL change, and ignores script/nonce churn', async () => {
    const { feedTick } = await import('../src/lab-scheduler.js');
    const { armLabMission, getLabMission } = await import('@potion/db');
    const s = spec({
      name: 'feed harness',
      mission: { kind: 'standing', goal: 'watch the pricing page', shape: 'watchdog' },
      contract: { type: 'brief' },
      checkIns: [{ trigger: 'feed-change', url: 'https://watched.example/pricing' }],
    });
    const hash = await seedCatalog(s);
    await armLabMission(h.db, { orgId: ORG, harnessHash: hash, cadenceCron: 'event', armedBy: 'test' });

    let page = '<html><script>nonce=1</script><body>Pro plan: $49</body></html>';
    const feedFetch: typeof fetch = async () => new Response(page, { status: 200 });
    const feedLookup = async () => ({ address: '203.0.113.9' });
    const enqueued: string[] = [];
    const queue = { enqueue: async (_k: string, p: { runId: string }) => { enqueued.push(p.runId); return 'job-f'; } };
    const opts = { db: h, queue: queue as never, feedFetch, feedLookup };

    // First sight primes — no run.
    await feedTick(opts, new Date('2026-08-28T10:00:00Z'));
    expect(enqueued).toHaveLength(0);

    // Nonce churn only — normalized away, no fire.
    page = '<html><script>nonce=999</script><body>Pro plan: $49</body></html>';
    await feedTick(opts, new Date('2026-08-28T10:06:00Z'));
    expect(enqueued).toHaveLength(0);

    // A REAL change fires within one cycle.
    page = '<html><script>nonce=2</script><body>Pro plan: $59</body></html>';
    await feedTick(opts, new Date('2026-08-28T10:12:00Z'));
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]!.startsWith(`fc-${hash.slice(0, 8)}-`)).toBe(true);

    // Another change inside the fire window: rate-limited (hash updates,
    // no second check).
    page = '<html><body>Pro plan: $69</body></html>';
    await feedTick(opts, new Date('2026-08-28T10:20:00Z'));
    expect(enqueued).toHaveLength(1);

    // Past the window, the next change fires again.
    page = '<html><body>Pro plan: $79</body></html>';
    await feedTick(opts, new Date('2026-08-28T10:55:00Z'));
    expect(enqueued).toHaveLength(2);

    const m = await getLabMission(h.db, ORG, hash);
    const state = m!.feedState as Record<string, { hash: string; firedAt?: string }>;
    expect(state['https://watched.example/pricing']!.firedAt).toBeDefined();
  });

  it('an SSRF-refused feed url is typed silence — never fetched, never a fire', async () => {
    const { feedTick } = await import('../src/lab-scheduler.js');
    const { armLabMission } = await import('@potion/db');
    const s = spec({
      name: 'ssrf feed harness',
      mission: { kind: 'standing', goal: 'watch' },
      contract: { type: 'brief' },
      checkIns: [{ trigger: 'feed-change', url: 'https://internal.example/admin' }],
    });
    const hash = await seedCatalog(s);
    await armLabMission(h.db, { orgId: ORG, harnessHash: hash, cadenceCron: 'event', armedBy: 'test' });
    let fetched = 0;
    const feedFetch: typeof fetch = async () => { fetched += 1; return new Response('x'); };
    const feedLookup = async () => ({ address: '10.0.0.7' }); // resolves private
    const enqueued: string[] = [];
    const queue = { enqueue: async (_k: string, p: { runId: string }) => { enqueued.push(p.runId); return 'job-s'; } };
    await feedTick({ db: h, queue: queue as never, feedFetch, feedLookup }, new Date('2026-08-28T11:00:00Z'));
    expect(fetched).toBe(0);
    expect(enqueued).toHaveLength(0);
  });
});

describe('H2 — the artifact that escapes (share a deliverable)', () => {
  const BRIEF = JSON.stringify({
    headline: [{ claim: 'Northwind cut Pro 20%', sourceUrl: 'https://example.com/pricing' }],
    byEntity: [],
    quiet: ['Fabrikam'],
    coverage: { checked: 2 },
  });

  async function seedCompletedRun(runId: string, briefText: string): Promise<string> {
    const s = spec({
      name: `share harness ${runId}`,
      mission: { kind: 'standing', goal: 'watch the market' },
      contract: { type: 'brief' },
    });
    const hash = await seedCatalog(s);
    await createLabRun(h.db, { id: runId, orgId: ORG, harnessHash: hash, harnessName: s.name, spec: s });
    const { labRunSteps, labRuns } = await import('@potion/db');
    const { eq } = await import('drizzle-orm');
    await h.db.insert(labRunSteps).values({
      runId, orgId: ORG, seq: 1, kind: 'model',
      payload: { kind: 'model', responseText: briefText, finishReason: 'stop', clockMs: 0, rngSample: 0 },
    });
    await h.db.update(labRuns).set({ state: 'completed' }).where(eq(labRuns.id, runId));
    return hash;
  }

  it('mints a frozen snapshot; the public page serves it; revocation kills it', async () => {
    await seedCompletedRun('run-share-1', BRIEF);
    const res = await post('/api/lab/runs/run-share-1/share', {});
    expect(res.statusCode).toBe(201);
    const body = res.json() as { ok: boolean; url: string; shareId: string; verified: boolean };
    expect(body.url).toMatch(/\/share\/b\/st_[0-9a-f]{64}$/);
    // A hand-seeded record cannot replay-verify — the badge must be HONEST.
    expect(body.verified).toBe(false);
    const token = body.url.split('/share/b/')[1]!;

    const pub = await app.inject({ method: 'GET', url: `/api/public/share/${token}/brief` });
    expect(pub.statusCode).toBe(200);
    const payload = pub.json() as { harnessName: string; brief: { headline: unknown[] }; verified: boolean; meteredUsd: number; estUsd: number };
    expect(payload.brief.headline).toHaveLength(1);
    expect(payload.verified).toBe(false);
    expect(typeof payload.meteredUsd).toBe('number');
    // No org identity in the escaped payload.
    expect(pub.body).not.toContain(ORG);

    // Revoke through the M4 rail — the page 404s uniformly after.
    const revoke = await post(`/api/share/${body.shareId}/revoke`, {});
    expect(revoke.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/api/public/share/${token}/brief` })).statusCode).toBe(404);
  });

  it('key-shaped content in the deliverable REFUSES the mint — nothing escapes', async () => {
    const leaky = JSON.stringify({
      headline: [{ claim: 'use sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA to fetch it', sourceUrl: 'https://example.com/x' }],
      byEntity: [], quiet: [], coverage: { checked: 1 },
    });
    await seedCompletedRun('run-share-leak', leaky);
    const res = await post('/api/lab/runs/run-share-leak/share', {});
    expect(res.statusCode).toBe(422);
    expect((res.json() as { reason: string }).reason).toContain('key-shaped');
  });

  it('a run without a deliverable or not completed refuses typed', async () => {
    const s = spec({ name: 'share harness bare', mission: { kind: 'standing', goal: 'g' }, contract: { type: 'brief' } });
    const hash = await seedCatalog(s);
    await createLabRun(h.db, { id: 'run-share-bare', orgId: ORG, harnessHash: hash, harnessName: s.name, spec: s });
    expect((await post('/api/lab/runs/run-share-bare/share', {})).statusCode).toBe(409); // pending
  });
});

describe('X8 — the steering inlet', () => {
  async function seedLiveRun(runId: string, state: 'running' | 'awaiting-human' | 'completed'): Promise<void> {
    const s = spec({ name: `steer harness ${runId}`, mission: { kind: 'standing', goal: 'work' } });
    const hash = await seedCatalog(s);
    await createLabRun(h.db, { id: runId, orgId: ORG, harnessHash: hash, harnessName: s.name, spec: s });
    if (state !== 'running') {
      const { labRuns } = await import('@potion/db');
      const { eq } = await import('drizzle-orm');
      await h.db.update(labRuns).set({ state }).where(eq(labRuns.id, runId));
    }
  }

  it('queues guidance with the honest note; parked runs stay parked', async () => {
    await seedLiveRun('run-steer-live', 'running');
    const res = await post('/api/lab/runs/run-steer-live/steer', { text: 'focus on the changelog' });
    expect(res.statusCode).toBe(202);
    expect((res.json() as { note: string }).note).toContain('next step');

    await seedLiveRun('run-steer-parked', 'awaiting-human');
    const parked = await post('/api/lab/runs/run-steer-parked/steer', { text: 'and skip pricing' });
    expect(parked.statusCode).toBe(202);
    expect((parked.json() as { note: string }).note).toContain('answer that to resume');
    // Steering NEVER resumes or authorizes: the run is still parked.
    const { getLabRun } = await import('@potion/db');
    expect((await getLabRun(h.db, 'run-steer-parked', ORG))!.state).toBe('awaiting-human');
  });

  it('terminal runs refuse typed; key-shaped text refuses; the queue caps', async () => {
    await seedLiveRun('run-steer-done', 'completed');
    expect((await post('/api/lab/runs/run-steer-done/steer', { text: 'x' })).statusCode).toBe(409);

    await seedLiveRun('run-steer-leak', 'running');
    const leak = await post('/api/lab/runs/run-steer-leak/steer', { text: 'use sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' });
    expect(leak.statusCode).toBe(422);
    expect((leak.json() as { reason: string }).reason).toContain('key-shaped');

    await seedLiveRun('run-steer-cap', 'running');
    for (let i = 0; i < 5; i++) {
      expect((await post('/api/lab/runs/run-steer-cap/steer', { text: `note ${i}` })).statusCode).toBe(202);
    }
    expect((await post('/api/lab/runs/run-steer-cap/steer', { text: 'one too many' })).statusCode).toBe(429);
  });

  it('a foreign run id is the uniform 404', async () => {
    expect((await post('/api/lab/runs/run-not-ours/steer', { text: 'x' })).statusCode).toBe(404);
  });
});
