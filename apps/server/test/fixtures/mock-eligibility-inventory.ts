// THE MOCK-ELIGIBILITY INVENTORY (G2.4) — every provider-resolution site in
// the monorepo, classified for the FALSE-LIVE question: can a MOCK provider,
// alias or entry be selected, executed or recorded while the surrounding
// mode is 'live'?
//
// This is a SEPARATE leg from the route inventory on purpose: these sites are
// code locations across packages, not HTTP routes, so the completeness
// argument is grep-derived (mock-eligibility.test.ts re-greps src/ and diffs
// against this list both ways — a new resolution site fails the suite by
// name) rather than route-tree-derived.
//
// mockPosture:
//   'excluded-live'        — the site actively filters mock out under live
//                            (reachable()/excludeProvider/namespace guards).
//   'refuses-live'         — the site REFUSES rather than degrade
//                            (MockAliasInLiveRunError and friends).
//   'mock-allowed-by-design' — mock IS the point (mock-mode sweeps, fixtures)
//                            and the value is recorded honestly as mock.
//   'test-seam'            — reachable only from tests; documented, no
//                            production caller.
//   'mode-blind'           — carries no mode; safe ONLY because every caller
//                            is guarded upstream (the note says which).

export interface MockEligibilityRow {
  /** repo-relative file. */
  file: string;
  /** the function/const that does the resolving. */
  symbol: string;
  kind:
    | 'factory'
    | 'registry-build'
    | 'class-resolution'
    | 'alias-guard'
    | 'aggregation-filter'
    | 'scan-stamp'
    | 'byok-validate'
    | 'default-strategy'
    | 'mode-override';
  mockPosture:
    | 'excluded-live'
    | 'refuses-live'
    | 'mock-allowed-by-design'
    | 'test-seam'
    | 'mode-blind';
  /** existing test that pins this site (referenced, not duplicated). */
  regressionTest?: string;
  notes: string;
}

export const MOCK_ELIGIBILITY_INVENTORY: MockEligibilityRow[] = [
  // ---- the systemic root: every provider set carries a mock transport ----
  {
    file: 'packages/providers/src/factory.ts',
    symbol: 'createProviders',
    kind: 'factory',
    mockPosture: 'mode-blind',
    notes:
      'ALWAYS returns a working mock transport at key `mock`, including in live sets. Safe only because ' +
      'every ALIAS path that could route to it is guarded (runner MockAliasInLiveRunError, the reachable() ' +
      'registry filters, and the G2.4 live serving default). Changing this to mode-aware is a larger ' +
      'refactor; the alias-level guards are the enforced contract.',
  },
  {
    file: 'packages/strategies/src/resolve.ts',
    symbol: 'createResolver',
    kind: 'factory',
    mockPosture: 'mode-blind',
    notes:
      'alias → price entry → providers[entry.provider]; a mock-provider entry resolves to the mock transport. ' +
      'Guarded upstream by the alias guards below.',
  },

  // ---- registry construction + class resolution ----
  {
    file: 'packages/researcher/src/registry.ts',
    symbol: 'buildRegistry',
    kind: 'registry-build',
    mockPosture: 'mock-allowed-by-design',
    regressionTest: 'packages/researcher/src/registry.test.ts',
    notes: 'mock aliases stay in by design (mock research cycles); live callers filter provider.',
  },
  {
    file: 'packages/researcher/src/registry.ts',
    symbol: 'classRepresentative',
    kind: 'class-resolution',
    mockPosture: 'excluded-live',
    regressionTest: 'packages/researcher/src/registry.test.ts',
    notes:
      'cheapest-first, so $0 mock entries WIN every class unless excluded — the G1.5 finding. ' +
      'excludeProvider(\'mock\') is the live-mode contract.',
  },
  {
    file: 'packages/workers/src/handlers.ts',
    symbol: 'researchCycleHandler (candidate registry)',
    kind: 'registry-build',
    mockPosture: 'excluded-live',
    regressionTest: 'packages/workers/src/false-live.test.ts',
    notes:
      'G2.4: a live cycle builds candidates over the reachable() registry only, and refuses when no ' +
      'provider key is present. Pre-G2.4 it generated mock-alias candidates and died mid-run, leaving ' +
      'its ledger row stuck at running.',
  },
  {
    file: 'packages/workers/src/handlers.ts',
    symbol: 'rubricGenerateHandler (classRepresentative)',
    kind: 'class-resolution',
    mockPosture: 'excluded-live',
    notes: "G1.5: excludeProvider = providerMode === 'live' ? 'mock' : undefined.",
  },
  {
    file: 'packages/workers/src/handlers.ts',
    symbol: 'frontierLiveSweepHandler (reachable filter)',
    kind: 'registry-build',
    mockPosture: 'excluded-live',
    regressionTest: 'packages/workers/src/live-sweep.test.ts',
    notes: 'G1.7: registry filtered by reachable() — non-mock AND an env key present; refuses when empty.',
  },
  {
    file: 'packages/workers/src/handlers.ts',
    symbol: 'guaranteeSuiteVerifyHandler (judge resolution)',
    kind: 'class-resolution',
    mockPosture: 'excluded-live',
    regressionTest: 'packages/workers/src/suite-verify.test.ts',
    notes: 'G2.1: the live branch resolves a reachable judge or throws; mock mode uses the suite-stamped judge and STAMPS the verdict mock.',
  },
  {
    file: 'packages/workers/src/handlers.ts',
    symbol: 'tracesClusterHandler (suite judge + strategies)',
    kind: 'class-resolution',
    mockPosture: 'mock-allowed-by-design',
    notes:
      'the synthesis sweep is hard-coded provider:mock, and the judge alias it stamps into the derived ' +
      'suite is honest mock provenance; live re-evaluation overrides the judge (suite-verify) or refuses ' +
      '(MockAliasInLiveRunError).',
  },

  // ---- alias guards (the refusal layer) ----
  {
    file: 'packages/harness/src/runner.ts',
    symbol: 'MockAliasInLiveRunError',
    kind: 'alias-guard',
    mockPosture: 'refuses-live',
    regressionTest: 'packages/harness/src/runner.test.ts',
    notes: 'G1.7: a live run refuses BEFORE any call when a strategy OR judge alias resolves to the mock provider.',
  },
  {
    file: 'packages/harness/src/calibrate.ts',
    symbol: 'runJudgeCalibration (providerMode guard)',
    kind: 'alias-guard',
    mockPosture: 'refuses-live',
    regressionTest: 'packages/harness/src/calibrate.test.ts',
    notes:
      'G2.4: a live-RECORDED calibration refuses mock judges AND the mock-cheap default answerer. Pre-G2.4 ' +
      '`--provider live` without --calibrate-answerer stamped mock-generated answers provider_mode=live.',
  },
  {
    file: 'packages/harness/src/runner.ts',
    symbol: 'providerModeOverride',
    kind: 'mode-override',
    mockPosture: 'test-seam',
    regressionTest: 'packages/harness/src/provenance.test.ts',
    notes:
      'lets a run STAMP a mode the transports do not have — false-live by construction. No non-test caller ' +
      '(verified by grep); used to simulate live rows without network.',
  },

  // ---- serving path ----
  {
    file: 'apps/server/src/context.ts',
    symbol: 'DEFAULT_STRATEGY / liveDefaultStrategy / fallbackStrategyFor',
    kind: 'default-strategy',
    mockPosture: 'excluded-live',
    regressionTest: 'apps/server/test/provenance.test.ts',
    notes:
      'G2.4 (fifth false-live instance, FIRST on the serving path): the mock-alias DEFAULT_STRATEGY is the ' +
      'fallback under MOCK only. A live server falls back to the designated live default (mock excluded) and ' +
      'refuses honestly when none resolves — it never answers with mock text on a live 200.',
  },
  {
    file: 'apps/server/src/routes/chat.ts',
    symbol: 'guardFrontierProvenance',
    kind: 'alias-guard',
    mockPosture: 'excluded-live',
    regressionTest: 'apps/server/test/provenance.test.ts',
    notes: 'M1a: a live server never serves a mock-provenance frontier; the request takes the (now live) fallback.',
  },
  {
    file: 'apps/server/src/routes/playground.ts',
    symbol: 'resolvePlaygroundPoint',
    kind: 'default-strategy',
    mockPosture: 'excluded-live',
    notes: 'G2.4: shares the serving path’s mode-aware fallback; refuses when no live strategy resolves.',
  },
  {
    file: 'apps/server/src/routes/keys.ts',
    symbol: 'PostKeyBodySchema (provider enum)',
    kind: 'byok-validate',
    mockPosture: 'excluded-live',
    regressionTest: 'apps/server/test/keys.test.ts',
    notes:
      "G2.4: 'mock' is no longer an accepted BYOK provider id. Pre-G2.4 a customer could register a mock key, " +
      'have it validate ok:true under a live server (the factory always carries a mock transport), and hold a ' +
      'custody-audited "verified" credential that serves nothing real.',
  },
  {
    file: 'apps/server/src/guarantee.ts',
    symbol: 'runGuaranteeSample (judge resolution)',
    kind: 'class-resolution',
    mockPosture: 'excluded-live',
    regressionTest: 'apps/server/test/guarantee.test.ts',
    notes:
      "resolves guarantee.judgeModel ?? defaultServeJudgeModel(ctx.providerMode) — under live that is a real " +
      'judge class. A policy that NAMES a mock judge alias explicitly is honoured as configured and the ' +
      'sample records which judge scored it (scorer/judge_model columns), so the evidence is never ' +
      'mislabelled; tightening explicit mock judges under live is filed for G2.6.',
  },
  {
    file: 'packages/harness/src/cli.ts',
    symbol: 'potion-harness --provider (calibration + run wiring)',
    kind: 'alias-guard',
    mockPosture: 'refuses-live',
    regressionTest: 'packages/harness/src/calibrate.test.ts',
    notes:
      'G2.4: threads --provider into runJudgeCalibration as providerMode, so a live-recorded calibration ' +
      'refuses mock judges/answerers; run mode already refuses via MockAliasInLiveRunError.',
  },
  {
    file: 'packages/harness/src/serve-judge.ts',
    symbol: 'defaultServeJudgeModel',
    kind: 'class-resolution',
    mockPosture: 'excluded-live',
    regressionTest: 'packages/harness/src/serve-judge.test.ts',
    notes: "returns judge-class under live, mock-judge otherwise — the ONLY production caller passes ctx.providerMode ('mock'|'live', never 'unknown').",
  },

  // ---- provenance of recorded evidence ----
  {
    file: 'packages/providers/src/scan.ts',
    symbol: 'diffModelListings / isMockListingId',
    kind: 'scan-stamp',
    mockPosture: 'excluded-live',
    regressionTest: 'packages/workers/src/false-live.test.ts',
    notes:
      'G2.4: mock/* listings keep provider mock. Pre-G2.4 every scanned listing was stamped openrouter, so the ' +
      'mock fixtures entered the registry INVISIBLE to every provider===mock guard and were eligible as live ' +
      'class representatives.',
  },
  {
    file: 'packages/pareto/src/recompute.ts',
    symbol: 'aggregatesFromEvalResults (providerMode filter)',
    kind: 'aggregation-filter',
    mockPosture: 'excluded-live',
    regressionTest: 'packages/pareto/src/provenance.test.ts',
    notes: 'G1.7: live aggregation filters to live rows so a frontier never mixes mock and live evidence.',
  },
  {
    file: 'packages/pareto/src/recompute.ts',
    symbol: 'hasLiveEvidence',
    kind: 'aggregation-filter',
    mockPosture: 'excluded-live',
    regressionTest: 'packages/workers/src/live-sweep.test.ts',
    notes: '“once live, never regress”: after live evidence exists, mock recomputes must not clobber the frontier.',
  },
];
