// X4 — the fan-out laws at the runtime layer:
//   · validation refuses garbage with reasons; caps honored;
//   · allocateFanOut is total, reserves synthesis fuel, refuses starvation;
//   · fanOutSpentFromSteps is the ONE derivation of family spend from the
//     parent record (loop and replay both call it);
//   · the loop's fuel gate COUNTS recorded helper spend — a family that
//     already spent the cap is killed before the next model call;
//   · deriveSubSpec enforces depth-1 / never-acts / memory-off structurally;
//   · the fan-out law rides only fanOut-bearing prompts (replay law).
import { describe, expect, it } from 'vitest';
import { createDb, createLabRun, migrate, seedIsolationOrgs, ORG_A, labRunSteps } from '@potion/db';
import { harnessSpecHash, parseHarnessSpec, type HarnessSpec } from '@potion/lab-spec';
import { runLeg, systemPrompt } from './loop.js';
import type { ServingClientLike, ServingRequest, ServingResult } from './serving-client.js';
import { allocateFanOut, deriveSubSpec, fanOutSpentFromSteps, validateFanOut } from './fanout.js';

function spec(over: Partial<HarnessSpec> = {}): HarnessSpec {
  return {
    specVersion: 1,
    name: 'fanout test harness',
    brain: { policy: { type: 'min_cost', qualityFloor: 0 } },
    mission: { kind: 'task', goal: 'do the big thing', doneDefinition: 'done' },
    superpowers: [],
    memory: { enabled: false },
    rules: [],
    fuel: { maxUsdPerRun: 1, hardStop: true },
    checkIns: [],
    fanOut: { maxWorkers: 3 },
    ...over,
  };
}

describe('validateFanOut', () => {
  it('refuses garbage, empty, over-cap, and goal-less tasks with reasons', () => {
    expect((validateFanOut({}, 3) as { reason: string }).reason).toContain('required');
    expect((validateFanOut({ tasks: [] }, 3) as { reason: string }).reason).toContain('required');
    expect((validateFanOut({ tasks: [{ goal: 'a', doneDefinition: 'd' }, { goal: 'b', doneDefinition: 'd' }, { goal: 'c', doneDefinition: 'd' }, { goal: 'e', doneDefinition: 'd' }] }, 3) as { reason: string }).reason).toContain('at most 3');
    expect((validateFanOut({ tasks: [{ goal: 'a' }] }, 3) as { reason: string }).reason).toContain('doneDefinition');
  });
});

describe('allocateFanOut — the fuel-tree arithmetic', () => {
  it('slices the remaining budget with the synthesis reserve held back', () => {
    const a = allocateFanOut(1.0, 0.2, 2)!;
    // remaining 0.8, reserve 0.2, per-sub 0.3
    expect(a.perSubUsd).toBeCloseTo(0.3, 4);
    expect(a.reserveUsd).toBeCloseTo(0.2, 4);
    // family bound by construction: 2 × 0.3 + 0.2 spent ≤ 1.0 cap
    expect(2 * a.perSubUsd + 0.2 + a.reserveUsd).toBeLessThanOrEqual(1.0 + 1e-9);
  });
  it('refuses starvation and exhaustion', () => {
    expect(allocateFanOut(1.0, 1.0, 2)).toBeNull();
    expect(allocateFanOut(0.05, 0, 5)).toBeNull(); // slices below MIN_SUB_BUDGET
    expect(allocateFanOut(1.0, 0.99, 1)).toBeNull();
  });
});

describe('fanOutSpentFromSteps — the one family-spend derivation', () => {
  it('sums helper estUsd across delegate steps only, defensively', () => {
    const steps = [
      { kind: 'model', payload: { estCostUsd: 0.01 } },
      { kind: 'tool', payload: { toolName: 'delegate', toolOutput: { ok: true, helpers: [{ estUsd: 0.11 }, { estUsd: 0.07 }] } } },
      { kind: 'tool', payload: { toolName: 'web_fetch', toolOutput: { helpers: [{ estUsd: 99 }] } } },
      { kind: 'tool', payload: { toolName: 'delegate', toolOutput: { error: 'refused' } } },
    ];
    expect(fanOutSpentFromSteps(steps)).toBeCloseTo(0.18, 6);
  });
});

describe('deriveSubSpec — the helper laws, structural', () => {
  it('depth-1, never-acts, memory-off, budget slice', () => {
    const derived = deriveSubSpec(
      { name: 'parent', brain: { policy: { type: 'min_cost', qualityFloor: 0 } }, superpowers: [{ id: 'web', scopes: [] }, { id: 'github', scopes: ['repo'] }, { id: 'code', scopes: [] }], rules: ['be terse'] },
      { goal: 'read the docs', doneDefinition: 'summary written' },
      0.25,
      0,
    );
    // deriveSubSpec returns an untyped record; the REAL parser is what turns
    // it into a HarnessSpec — so parsing it here both types the value and
    // proves the derived spec is valid (what the old cast asserted by fiat).
    const parsed = parseHarnessSpec(derived);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(`derived spec did not parse: ${JSON.stringify(parsed.issues)}`);
    const sub: HarnessSpec = parsed.spec;
    expect(sub.fanOut).toBeUndefined(); // a helper never delegates
    expect(sub.checkIns).toEqual([]); // nothing to park on
    expect(sub.memory.enabled).toBe(false); // never writes the working set
    expect(sub.superpowers.map((s) => s.id).sort()).toEqual(['code', 'web']); // builtins only
    expect(sub.fuel).toEqual({ maxUsdPerRun: 0.25, hardStop: true });
    expect(sub.mission).toEqual({ kind: 'task', goal: 'read the docs', doneDefinition: 'summary written' });
    // The derived spec must be a VALID spec (hashable = parseable shape).
    expect(harnessSpecHash(sub)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('the prompt', () => {
  it('the fan-out law rides only fanOut-bearing specs (replay law)', () => {
    expect(systemPrompt(spec(), {}, [])).toContain('up to 3 helpers with the delegate tool');
    const plain = spec();
    delete (plain as { fanOut?: unknown }).fanOut;
    expect(systemPrompt(plain, {}, [])).not.toContain('delegate');
  });
});

describe('the fuel gate counts recorded helper spend', () => {
  it('a family that already spent the cap is killed before the next model call', async () => {
    const h = await createDb();
    await migrate(h.db);
    await seedIsolationOrgs(h.db);
    const s = spec({ fuel: { maxUsdPerRun: 0.5, hardStop: true } });
    const hash = harnessSpecHash(s);
    await createLabRun(h.db, { id: 'run-fanfuel', orgId: ORG_A, harnessHash: hash, harnessName: s.name, spec: s });
    // A prior leg's recorded delegate step: helpers spent $0.60 > the $0.50 cap.
    await h.db.insert(labRunSteps).values([
      { runId: 'run-fanfuel', orgId: ORG_A, seq: 1, kind: 'model', payload: { kind: 'model', responseText: '', finishReason: 'tool_calls', toolCalls: [{ id: 'c1', type: 'function', function: { name: 'delegate', arguments: '{"tasks":[{"goal":"g","doneDefinition":"d"}]}' } }], memoryReads: {}, requestPayload: { model: 'potion-auto', messages: [{ role: 'system', content: 'x' }, { role: 'user', content: 'Begin the mission.' }] }, estCostUsd: 0.01, clockMs: 0, rngSample: 0 },
      },
      { runId: 'run-fanfuel', orgId: ORG_A, seq: 2, kind: 'tool', payload: { kind: 'tool', toolName: 'delegate', toolInput: { tasks: [{ goal: 'g', doneDefinition: 'd' }] }, toolOutput: { ok: true, helpers: [{ runId: 'sub-x-1', state: 'completed', estUsd: 0.6, result: 'r', goal: 'g' }] }, clockMs: 0, rngSample: 0 } },
    ]);
    // A plain object, checked against the real signatures: runLeg takes
    // ServingClientLike, so a double no longer has to be a real client
    // pointed at an unroutable host.
    const client: ServingClientLike = {
      complete: async (_req: ServingRequest): Promise<ServingResult> => {
        throw new Error('the fuel gate must fire BEFORE any model call');
      },
      emitSpans: async () => true,
    };
    const out = await runLeg({ db: h.db, client, runId: 'run-fanfuel', orgId: ORG_A, spec: s, harnessHash: hash });
    expect(out.status).toBe('killed-budget');
    await h.close();
  }, 60_000);
});
