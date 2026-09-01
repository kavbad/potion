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
    file: 'packages/pareto/src/serving.ts',
    symbol: 'DEFAULT_STRATEGY / liveDefaultStrategy / fallbackStrategyFor / servingDecisionFor',
    kind: 'default-strategy',
    mockPosture: 'excluded-live',
    regressionTest: 'apps/server/test/provenance.test.ts',
    notes:
      'G2.4 (fifth false-live instance, FIRST on the serving path; moved here from apps/server context.ts by ' +
      'the 2026-08-31 one-resolver P0): the mock-alias DEFAULT_STRATEGY is the fallback under MOCK only. A ' +
      'live server falls back to the designated live default (mock excluded) and refuses honestly when none ' +
      'resolves — it never answers with mock text on a live 200. servingDecisionFor composes the same guard + ' +
      'binding + resolution the serve path runs, so the compiler and the learning period inherit this posture.',
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
    file: 'apps/server/src/routing/compile-router.ts',
    symbol: 'compileAndMintRouter (servingDecisionFor)',
    kind: 'alias-guard',
    mockPosture: 'excluded-live',
    regressionTest: 'apps/server/test/router.test.ts',
    notes:
      'R1/R2, READ-ONLY: the router artifact is assembled by @potion/pareto servingDecisionFor — the SAME ' +
      'guard + operating-point resolution the serve path runs (mock-provenance frontiers discarded under live ' +
      'providers; the same fallbackStrategyFor). Nothing is served from here — the document records what ' +
      'serving WOULD do, and any non-live provenance is carried on the assignment and rendered as a visible ' +
      'badge, never laundered.',
  },
  {
    file: 'apps/server/src/routes/connection.ts',
    symbol: 'clusterReadiness (guardFrontierProvenance) + providersForOrg',
    kind: 'alias-guard',
    mockPosture: 'excluded-live',
    regressionTest: 'apps/server/test/connection.test.ts',
    notes:
      'SERVING-ROADMAP S1, READ-ONLY: reports readiness by running the SAME guard the serve path runs, so a ' +
      'mock-provenance frontier under live providers reports provenance=blocked and ready=false — the surface ' +
      'cannot claim routing the next request would not get. Reusing the guard (rather than counting frontier ' +
      'rows) is what makes the two incapable of disagreeing. providersForOrg is read only for the ' +
      'platform-vs-BYOK provider LISTS; no model is resolved and nothing is served from here.',
  },
  {
    file: 'apps/server/src/routes/plan.ts',
    symbol: 'POST /api/plan (guardFrontierProvenance + selectPoint)',
    kind: 'alias-guard',
    mockPosture: 'excluded-live',
    regressionTest: 'apps/server/test/plan.test.ts',
    notes:
      'SERVING-ROADMAP S2, READ-ONLY: recommends from the SAME guarded frontier the serve path would use, so ' +
      'under live providers a mock-provenance frontier reports measured=false and every option comes back ' +
      'infeasible-with-a-reason rather than recommending a strategy that would immediately fall back. ' +
      'Selection is core selectPoint — the serving selector, not a second implementation that could drift ' +
      'from it. Nothing is executed here: no provider is called and no model is resolved to a transport.',
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
    file: 'apps/server/src/routes/challengers.ts',
    symbol: 'apply (aggregatesFromEvalResults + servingDecisionFor)',
    kind: 'alias-guard',
    mockPosture: 'excluded-live',
    regressionTest: 'apps/server/test/challengers.test.ts',
    notes:
      'G1 promotion: mints an ORG frontier from the org\'s OWN suite measurements via the G1.8 rule — ' +
      'org-scoped, provenance-pure (providerMode = this server\'s mode, so mock rows never build a frontier a ' +
      'live server would serve; the serve-time guard re-checks regardless), one instrument. The post-apply ' +
      '"now serves" readback runs the same servingDecisionFor chain as serving.',
  },
  {
    file: 'apps/server/src/shadow.ts',
    symbol: 'runShadow (judge resolution)',
    kind: 'class-resolution',
    mockPosture: 'excluded-live',
    regressionTest: 'apps/server/test/shadow.test.ts',
    notes:
      'shadow:judge implemented in-process (2026-09-01, guarantee.ts precedent): each candidate is scored by ' +
      'defaultServeJudgeModel(ctx.providerMode) — a real judge class under live, the deterministic mock judge ' +
      'otherwise — on the org provider set, with spend metered as shadow_judge rows. Candidates themselves are ' +
      'an already-resolved set (frontier points / strategy_configs); a failed judge call records quality NULL, ' +
      'never a fake score.',
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
