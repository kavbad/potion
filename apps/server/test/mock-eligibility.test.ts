// G2.4 Leg C — the mock-eligibility audit's OWN completeness argument.
//
// Provider-resolution sites are code locations, not routes, so this leg
// cannot borrow the route tree's completeness proof. Instead it RE-GREPS
// packages/*/src + apps/server/src for the resolution signatures and diffs
// the discovered files against the committed inventory: a new site added
// next month fails this suite by name, exactly as an unclassified route
// fails key-role-split.test.ts.
//
// The per-site behaviour is pinned by the regression tests named in each
// row (runner / live-sweep / suite-verify / provenance / calibrate /
// false-live) — referenced here, never duplicated.
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MOCK_ELIGIBILITY_INVENTORY } from '../src/security/mock-eligibility-inventory.js';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/** Every non-test .ts under the source trees the audit covers. */
function sourceFiles(): string[] {
  const roots = [
    path.join(REPO_ROOT, 'apps/server/src'),
    ...readdirSync(path.join(REPO_ROOT, 'packages'))
      .map((p) => path.join(REPO_ROOT, 'packages', p, 'src'))
      .filter((p) => {
        try {
          return statSync(p).isDirectory();
        } catch {
          return false;
        }
      }),
  ];
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      // The audit's OWN files quote every pattern by construction — scanning
      // them would be self-referential noise, not a resolution site.
      else if (
        entry.name.endsWith('.ts') &&
        !entry.name.endsWith('.test.ts') &&
        !full.includes(path.join('src', 'security'))
      ) {
        out.push(full);
      }
    }
  };
  for (const r of roots) walk(r);
  return out;
}

/** The signatures that constitute "this file resolves providers/models".
 * Adding a pattern here is how the audit widens; the diff below then forces
 * every newly-matched file into the inventory. */
const RESOLUTION_PATTERNS: RegExp[] = [
  /\bcreateProviders\s*\(/,
  /\bcreateRunProviders\s*\(/,
  /\bcreateMockProvider\s*\(/,
  /\bcreateResolver\s*\(/,
  /\bbuildRegistry\s*\(/,
  /\bclassRepresentative\s*\(/,
  /\bgenerateCandidates/,
  /\baggregatesFromEvalResults\s*\(/,
  /\bdefaultServeJudgeModel\s*\(/,
  /\bproviderModeOverride\b/,
  /'mock-(?:cheap|mid|frontier|judge)'/,
  /provider:\s*'mock'/,
  /provider\s*===\s*'mock'/,
  // G2.4 serving-path resolution symbols (the fifth false-live instance):
  /\bfallbackStrategyFor\s*\(/,
  /\bliveDefaultStrategy\s*\(/,
  /\bguardFrontierProvenance\s*\(/,
  // One-resolver P0 (2026-08-31): the composed serve decision — any caller
  // is by definition resolving what production would serve.
  /\bservingDecisionFor\s*\(/,
];

/** Files the patterns match but that carry no eligibility DECISION — pure
 * type/def/plumbing sites. Each needs a stated reason (the same discipline
 * the route sweep applies to its skips). */
const NOT_A_DECISION: Record<string, string> = {
  'packages/providers/src/mock.ts': 'the mock provider implementation itself',
  'packages/providers/src/index.ts': 're-exports only',
  'packages/core/src/types.ts': 'type definitions (ProviderId, ProviderMode)',
  'packages/db/src/schema.ts': "column defaults ('unknown'/'mock' literals), no resolution",
  'packages/db/src/rehearse-postgres.ts':
    'deployment rehearsal harness; the mock literals are seeded ROW VALUES ' +
    "(provider:'mock', providerMode:'mock') in fixture data, and it never " +
    'constructs or resolves a provider — it makes no provider calls at all',
  'packages/db/src/repos/eval-results.ts': "narrows the stored mode string; never resolves a provider",
  'packages/db/src/repos/research.ts': 'SQL pins provider_mode; no provider resolution',
  'packages/harness/src/suites.ts': 'suite loading; mock aliases appear only inside fixture data',
  'packages/harness/src/scorers.ts': 'judge invocation through an already-resolved provider set',
  'packages/harness/src/estimate.ts': 'cost projection only',
  'packages/harness/src/aggregate.ts': 'statistics over recorded rows',
  'packages/cluster/src/evaluate.ts': 'embedder-only provider set (mock|openai), not model routing',
  'packages/cluster/src/rebuild-centroids.ts': 'embedder-only provider set',
  'packages/pareto/src/demo.ts': 'demo script, hard-coded mock mode',
  'packages/pareto/src/dominance.ts': 'carries providerMode through unchanged',
  'apps/server/src/seed.ts': 'seeds mock-provenance demo data, honestly labelled',
  'packages/researcher/src/generate.ts': 'consumes the registry it is HANDED — the caller filters (see handlers.ts rows)',
  'packages/researcher/src/gate.ts': 'promotion statistics; no resolution',
  'packages/workers/src/index.ts': 'worker wiring only',
  'apps/server/src/routes/dashboard.ts': 'reports provider_mode for badging; no resolution',
  'apps/server/src/routes/share.ts': 'reports provider_mode for badging; no resolution',
  'apps/server/src/routes/openai-parity.ts': 'shares chat.ts resolution (inventoried there)',
  'apps/server/src/routes/traces.ts': 'ingest pricing lookup; no provider selection',
  'apps/server/src/routes/research.ts': 'enqueues jobs; resolution happens in the worker',
  'apps/server/src/routes/rubrics.ts': 'enqueues jobs; resolution happens in the worker',
  'packages/providers/src/mock/mock.ts': 'the mock provider implementation itself',
  'apps/server/src/routes/guarantee.ts': 'reads guarantee config/incidents; judge resolution lives in src/guarantee.ts',
  'apps/server/src/incumbents/roster.ts': 'names incumbents from the price table for onboarding; skips mock aliases; no resolution',
  'packages/workers/src/workload-discovery.ts':
    'per-workload measurement rides the SAME resolution the learning period uses (resolveEvalJudge — ' +
    'inventoried via learning-period; serving pick via @potion/pareto servingDecisionFor, inventoried there); ' +
    'suites run via runEval on the org provider set with harness alias guards',
  'packages/workers/src/learning-period.ts':
    'the serving pick comes from @potion/pareto servingDecisionFor (inventoried there); suites run via runEval ' +
    'on the org provider set with harness alias guards (MockAliasInLiveRunError), and the live judge is the ' +
    'reachable classRepresentative — the same excluded-live posture the handlers.ts rows pin',
  'apps/server/src/context.ts':
    'provider-set construction (createProviders/createResolver) over the price table — transports, not ' +
    'eligibility; the serving defaults (DEFAULT_STRATEGY/liveDefaultStrategy/fallbackStrategyFor) moved to ' +
    '@potion/pareto serving.ts (inventoried there) and are re-exported here unchanged',
};

describe('mock-eligibility inventory completeness (grep-derived)', () => {
  const files = sourceFiles();

  it('scans a plausible source tree', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it('every file that resolves providers/models is either inventoried or justified', () => {
    const matched = files
      .filter((f) => {
        const src = readFileSync(f, 'utf8');
        return RESOLUTION_PATTERNS.some((re) => re.test(src));
      })
      .map((f) => path.relative(REPO_ROOT, f));

    const inventoried = new Set(MOCK_ELIGIBILITY_INVENTORY.map((r) => r.file));
    const unclassified = matched.filter(
      (f) => !inventoried.has(f) && NOT_A_DECISION[f] === undefined,
    );
    expect(
      unclassified,
      'provider-resolution sites with NO inventory row and no stated exemption — classify them in ' +
        `src/security/mock-eligibility-inventory.ts: ${unclassified.join(', ')}`,
    ).toEqual([]);

    // …and the inventory has no phantom rows.
    const stale = [...inventoried].filter((f) => !matched.includes(f));
    expect(stale, `inventory rows whose file no longer resolves providers: ${stale.join(', ')}`).toEqual([]);
  });

  it('every exemption is justified and every inventory row is complete', () => {
    for (const [file, reason] of Object.entries(NOT_A_DECISION)) {
      expect(reason.length, `${file} exempted without a reason`).toBeGreaterThan(10);
    }
    for (const row of MOCK_ELIGIBILITY_INVENTORY) {
      expect(row.notes.length, `${row.file}:${row.symbol} has no notes`).toBeGreaterThan(20);
      // Anything not actively excluded/refusing must explain why it is safe.
      if (row.mockPosture === 'mode-blind' || row.mockPosture === 'test-seam') {
        expect(
          /guard|test|upstream|no non-test caller|contract/i.test(row.notes),
          `${row.file}:${row.symbol} is ${row.mockPosture} without saying what makes it safe`,
        ).toBe(true);
      }
    }
  });

  it('the four historical false-live instances plus the two G2.4 ones are all represented', () => {
    const bySymbol = (needle: string) =>
      MOCK_ELIGIBILITY_INVENTORY.find((r) => r.symbol.includes(needle));
    // G1.5 classRepresentative, G1.7 reachable + runner refusal, pareto filter
    expect(bySymbol('classRepresentative')?.mockPosture).toBe('excluded-live');
    expect(bySymbol('frontierLiveSweepHandler')?.mockPosture).toBe('excluded-live');
    expect(bySymbol('MockAliasInLiveRunError')?.mockPosture).toBe('refuses-live');
    expect(bySymbol('aggregatesFromEvalResults')?.mockPosture).toBe('excluded-live');
    // G2.4: the scan stamp and the SERVING-path default (the fifth instance)
    expect(bySymbol('diffModelListings')?.mockPosture).toBe('excluded-live');
    expect(bySymbol('liveDefaultStrategy')?.mockPosture).toBe('excluded-live');
    expect(bySymbol('liveDefaultStrategy')?.notes).toMatch(/serving path/i);
  });
});
