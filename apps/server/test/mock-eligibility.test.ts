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
import { MOCK_ELIGIBILITY_INVENTORY } from './fixtures/mock-eligibility-inventory.js';

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
      else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) out.push(full);
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
];

/** Files the patterns match but that carry no eligibility DECISION — pure
 * type/def/plumbing sites. Each needs a stated reason (the same discipline
 * the route sweep applies to its skips). */
const NOT_A_DECISION: Record<string, string> = {
  'packages/providers/src/mock.ts': 'the mock provider implementation itself',
  'packages/providers/src/index.ts': 're-exports only',
  'packages/core/src/types.ts': 'type definitions (ProviderId, ProviderMode)',
  'packages/db/src/schema.ts': "column defaults ('unknown'/'mock' literals), no resolution",
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
  'apps/server/src/shadow.ts': 'executes an already-resolved candidate set on the org provider set',
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
        `fixtures/mock-eligibility-inventory.ts: ${unclassified.join(', ')}`,
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
