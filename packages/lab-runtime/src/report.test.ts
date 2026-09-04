// Report v1 (Step 8): evidence before advice, proven three ways —
//  1. TAXONOMY COMPLETENESS BOTH DIRECTIONS: every StruggleEvidence code the
//     builder can emit has an UPGRADE_LADDER rung or the explicit 'none'
//     default, and every ladder rung names a code the builder can emit.
//  2. THE LADDER IS DETERMINISTIC: same rows → byte-identical report, and
//     the FIRST matching rung wins (not-connected beats budget-killed).
//  3. EST-VS-METERED NEVER BLENDS: a step with a resolved request_logs join
//     reports meteredUsd and contributes to meteredTotalUsd ONLY; a step
//     without one reports the labeled estimate and contributes to
//     estimatedUnmeteredUsd ONLY. No field mixes the two.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  appendLabStep,
  claimLabRun,
  createDb,
  createLabRun,
  insertRequestLog,
  migrate,
  seedIsolationOrgs,
  transitionLabRun,
  ORG_A,
  type DbHandle,
} from '@potion/db';
import { harnessSpecHash, type HarnessSpec } from '@potion/lab-spec';
import { buildRunReport } from './report.js';
import { buildStepPayload } from './checkpoint.js';

const ORG = ORG_A;

function spec(over: Partial<HarnessSpec> = {}): HarnessSpec {
  return {
    specVersion: 1,
    name: 'report harness',
    brain: { policy: { type: 'min_cost', qualityFloor: 0 } },
    mission: { kind: 'task', goal: 'do the thing', doneDefinition: 'done' },
    superpowers: [],
    memory: { enabled: false },
    rules: [],
    fuel: { maxUsdPerRun: 0.5, hardStop: true },
    checkIns: [],
    ...over,
  };
}

/** A terminal run with two model steps: one metered (request_logs row), one
 * unresolved (estimate only). */
async function seedRun(
  h: DbHandle,
  runId: string,
  s: HarnessSpec,
  terminal: 'completed' | 'killed-budget' | 'failed',
  reason?: string,
): Promise<void> {
  const hash = harnessSpecHash(s);
  await createLabRun(h.db, { id: runId, orgId: ORG, harnessHash: hash, harnessName: s.name, spec: s });
  const claim = await claimLabRun(h.db, { runId, orgId: ORG, expectedHarnessHash: hash, leaseMs: 60_000 });
  if (!claim.ok) throw new Error(`claim failed: ${claim.reason}`);
  const mk = (seq: number, completionId: string, text: string) =>
    appendLabStep(h.db, {
      runId,
      orgId: ORG,
      fence: claim.fence,
      seq,
      kind: 'model',
      payload: buildStepPayload({
        kind: 'model',
        slot: 'brain',
        requestPayload: { model: 'potion-auto', messages: [] },
        responseText: text,
        toolCalls: [],
        finishReason: 'stop',
        completionId,
        frontierTrace: 'cluster=x;strategy=abcd1234;frontier=v1;policy=min_cost;fallback=0;provenance=mock',
        usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
        clockMs: 1000 + seq,
        rngSample: 0.5,
      }),
      harnessHash: hash,
      leaseMs: 60_000,
      now: new Date(),
    });
  await mk(1, `cmpl-${runId}-metered`, 'working on it');
  await mk(2, `cmpl-${runId}-unresolved`, 'final answer text');
  // Only step 1 resolves in request_logs — $0.0123 metered truth.
  await insertRequestLog(h.db, {
    orgId: ORG,
    completionId: `cmpl-${runId}-metered`,
    model: 'mock-cheap',
    usage: { inputTokens: 100, outputTokens: 50, costUsd: 0.0123, latencyMs: 12 },
    latencyMs: 12,
  });
  await transitionLabRun(h.db, {
    runId,
    orgId: ORG,
    fence: claim.fence,
    to: terminal,
    ...(reason !== undefined ? { reason } : {}),
  });
}

describe('report v1 — taxonomy completeness (both directions)', () => {
  it('every emittable struggle code has a ladder rung; every rung names an emittable code', () => {
    const src = readFileSync(fileURLToPath(new URL('./report.ts', import.meta.url)), 'utf8');
    // Codes the union declares (the closed taxonomy).
    const unionCodes = [...src.matchAll(/\{ code: '([a-z-]+)';/g)].map((m) => m[1]!);
    // Codes the builder actually pushes.
    const emitted = [...src.matchAll(/struggles\.push\(\{\s*\n?\s*code: '([a-z-]+)'/g)].map((m) => m[1]!);
    const emittedInline = [...src.matchAll(/struggles\.push\(\{ code: '([a-z-]+)'/g)].map((m) => m[1]!);
    const allEmitted = new Set([...emitted, ...emittedInline]);
    // Rungs in the ladder (the UPGRADE_LADDER ARRAY only — slice from its
    // `= [` past the type annotation, whose `['code'];` would otherwise
    // terminate the slice early, to the closing `\n];` line).
    const declStart = src.indexOf('const UPGRADE_LADDER');
    const arrStart = src.indexOf('= [', declStart);
    const arrEnd = src.indexOf('\n];', arrStart);
    const ladderSrc = src.slice(arrStart, arrEnd);
    const rungs = [...ladderSrc.matchAll(/code: '([a-z-]+)'/g)].map((m) => m[1]!);
    // Direction 1: every emitted code is either a ladder rung or covered by
    // the explicit 'none' default (no orphan evidence).
    for (const code of allEmitted) {
      expect(rungs, `emitted struggle '${code}' has no upgrade rung`).toContain(code);
    }
    // Direction 2: every rung names a code the union declares (no dead rungs).
    for (const rung of rungs) {
      expect(unionCodes, `ladder rung '${rung}' is not a declared struggle code`).toContain(rung);
    }
    // And the union itself is fully rung-covered (the ladder can answer ANY
    // evidence the taxonomy can record).
    for (const code of unionCodes) {
      expect(rungs, `union code '${code}' has no ladder rung`).toContain(code);
    }
  });
});

describe('report v1 — deterministic ladder', () => {
  it('same rows → byte-identical report; first matching rung wins', async () => {
    const h = await createDb();
    await migrate(h.db);
    await seedIsolationOrgs(h.db);
    // BOTH evidences present: declared superpowers AND budget-killed. The
    // ladder must pick not-connected (rung 1), not budget-killed (rung 2).
    const s = spec({ superpowers: [{ id: 'calendar', scopes: ['read'] }] });
    await seedRun(h, 'run-ladder', s, 'killed-budget', 'fuel exhausted: est $0.5 >= maxUsdPerRun $0.5');
    const a = await buildRunReport(h.db, 'run-ladder', ORG);
    const b = await buildRunReport(h.db, 'run-ladder', ORG);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b)); // determinism
    expect(a!.struggles.map((x) => x.code)).toEqual(['not-connected-superpowers', 'budget-killed']);
    expect(a!.suggestedUpgrade.reason).toBe('not-connected-superpowers');
    expect(a!.suggestedUpgrade.text).toContain('calendar');
    await h.close();
  });

  it('no evidence → the explicit dial-rung default (exactly one upgrade, always)', async () => {
    const h = await createDb();
    await migrate(h.db);
    await seedIsolationOrgs(h.db);
    await seedRun(h, 'run-clean', spec(), 'completed');
    const r = await buildRunReport(h.db, 'run-clean', ORG);
    expect(r!.struggles).toEqual([]);
    expect(r!.suggestedUpgrade.reason).toBe('none');
    expect(r!.suggestedUpgrade.text).toContain('dial');
    await h.close();
  });
});

describe('report v1 — est vs metered NEVER blends', () => {
  it('resolved steps carry metered only; unresolved carry the labeled estimate only; totals stay separate', async () => {
    const h = await createDb();
    await migrate(h.db);
    await seedIsolationOrgs(h.db);
    await seedRun(h, 'run-cost', spec(), 'completed');
    const r = (await buildRunReport(h.db, 'run-cost', ORG))!;
    const resolved = r.steps.find((x) => x.seq === 1)!;
    const unresolved = r.steps.find((x) => x.seq === 2)!;
    // The resolved step: metered truth present.
    expect(resolved.meteredUsd).toBe(0.0123);
    // The unresolved step: metered null, the flat fuel estimate present
    // (150 tokens / 1000 × $0.01 = $0.0015 — the labeled figure).
    expect(unresolved.meteredUsd).toBeNull();
    expect(unresolved.estimatedUsd).toBeCloseTo(0.0015, 10);
    // Totals: metered sums ONLY resolved joins; the estimate pool sums ONLY
    // unresolved steps. Their sum appears NOWHERE in the report — there is
    // no blended field to leak into a UI.
    expect(r.meteredTotalUsd).toBe(0.0123);
    expect(r.estimatedUnmeteredUsd).toBeCloseTo(0.0015, 10);
    const keys = JSON.stringify(Object.keys(r));
    expect(keys).not.toContain('totalUsd'); // no blended total exists
    await h.close();
  });
});
