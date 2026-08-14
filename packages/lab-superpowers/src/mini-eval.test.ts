// THE MINI-EVALS (Step 11 §3) — every catalog package, executed at $0
// against a fixture server built from its own authored surface. This is the
// step's DoD engine: every catalog package × {load + scope-filter, pore-fires on act /
// skips on read, authored-strings-only, injection floor, budget, typed
// failure} — plus the least-privilege and completeness meta-tests.
//
// The pore proof runs the REAL loop (runLeg) against the REAL wrapper, so
// "permission prompts provably fire on external actions" is proven by
// suspension, not by reading a boolean.
import { afterEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  answerLabRun,
  createDb,
  createLabRun,
  listLabSteps,
  migrate,
  seedIsolationOrgs,
  upsertLabGrant,
  ORG_A,
  type DbHandle,
} from '@potion/db';
import { sealEnvelope } from '@potion/custody';
import { MockMcpServer } from '@potion/lab-mcp/mock-server';
import { harnessSpecHash, scanRawValue, type HarnessSpec } from '@potion/lab-spec';
import { buildMcpLabTools, runLeg } from '@potion/lab-runtime';
import type { ServingClient, ServingRequest, ServingResult } from '@potion/lab-runtime';
import { CATALOG, LIVE_PROVEN_IDS } from './catalog.js';
import {
  contextTokens,
  packageContentHash,
  toConnectorDefForFixture,
  validatePackage,
  type SuperpowerPackage,
} from './format.js';
import { honestFixtureTools, hostileFixtureTools, toolsVisibleUnderDefaultGrant } from './mini-eval.js';

const MASTER = randomBytes(32);
const TOKEN = 'gho_miniEvalFixture4X9mQ2vL7pK8rT3sW6z';

function specFor(pkg: SuperpowerPackage): HarnessSpec {
  return {
    specVersion: 1,
    name: `${pkg.id} mini-eval harness`,
    brain: { policy: { type: 'min_cost', qualityFloor: 0 } },
    mission: { kind: 'task', goal: `exercise ${pkg.id}`, doneDefinition: 'exercised' },
    // The declared superpower carries the package's LEAST-PRIVILEGE default
    // scopes — the same set lab-gen assigns at interview time.
    superpowers: [{ id: pkg.id, scopes: [...pkg.defaultScopes] }],
    memory: { enabled: false },
    rules: ['never act without asking'],
    fuel: { maxUsdPerRun: 1, hardStop: true },
    // Declaring a superpower auto-adds this check-in (Step 9 /edit); the
    // mini-eval harness carries it because a real one always does.
    checkIns: [{ trigger: 'before-external-action' }],
  };
}

function scripted(results: ServingResult[]): ServingClient {
  const queue = [...results];
  return {
    complete: async (_req: ServingRequest) => queue.shift() ?? Promise.reject(new Error('exhausted')),
    emitSpans: async () => true,
  } as unknown as ServingClient;
}
const ok = (over: Partial<Extract<ServingResult, { kind: 'ok' }>> = {}): ServingResult => ({
  kind: 'ok',
  completionId: `chatcmpl-${Math.random().toString(36).slice(2, 10)}`,
  text: 'done.',
  toolCalls: [],
  finishReason: 'stop',
  usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
  frontierTrace: 'cluster=x;strategy=t;policy=min_cost;fallback=0;provenance=mock',
  ...over,
});

let server: MockMcpServer | null = null;
let handle: DbHandle | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
  await handle?.close();
  handle = null;
});

async function seed(pkg: SuperpowerPackage, runId: string): Promise<{ h: DbHandle; hash: string; s: HarnessSpec }> {
  const h = await createDb();
  await migrate(h.db);
  await seedIsolationOrgs(h.db);
  const s = specFor(pkg);
  const hash = harnessSpecHash(s);
  await createLabRun(h.db, { id: runId, orgId: ORG_A, harnessHash: hash, harnessName: s.name, spec: s });
  await upsertLabGrant(h.db, {
    id: `grant-${pkg.id}`,
    orgId: ORG_A,
    connectorId: pkg.id,
    superpowerId: pkg.id,
    // The grant carries EXACTLY the package's default scopes — never more.
    scopesGranted: [...pkg.defaultScopes],
    tokenEnvelope: sealEnvelope(MASTER, TOKEN),
    grantedBy: 'usr_admin',
  });
  return { h, hash, s };
}

// ───────────────────────────── catalog-wide meta-tests ──────────────────

describe('catalog completeness + honesty (the anti-decoration gates)', () => {
  it('ships the curated catalog (≥25 packages), every one structurally valid', () => {
    expect(CATALOG.length).toBeGreaterThanOrEqual(25);
    for (const pkg of CATALOG) {
      const issues = validatePackage(pkg, LIVE_PROVEN_IDS);
      expect(issues, `${pkg.id}: ${JSON.stringify(issues)}`).toEqual([]);
    }
  });

  it('ids and content hashes are unique — no accidental clones', () => {
    expect(new Set(CATALOG.map((p) => p.id)).size).toBe(CATALOG.length);
    expect(new Set(CATALOG.map(packageContentHash)).size).toBe(CATALOG.length);
  });

  it('the read/act split is NON-VACUOUS: every package classifies, and act tools really exist', () => {
    const acts = CATALOG.flatMap((p) => p.tools.filter((t) => t.action === 'act'));
    const reads = CATALOG.flatMap((p) => p.tools.filter((t) => t.action === 'read'));
    expect(acts.length).toBeGreaterThanOrEqual(20); // a pore proof per package, at least
    expect(reads.length).toBeGreaterThan(acts.length);
    for (const pkg of CATALOG) {
      expect(pkg.tools.every((t) => t.action === 'read' || t.action === 'act')).toBe(true);
    }
  });

  it('LEAST PRIVILEGE: the default grant funds the read tools and never an act tool', () => {
    for (const pkg of CATALOG) {
      const granted = new Set(pkg.defaultScopes);
      for (const t of pkg.tools) {
        const funded = t.requiredScopes.every((s) => granted.has(s));
        if (t.action === 'act' && t.requiredScopes.length > 0) {
          expect(funded, `${pkg.id}.${t.name}: an ACT tool is funded by the DEFAULT grant`).toBe(false);
        }
      }
      // and every default scope is actually needed by some read tool
      const readScopes = new Set(pkg.tools.filter((t) => t.action === 'read').flatMap((t) => t.requiredScopes));
      for (const s of pkg.defaultScopes) expect(readScopes.has(s), `${pkg.id}: unused default scope ${s}`).toBe(true);
    }
  });

  it('USAGE BUDGET: every package fits its declared context budget', () => {
    for (const pkg of CATALOG) {
      const tokens = contextTokens(pkg);
      expect(tokens, `${pkg.id}: ${tokens} est tokens > ${pkg.usage.tokenBudget}`).toBeLessThanOrEqual(
        pkg.usage.tokenBudget,
      );
    }
  });

  it('TIERING is honest: nothing claims live-proven without a ledger row', () => {
    for (const pkg of CATALOG) {
      if (pkg.proof === 'live-proven') expect(LIVE_PROVEN_IDS.has(pkg.id)).toBe(true);
      if (pkg.proof === 'fixture-recorded') expect(pkg.fixtureStamp).toBeDefined();
    }
    // Today: no live-proven package exists (the Step 10 live leg is bound
    // into Step 12). The catalog says so rather than implying otherwise.
    expect(CATALOG.filter((p) => p.proof === 'live-proven')).toEqual([]);
  });

  it('CONNECTABILITY is honest: unverified endpoints are structurally unconnectable', async () => {
    const { toConnectorDef } = await import('./format.js');
    for (const pkg of CATALOG) {
      const def = toConnectorDef(pkg);
      if (pkg.connect.status === 'ready') {
        expect(def, `${pkg.id} is ready but did not compile`).not.toBeNull();
        expect(def!.baseUrl.startsWith('https://')).toBe(true);
      } else {
        expect(def, `${pkg.id} is ${pkg.connect.status} but compiled to a connector`).toBeNull();
      }
    }
  });

  it('authored descriptions never smuggle credential-shaped content past the Step 3 gate', () => {
    for (const pkg of CATALOG) {
      const hits = scanRawValue({
        preamble: pkg.usage.preamble,
        tools: pkg.tools.map((t) => ({ d: t.description, p: t.parameters })),
      }).filter((i) => i.code === 'secret-material');
      expect(hits, `${pkg.id}: ${JSON.stringify(hits)}`).toEqual([]);
    }
  });
});

// ───────────────────────── the per-package mini-evals ───────────────────

describe.each(CATALOG.map((p) => [p.id, p] as const))('mini-eval: %s', (id, pkg) => {
  it('loads under the DEFAULT grant, scope-filtered, with AUTHORED strings only', async () => {
    server = await MockMcpServer.start({ tools: honestFixtureTools(pkg), requireBearer: TOKEN });
    const { h, s } = await seed(pkg, `run-${id}`);
    handle = h;
    const leg = await buildMcpLabTools({
      db: h.db, orgId: ORG_A, runId: `run-${id}`, masterKey: MASTER, spec: s,
      connectors: [toConnectorDefForFixture(pkg, server.mcpUrl)],
    });
    // exactly the tools the least-privilege default funds
    const visible = toolsVisibleUnderDefaultGrant(pkg).map((n) => `${pkg.id}.${n}`);
    expect(leg.tools.map((t) => t.name).sort()).toEqual(visible.sort());
    expect(leg.tools.length).toBeGreaterThan(0); // never a vacuous pass
    // authored text rode; the fixture server's '[vendor] ' prefix did not
    for (const t of leg.tools) {
      expect(t.description).not.toContain('[vendor]');
      const authored = pkg.tools.find((x) => `${pkg.id}.${x.name}` === t.name)!;
      expect(t.description).toBe(authored.description);
      expect(t.parameters).toEqual(authored.parameters);
    }
    await leg.close();
  }, 60_000);

  it('the PORE: act tools gate, read tools do not (permission prompts provably fire)', async () => {
    server = await MockMcpServer.start({ tools: honestFixtureTools(pkg), requireBearer: TOKEN });
    const { h, s } = await seed(pkg, `pore-${id}`);
    handle = h;
    // A grant WIDE enough to see the act tools too — the pore proof needs
    // them visible; the default-scope proof above is what pins that a real
    // default would not fund them.
    const { upsertLabGrant: reGrant } = await import('@potion/db');
    await reGrant(h.db, {
      id: `grant-${pkg.id}`, orgId: ORG_A, connectorId: pkg.id, superpowerId: pkg.id,
      scopesGranted: [...new Set(pkg.tools.flatMap((t) => t.requiredScopes))],
      tokenEnvelope: sealEnvelope(MASTER, TOKEN), grantedBy: 'usr_admin',
    });
    const leg = await buildMcpLabTools({
      db: h.db, orgId: ORG_A, runId: `pore-${id}`, masterKey: MASTER, spec: s,
      connectors: [toConnectorDefForFixture(pkg, server.mcpUrl)],
    });
    const actTool = leg.tools.find((t) => t.external);
    const readTool = leg.tools.find((t) => !t.external);
    expect(actTool, `${id} has no act tool visible — the pore proof would be vacuous`).toBeDefined();
    expect(readTool, `${id} has no read tool visible`).toBeDefined();

    // READ: runs without suspending.
    const readCall = {
      id: 'r1', type: 'function' as const,
      function: { name: readTool!.name, arguments: '{}' },
    };
    const readOutcome = await runLeg({
      db: h.db,
      client: scripted([
        ok({ text: '', finishReason: 'tool_calls', toolCalls: [readCall] }),
        ok({ text: 'read it.' }),
        ok({ text: 'wrap.' }),
      ]),
      runId: `pore-${id}`, orgId: ORG_A, spec: s, harnessHash: harnessSpecHash(s), tools: leg.tools,
    });
    expect(readOutcome.status, `${id}: a READ suspended at the pore`).toBe('completed');
    expect(server.requests.filter((r) => r.method === 'tools/call').length).toBe(1);

    // ACT: suspends BEFORE the call — the permission prompt.
    const { h: h2, s: s2 } = await seed(pkg, `pore2-${id}`);
    await reGrant(h2.db, {
      id: `grant-${pkg.id}`, orgId: ORG_A, connectorId: pkg.id, superpowerId: pkg.id,
      scopesGranted: [...new Set(pkg.tools.flatMap((t) => t.requiredScopes))],
      tokenEnvelope: sealEnvelope(MASTER, TOKEN), grantedBy: 'usr_admin',
    });
    const leg2 = await buildMcpLabTools({
      db: h2.db, orgId: ORG_A, runId: `pore2-${id}`, masterKey: MASTER, spec: s2,
      connectors: [toConnectorDefForFixture(pkg, server.mcpUrl)],
    });
    const before = server.requests.filter((r) => r.method === 'tools/call').length;
    const actCall = {
      id: 'a1', type: 'function' as const,
      function: { name: actTool!.name, arguments: '{}' },
    };
    const actOutcome = await runLeg({
      db: h2.db,
      client: scripted([ok({ text: '', finishReason: 'tool_calls', toolCalls: [actCall] })]),
      runId: `pore2-${id}`, orgId: ORG_A, spec: s2, harnessHash: harnessSpecHash(s2), tools: leg2.tools,
    });
    expect(actOutcome.status, `${id}: an ACT did NOT fire the pore`).toBe('awaiting-human');
    expect(server.requests.filter((r) => r.method === 'tools/call').length).toBe(before);
    // and the recorded question names the tool the human is approving
    const steps = await listLabSteps(h2.db, `pore2-${id}`, ORG_A);
    const checkIn = steps.find((x) => x.kind === 'check-in')!;
    expect(JSON.stringify(checkIn.payload)).toContain(actTool!.name);

    // one approval → exactly one act
    await answerLabRun(h2.db, `pore2-${id}`, ORG_A, 'yes');
    await runLeg({
      db: h2.db,
      client: scripted([
        ok({ text: '', finishReason: 'tool_calls', toolCalls: [actCall] }),
        ok({ text: 'acted.' }),
        ok({ text: 'wrap.' }),
      ]),
      runId: `pore2-${id}`, orgId: ORG_A, spec: s2, harnessHash: harnessSpecHash(s2), tools: leg2.tools,
    });
    expect(server.requests.filter((r) => r.method === 'tools/call').length).toBe(before + 1);
    await leg.close();
    await leg2.close();
    await h2.close();
  }, 120_000);

  it('INJECTION FLOOR: a hostile server moves nothing past the Rules', async () => {
    server = await MockMcpServer.start({ tools: hostileFixtureTools(pkg), requireBearer: TOKEN });
    const { h, s } = await seed(pkg, `inj-${id}`);
    handle = h;
    const leg = await buildMcpLabTools({
      db: h.db, orgId: ORG_A, runId: `inj-${id}`, masterKey: MASTER, spec: s,
      connectors: [toConnectorDefForFixture(pkg, server.mcpUrl)],
    });
    // 1. No payload reached model context (the authored strings rode).
    const context = JSON.stringify(leg.tools.map((t) => ({ d: t.description, p: t.parameters })));
    for (const payload of pkg.injectionPayloads) {
      expect(context, `${id}: an injection payload reached model context`).not.toContain(payload);
    }
    // 2. The hostile RESULT is recorded as data, and the Rules are untouched:
    //    rules come from the content-addressed spec, never from a result.
    const readTool = leg.tools.find((t) => !t.external)!;
    const call = { id: 'i1', type: 'function' as const, function: { name: readTool.name, arguments: '{}' } };
    await runLeg({
      db: h.db,
      client: scripted([
        ok({ text: '', finishReason: 'tool_calls', toolCalls: [call] }),
        ok({ text: 'saw it.' }),
        ok({ text: 'wrap.' }),
      ]),
      runId: `inj-${id}`, orgId: ORG_A, spec: s, harnessHash: harnessSpecHash(s), tools: leg.tools,
    });
    const steps = await listLabSteps(h.db, `inj-${id}`, ORG_A);
    const modelSteps = steps.filter((x) => x.kind === 'model');
    for (const st of modelSteps) {
      const sys = JSON.stringify(
        (st.payload as { requestPayload?: { messages?: Array<{ role: string; content: string }> } }).requestPayload
          ?.messages?.filter((m) => m.role === 'system') ?? [],
      );
      // the system prompt still carries the SPEC's rules and no payload
      expect(sys).toContain('never act without asking');
      for (const payload of pkg.injectionPayloads) expect(sys).not.toContain(payload);
    }
    await leg.close();
  }, 90_000);

  it('TYPED FAILURE: a revoked grant degrades typed, never a crash or a silent skip', async () => {
    server = await MockMcpServer.start({ tools: honestFixtureTools(pkg), requireBearer: TOKEN });
    const { h, s } = await seed(pkg, `fail-${id}`);
    handle = h;
    const { markLabGrantStatus } = await import('@potion/db');
    await markLabGrantStatus(h.db, ORG_A, pkg.id, 'revoked');
    const leg = await buildMcpLabTools({
      db: h.db, orgId: ORG_A, runId: `fail-${id}`, masterKey: MASTER, spec: s,
      connectors: [toConnectorDefForFixture(pkg, server.mcpUrl)],
    });
    expect(leg.tools).toEqual([]);
    expect(leg.legNotes[0]!.note.superpowerUnavailable.status).toBe('revoked');
    await leg.close();
  }, 60_000);
});
