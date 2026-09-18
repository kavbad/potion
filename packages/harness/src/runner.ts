// Eval runner (SPEC §5): load suites → preflight budget projection (REFUSE
// when over cap) → execute each (strategy × item) via @potion/strategies →
// score → persist EvalResults to the content-addressed eval_results cache
// (resume skips hits) → aggregate per strategy into StrategyAggregate.
import { randomUUID } from 'node:crypto';
import {
  sha256,
  strategyHash,
  type EvalItem,
  type EvalResult,
  type PriceTable,
  type ProviderId,
  type ProviderMode,
  type ScoringMethod,
  type StrategyAggregate,
  type StrategyConfig,
  type Usage,
} from '@potion/core';
import {
  loadDerivedSuite, createDb, getLiveEvalResultByCacheKey, upsertEvalResult, migrate, type DbHandle } from '@potion/db';
import {
  createMockProvider,
  createProviders,
  loadPrices,
  type Provider,
} from '@potion/providers';
import { createResolver, execute } from '@potion/strategies';
import { aggregateResults } from './aggregate.js';
import { executeJourney } from './journey.js';
import { BudgetCapError, projectRunCostUsd } from './estimate.js';
import { loadSuitesV2 } from './ingest/suite-v2.js';
import { crossCheckItem, type SuiteManifest } from './ingest/manifest.js';
import { meteredProviders, type SpendSink } from './metered-providers.js';
import { scoreAnswer } from './scorers.js';
import { loadSuiteFile, resolveSuite } from './suites.js';
import { programModels } from '@potion/core';

/**
 * Thrown by runEval when a suite resolves under suites/simulated/ without an
 * explicit simulatedOk opt-in. Simulated suites are derived from the mock
 * eval corpus (packages/providers/src/mock/eval-corpus.ts), so results on
 * them measure the mock's corruption model — never real-world quality.
 */
export class SimulatedSuiteError extends Error {
  constructor(public readonly simulatedSuiteIds: string[]) {
    super(
      `simulated suite refusal: suite(s) ${simulatedSuiteIds.map((s) => `'${s}'`).join(', ')} ` +
        'live under suites/simulated/ — they were GENERATED from the mock eval corpus ' +
        '(packages/providers/src/mock/eval-corpus.ts) and are coupled to the mock by ' +
        'construction. They are TEST/CI SIMULATION ONLY and can never be evidence of ' +
        'real-world quality. Re-run with simulatedOk / --simulated-ok to acknowledge ' +
        'this provenance issue.',
    );
    this.name = 'SimulatedSuiteError';
  }
}

export interface RunOptions {
  /** The instrument the cells are measured on (G): stamped on every result. */
  instrument?: 'default' | 'tools' | 'vision' | 'audio';
  suiteIds: string[];
  /** v2 suites (suites/v2/<id>/manifest.json + items) loaded through the v2
   * loader with manifest cross-checks (ROADMAP M1a). */
  suiteV2Ids?: string[];
  /** 'confirmation' unlocks LOCKED suites for the final promotion reading;
   * everything else runs as 'search' and locked suites refuse to load. */
  suitePurpose?: 'search' | 'confirmation';
  strategies: StrategyConfig[];
  budgetCapUsd: number;
  provider?: 'mock' | 'live';
  resume?: boolean;
  /**
   * Contain a mid-run provider failure to the STRATEGY it hit, instead of
   * failing the whole run (default false — serving-adjacent callers and every
   * existing test keep throw-on-error semantics).
   *
   * WHY THE STRATEGY IS THE CONTAINMENT UNIT. Found by the tranche campaign:
   * one slow model timing out killed entire 31-candidate legs — five legs of
   * real spend bought zero evidence because the 29th candidate was flaky.
   * Per-ITEM containment is the tempting alternative and it is dishonest:
   * scoring a strategy on only the items that happened to complete biases
   * quality upward, because timeouts correlate with hard items. So a failing
   * strategy is dropped WHOLE — recorded in failedStrategies, partial rows
   * left in the cache for a cheap retry, everything else proceeds.
   */
  containStrategyFailures?: boolean;
  /**
   * Per-attempt provider timeout for THIS run. Absent → the provider
   * default (60s), which is right for serving and wrong for a long
   * evaluation generation. Declared here rather than read from the
   * environment so it cannot silently fail to propagate.
   */
  providerTimeoutMs?: number;
  /** Observatory canaries: forces fresh execution by salting the cache key
   *  (see cacheKeyOf). Unset = normal content-addressed resume. */
  cacheSalt?: string;
  /**
   * Scope the salt to these strategy hashes ONLY. The 2026-09-02 retire leg
   * proved why an unscoped salt is a trap for surgical runs: carry-forward
   * looks incumbents up through the run's cache keys, so salting every cell
   * silently re-measured all nine extraction survivors live (360 executed /
   * 0 cached) and drifted their published quality — the exact opposite of
   * "survivors carry forward verbatim". With this set, listed strategies get
   * fresh cells; every other strategy keeps its unsalted key and its $0
   * resume. Unset = the salt applies to all (Observatory canary semantics).
   */
  cacheSaltStrategies?: string[];
  /**
   * Retry attempts after the first, for THIS run. Absent → the provider
   * default (3).
   *
   * The default is tuned for serving, where a retry budget is latency a user
   * is waiting through: 3 attempts over roughly 1.75s of backoff. A campaign
   * has the opposite economics — it has already bought the tokens, nobody is
   * waiting, and giving up on a transient connection blip throws away a
   * candidate's whole measurement.
   *
   * Measured: the tranche run lost three candidates to
   * "network error after 3 retries: fetch failed", two of them on the FIRST
   * call. Execution is strictly sequential here, so those were not a
   * concurrency storm — just an impatient retry budget meeting a flaky
   * moment.
   */
  providerMaxRetries?: number;
  /**
   * Cells of ONE strategy executed concurrently (2026-09-18). Default 1 —
   * the serial loop every existing run and test is measured under. The
   * platform sweep runs 4: a 37-candidate leg at ~19s per cell (answer +
   * live judge) took five hours serially. Strategies stay sequential, results
   * keep item order, and containment still drops the whole strategy — the
   * only visible difference is wall clock and that the spend belt can
   * overshoot by at most (concurrency − 1) cells past the cap.
   */
  cellConcurrency?: number;
  /** Explicit acknowledgement required to run suites from suites/simulated/. */
  simulatedOk?: boolean;
  /** Explicit provenance override (tests). Default: detected from the
   * provider set via detectProviderMode. */
  providerModeOverride?: ProviderMode;
  /** Tenant attribution (G1.6): stamped onto every eval_results row and the
   * eval run. Absent = platform evidence. Also a cache-key component (G1.7)
   * — org evidence never cache-crosses tenants. */
  orgId?: string;
  /** G1.7: judge completion budget for llm-judge scoring (default the
   * 128-token protocol cap). Verbose live judges (sonnet-class) truncate
   * below ~768 → parse-fail → quality 0 (G1.1 finding). The preflight
   * projection binds to the SAME value. */
  judgeMaxTokens?: number;
  /** G1.7: replace every llm-judge item's judgeModel before projection and
   * scoring (derived suites bake the nightly mock judge alias; live sweeps
   * override to a real judge class). Flows into the cache key + scorer
   * label naturally via the item transform. */
  judgeModelOverride?: string;
  /**
   * Output ceiling for answer calls (provider max_tokens), threaded into the
   * strategy ExecContext AND the preflight projection so the bound is
   * enforced, never assumed. Default: the provider layer's
   * DEFAULT_MAX_TOKENS. Raise for long-output workloads (M1b evidence:
   * agentic-tool-use answers reached 1501 tokens at quality 0.94 — a silent
   * default cap would truncate the BEST answers; see SUITE_OUTPUT_CEILINGS).
   */
  maxOutputTokens?: number;
  /**
   * Lab Step 5: deterministic sample — sort the run's items by id
   * (lexicographic, byte-stable) and keep the first N. Applied BEFORE the
   * false-live guard and the preflight projection so both bind to the set
   * that actually runs. Because cache keys are per item id, a later full
   * run over the same suite reuses every sampled cell and pays only for the
   * remainder.
   */
  itemSampleN?: number;
}

/** Injectable seams for tests/CLI (all optional). */
export interface RunDeps {
  db?: DbHandle;
  suitesDir?: string;
  suitesV2Dir?: string;
  pricesPath?: string;
  /**
   * Provider set override — TEST SEAM. Lets a suite inject a provider that
   * fails deterministically for one model, which is the only way to exercise
   * containStrategyFailures without a network: an unknown alias dies at
   * PREFLIGHT (estimate resolution), so no price-table trick can produce a
   * mid-execution failure. No production caller passes this.
   */
  providers?: Record<ProviderId, Provider>;
  /**
   * The resolved price table, when the caller already has one (S5).
   *
   * Takes precedence over `pricesPath`. The registry moved into the database,
   * so a caller that just discovered a model has a table the FILE does not
   * contain — and re-reading the file here would make that model unevaluable
   * until someone committed it, which is the redeploy-shaped bug S5 exists to
   * remove. `pricesPath` stays for the CLI and for tests that genuinely mean
   * "the file".
   */
  prices?: PriceTable;
  /** Per-call spend metering (post-capstone item 1): when present, the run's
   * provider set is wrapped with meteredProviders so EVERY successful
   * complete() — strategy and judge alike — reports its spend before the
   * response returns. Cache hits short-circuit before any provider call, so
   * they meter zero by construction. */
  spendSink?: SpendSink;
}

/** An item the runner deliberately did not execute (with the reason). */
export interface FailedStrategy {
  strategyHash: string;
  /** The item whose cell failed. */
  itemId: string;
  error: string;
  /** Cells that had completed before the failure (their rows stay in the
   *  content-addressed cache, so a retry resumes rather than re-pays). */
  completedCells: number;
}

export interface SkippedItem {
  itemId: string;
  reason: string;
}

/** Items the runner cannot execute yet. Currently: code-exec items with
 * language 'python' — the python-exec scorer is a documented TODO. */
export function unrunnableReason(item: EvalItem): string | null {
  if (item.scoring.kind === 'code-exec' && item.scoring.language === 'python') {
    return `code-exec language 'python' is not supported yet (python-exec scorer is a documented TODO)`;
  }
  return null;
}

/** SPEC §5 RunSummary, plus observability extras (projection, cache stats, results). */
export interface RunSummary {
  runId: string;
  aggregates: StrategyAggregate[];
  /**
   * EVIDENCE cost: Σ usage.costUsd over every result row in this summary,
   * INCLUDING resume cache hits (their stored historical cost). This is what
   * the evidence would have cost to produce — it is NOT what this run spent.
   * Billing from this number is the filed over-metering instance (a fully
   * cached re-verify "spent" $1.1045 with zero provider calls); bill from
   * executedSpendUsd / the per-call metered record instead.
   */
  spendUsd: number;
  /**
   * What THIS run actually spent: Σ (strategy + judge) cost over EXECUTED
   * items only — cache hits contribute nothing. Completion reconciles this
   * against the per-call metered record (Σ SpendSink rows); the two differ
   * only by rounding accumulation order (per-call rounding vs helpers'
   * round-per-accumulation), bounded well under 1e-5 per run.
   */
  executedSpendUsd: number;
  /**
   * Judge-scoring spend included in spendUsd: Σ over this run's EXECUTED
   * llm-judge scorer calls (scorerUsage.costUsd). 0 for runs with no
   * llm-judge items. Caveat: resume cache-hits reuse stored rows, which do
   * retain the split on scorerUsage since 2026-08-23; older cached cells fold
   * (via usage.costUsd) but cannot be re-attributed here.
   */
  judgeSpendUsd: number;
  projectedSpendUsd: number;
  executed: number;
  cacheHits: number;
  skipped: SkippedItem[];
  /**
   * Strategies dropped MID-RUN by containStrategyFailures (empty otherwise).
   * Their partial results are excluded from `results` and `aggregates` — a
   * strategy scored on only the items that happened to complete would carry
   * a biased quality (timeouts correlate with hard items) — but their spend
   * is NOT excluded: see abandonedSpendUsd.
   */
  failedStrategies: FailedStrategy[];
  /**
   * Real money spent on cells of strategies that later failed out. Folded
   * into spendUsd, never subtracted: the belt accounts for dollars burned,
   * not dollars that produced evidence. Hiding abandoned spend is how a
   * campaign "under budget" costs more than its ledger says.
   */
  abandonedSpendUsd: number;
  results: EvalResult[];
  /** True when any suite in the run came from suites/simulated/ (mock-corpus
   * provenance). Downstream consumers MUST surface this marker — simulated
   * results are never evidence of real-world quality. */
  simulated: boolean;
  /** Provenance of every number in this summary (M1a). */
  providerMode: ProviderMode;
}

/** Every model alias a strategy can call (for modelVersions bookkeeping). */
export function strategyModels(strategy: StrategyConfig): string[] {
  switch (strategy.type) {
    case 'single':
      return [strategy.model];
    case 'cascade':
      return strategy.stages.map((s) => s.model);
    case 'best-of-n':
      return [strategy.model, strategy.judge.model];
    case 'draft-verify':
      return [strategy.draftModel, strategy.verifierModel];
    case 'ensemble':
      return [...strategy.models, ...(strategy.fusion.judge ? [strategy.fusion.judge.model] : [])];
    case 'decompose':
      return [
        strategy.decomposerModel,
        ...Object.values(strategy.routing),
        ...(strategy.fusion?.judge ? [strategy.fusion.judge.model] : []),
      ];
    case 'composite': // M3 #23 (SPEC §12.6)
      return [strategy.startModel, strategy.upgradeModel];
    case 'program':
      return programModels(strategy.body);
  }
}

/** Providers for a run: 'mock' puts the deterministic mock behind EVERY provider
 * id (so live-priced aliases still cost against their real price entries while
 * answering deterministically); 'live' builds the real factory (API keys). */
export function createRunProviders(
  mode: 'mock' | 'live',
  prices: PriceTable,
  timeoutMs?: number,
  maxRetries?: number,
): Record<ProviderId, Provider> {
  if (mode === 'live') {
    // EXPLICIT beats ambient. POTION_PROVIDER_TIMEOUT_MS exists as a
    // deployment default, but a campaign that NEEDS a longer per-attempt
    // timeout must say so in its own options rather than hope an env var
    // survives the trip through three packages — the tranche run set the
    // variable, the transport still used the 60s default, and no amount of
    // reading the chain explained it. A declared value cannot go missing.
    return createProviders({
      prices,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(maxRetries !== undefined ? { maxRetries } : {}),
    });
  }
  const mock = createMockProvider(prices);
  return { anthropic: mock, openai: mock, google: mock, openrouter: mock, mock };
}

/**
 * Provenance of a provider set (M1a): the mock world puts the SAME
 * deterministic mock instance behind every provider id (see
 * createRunProviders / server context pickProviders); any set with a
 * distinct non-mock transport behind a real provider id is 'live'.
 */
export function detectProviderMode(providers: Record<ProviderId, Provider>): ProviderMode {
  const realIds = ['anthropic', 'openai', 'google', 'openrouter'] as const;
  return realIds.every((id) => providers[id] === providers.mock) ? 'mock' : 'live';
}

function modelVersionsFor(strategy: StrategyConfig, prices: PriceTable): Record<string, string> {
  const out: Record<string, string> = {};
  for (const alias of strategyModels(strategy)) {
    const entry = prices.entries.find((e) => e.alias === alias || e.model === alias);
    const resolved = entry?.model ?? alias;
    out[alias] = entry?.provider === 'mock' ? `${resolved}#mock-v1` : resolved;
  }
  return out;
}

/** judgeVersion component of the cacheKey (SPEC §5): resolved judge model
 * PLUS rubric identity for llm-judge scorers; 'none' for deterministic
 * scorers. The rubric hash (G1.5) makes a rubric edit a DIFFERENT scoring
 * harness — before 0022, editing a rubric in place silently reused scores
 * judged under the old wording. One-time llm-judge cache invalidation on
 * upgrade is deliberate; deterministic-scorer keys are unchanged. */
function judgeVersionOf(scoring: ScoringMethod, prices: PriceTable): string {
  // The deterministic scorers are part of the instrument too: when their
  // rule changes, cells scored under the old rule must not re-certify as
  // cache hits (evalResults keeps no answer text to re-score). `exact@2` =
  // scoreExact tolerates sentence-final punctuation and a shown-work final
  // line (2026-09-17); every exact cell re-executes once on the next sweep.
  if (scoring.kind === 'exact') return 'exact@2';
  if (scoring.kind !== 'llm-judge') return 'none';
  const entry = prices.entries.find(
    (e) => e.alias === scoring.judgeModel || e.model === scoring.judgeModel,
  );
  const resolved = entry?.model ?? scoring.judgeModel;
  return `${resolved}|rubric:${sha256(scoring.rubric).slice(0, 16)}`;
}

/**
 * Content-addressed eval cache key. G1.7 components (owner-mandated,
 * resolving the recorded G1.6 flag): `|org:<orgId>` is appended when the
 * run is org-attributed and `|live` when providerMode is live — in that
 * fixed order. Platform-mock keys stay byte-identical to pre-G1.7 values;
 * live evidence can never cache-hit a mock row (previously a live re-run
 * over mock-evaluated items was a silent no-op under resume or a silent
 * skip-write without it), and one org's paid evidence can never serve
 * another org as a free cache hit. KNOWN one-time effect: G1.6-era ORG-mock
 * rows get new keys → next nightly re-executes them (mock, $0,
 * deterministic — identical content; lingering old-key rows duplicate
 * aggregate samples with identical values, means unchanged).
 */
export function cacheKeyOf(
  sh: string,
  item: EvalItem,
  scoring: ScoringMethod,
  prices: PriceTable,
  opts: { orgId?: string; providerMode?: ProviderMode; cacheSalt?: string } = {},
): string {
  const orgPart = opts.orgId !== undefined ? `|org:${opts.orgId}` : '';
  const livePart = opts.providerMode === 'live' ? '|live' : '';
  // Observatory canaries (OBSERVATORY.md §1): a sentinel must EXECUTE, or a
  // content-addressed hit would "re-verify" a model that has silently changed.
  // The salt (e.g. the ISO week) makes the cell new on purpose; unsalted keys
  // are byte-identical to before, so every other run keeps its $0 resume.
  const saltPart = opts.cacheSalt !== undefined && opts.cacheSalt !== '' ? `|salt:${opts.cacheSalt}` : '';
  return sha256(
    `${sh}|${item.id}|${judgeVersionOf(scoring, prices)}|${prices.version}${orgPart}${livePart}${saltPart}`,
  );
}

/**
 * Does this model string RESOLVE to the mock provider?
 *
 * THE RULE IS RESOLUTION, NOT SPELLING (false-live instance #6, found by the
 * invariant sweep). The guard below used to collect mock ALIASES and test
 * string membership — but `createResolver` (@potion/strategies) matches
 * `e.alias === model || e.model === model`, so every mock entry has a SECOND
 * name that reaches the mock provider: 'mock-mid' was refused while
 * 'mock-mid-v1' sailed through, executed on the mock, and got stamped
 * providerMode 'live'. A guard that does not use the same lookup as the
 * thing it guards is not a guard. This helper IS that lookup.
 */
export function resolvesToMockProvider(model: string, prices: PriceTable): boolean {
  const entry = prices.entries.find((e) => e.alias === model || e.model === model);
  return entry?.provider === 'mock';
}

/** G1.7: a run declared 'live' must never execute against mock-provider
 * models — the provider set still contains a real mock behind 'mock:', so
 * a model that RESOLVES to mock would silently mock while the rows get
 * stamped 'live' (the false-live pattern; instance #4 made it a guard,
 * instance #6 made it resolution-based). */
export class MockAliasInLiveRunError extends Error {
  constructor(readonly aliases: string[]) {
    super(
      `live run refused: alias(es) [${aliases.join(', ')}] resolve to the mock provider — ` +
        'a live run over mock aliases would stamp mock output as live evidence',
    );
    this.name = 'MockAliasInLiveRunError';
  }
}

export async function runEval(opts: RunOptions, deps: RunDeps = {}): Promise<RunSummary> {
  const prices = deps.prices ?? loadPrices(deps.pricesPath).table;
  // ---- provenance gate: simulated suites require an explicit opt-in ----
  const resolved = opts.suiteIds.map((id) => resolveSuite(id, deps.suitesDir));
  const simulatedIds = resolved.filter((r) => r.simulated).map((r) => r.suiteId);
  if (simulatedIds.length > 0 && !opts.simulatedOk) {
    throw new SimulatedSuiteError(simulatedIds);
  }
  const simulated = simulatedIds.length > 0;
  const flatItems = resolved.flatMap((r) => loadSuiteFile(r.path, r.suiteId));
  // G1.3: DERIVED suites (agent-* — trace-synthesized customer data) load
  // from governed db storage; authored suites stay repo files. Db-loaded
  // items pass the SAME crossCheckItem gate as file suites.
  const v2Ids = opts.suiteV2Ids ?? [];
  // Database-backed suites: trace-synthesized agent replays ('agent-…') and
  // the learning period's per-kind-of-work suites ('learn-…', 2026-08-22).
  const derivedIds = v2Ids.filter((id) => id.startsWith('agent-') || id.startsWith('learn-'));
  const authoredIds = v2Ids.filter((id) => !id.startsWith('agent-') && !id.startsWith('learn-'));
  const v2Suites = loadSuitesV2(authoredIds, deps.suitesV2Dir, opts.suitePurpose ?? 'search');
  const derivedItems: EvalItem[] = [];
  if (derivedIds.length > 0) {
    if (!deps.db) {
      throw new Error(
        `derived suite(s) ${derivedIds.join(', ')} live in db storage (G1.3) — ` +
          'runEval needs a db handle (deps.db) to load them',
      );
    }
    for (const suiteId of derivedIds) {
      const loaded = await loadDerivedSuite(deps.db.db, suiteId);
      if (!loaded) throw new Error(`derived suite '${suiteId}' not found in db storage`);
      const manifest = loaded.suite.manifest as Partial<SuiteManifest>;
      const gate: Pick<SuiteManifest, 'suiteId' | 'clusterId' | 'scoring'> = {
        suiteId,
        clusterId: manifest.clusterId ?? loaded.suite.clusterId,
        scoring: manifest.scoring ?? {},
      };
      loaded.items.forEach((item, idx) => {
        const problems = crossCheckItem(gate, item, idx);
        if (problems.length > 0) {
          throw new Error(`derived suite '${suiteId}': ${problems.join('; ')}`);
        }
        derivedItems.push(item);
      });
    }
  }
  const allItems = [...flatItems, ...v2Suites.flatMap((s) => s.items), ...derivedItems];

  // Skip unrunnable items (currently: python code-exec) with a clear warning
  // instead of failing the whole run or silently scoring 0.
  const items: EvalItem[] = [];
  const skipped: SkippedItem[] = [];
  for (const item of allItems) {
    const reason = unrunnableReason(item);
    if (reason) {
      skipped.push({ itemId: item.id, reason });
      console.warn(`[harness] SKIP item '${item.id}': ${reason}`);
    } else {
      items.push(item);
    }
  }

  // ---- G1.7: judge-model override as an ITEM TRANSFORM ----
  // Remapping scoring.judgeModel here means judgeVersionOf/cacheKeyOf, the
  // projection, and scoreAnswer all pick the override up with no extra
  // plumbing. Validated against the price table (preflight house style).
  let runItems = items;
  if (opts.judgeModelOverride !== undefined) {
    const override = opts.judgeModelOverride;
    if (!prices.entries.some((e) => e.alias === override || e.model === override)) {
      throw new Error(`judgeModelOverride '${override}' is not in the price table`);
    }
    runItems = items.map((item) =>
      item.scoring.kind === 'llm-judge'
        ? { ...item, scoring: { ...item.scoring, judgeModel: override } }
        : item,
    );
  }

  // ---- Lab Step 5: deterministic item sample ----
  if (opts.itemSampleN !== undefined) {
    if (!Number.isInteger(opts.itemSampleN) || opts.itemSampleN < 1) {
      throw new Error(`itemSampleN must be a positive integer, got ${opts.itemSampleN}`);
    }
    runItems = [...runItems].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).slice(0, opts.itemSampleN);
  }

  // ---- G1.7: false-live guard ----
  if ((opts.provider ?? 'mock') === 'live') {
    // Resolution-based (see resolvesToMockProvider): alias-membership let
    // every mock model's NATIVE id through. strategyModels covers nested
    // models for every strategy type, and the judge clause covers scoring.
    const offending = new Set<string>();
    for (const strategy of opts.strategies) {
      for (const alias of strategyModels(strategy)) {
        if (resolvesToMockProvider(alias, prices)) offending.add(alias);
      }
    }
    for (const item of runItems) {
      if (item.scoring.kind === 'llm-judge' && resolvesToMockProvider(item.scoring.judgeModel, prices)) {
        offending.add(item.scoring.judgeModel);
      }
    }
    if (offending.size > 0) throw new MockAliasInLiveRunError([...offending].sort());
  }

  // ---- preflight: refuse over-budget runs BEFORE any execution ----
  // The projection binds to the SAME output ceilings the run executes with
  // (answers AND judge completions).
  const projectedSpendUsd = projectRunCostUsd(
    opts.strategies,
    runItems,
    prices,
    opts.maxOutputTokens,
    opts.judgeMaxTokens,
  );
  if (projectedSpendUsd > opts.budgetCapUsd) {
    throw new BudgetCapError(projectedSpendUsd, opts.budgetCapUsd);
  }

  // Metering wraps the WHOLE record (strategy + judge calls share it) and is
  // identity-preserving, so detectProviderMode reads the same on either set.
  // The resolver is rebuilt over the wrapped set — a resolver built over the
  // originals would route calls around the meter (the context.ts lesson).
  const rawProviders =
    deps.providers ??
    createRunProviders(opts.provider ?? 'mock', prices, opts.providerTimeoutMs, opts.providerMaxRetries);
  const providers = deps.spendSink
    ? meteredProviders(rawProviders, prices, deps.spendSink)
    : rawProviders;
  const providerMode = opts.providerModeOverride ?? detectProviderMode(providers);
  const ctx = {
    providers,
    prices,
    resolve: createResolver(providers, prices),
    ...(opts.maxOutputTokens !== undefined ? { maxOutputTokens: opts.maxOutputTokens } : {}),
    // Every measured cell records the producing stage's confidence (2026-08-22):
    // the selector-training signal and the realizability score for mixtures.
    captureConfidence: true,
  };

  const ownHandle = deps.db ? null : await createDb();
  const handle = deps.db ?? ownHandle!;
  try {
    await migrate(handle.db);

    const runId = `run-${randomUUID().slice(0, 8)}`;
    const results: EvalResult[] = [];
    let executed = 0;
    let cacheHits = 0;
    let judgeSpendUsd = 0;
    let executedSpendUsd = 0;

    const failedStrategies: FailedStrategy[] = [];
    let abandonedSpendUsd = 0;
    const cellConcurrency = Math.max(1, Math.floor(opts.cellConcurrency ?? 1));
    for (const strategy of opts.strategies) {
      const sh = strategyHash(strategy);
      const modelVersions = modelVersionsFor(strategy, prices);
      // One cell: cache hit or a fresh answer + score, persisted. Returns the
      // row; throws what the provider or scorer threw.
      const runCell = async (item: EvalItem): Promise<EvalResult> => {
        const saltApplies =
          opts.cacheSalt !== undefined &&
          (opts.cacheSaltStrategies === undefined || opts.cacheSaltStrategies.includes(sh));
        const cacheKey = cacheKeyOf(sh, item, item.scoring, prices, {
          ...(opts.orgId !== undefined ? { orgId: opts.orgId } : {}),
          ...(saltApplies ? { cacheSalt: opts.cacheSalt } : {}),
          providerMode,
        });
        // Content-addressed cache: resume reuses hits; without resume we
        // recompute but never overwrite an existing row. Mock-world rows are
        // deterministic (identical content); live rows now live under
        // distinct |live keys, so a live run can neither cache-hit mock
        // evidence nor silently skip persisting its own (G1.7).
        // A STALE row is a miss (2026-09-11): a retired cell — a drifted
        // model's, a re-priced one's — is re-asked, and the fresh answer
        // REPLACES the retired row under the same key below. Before this the
        // staleness flag was decorative: flagged rows were still hits.
        const cached = await getLiveEvalResultByCacheKey(handle.db, cacheKey);
        if (cached && opts.resume) {
          cacheHits++;
          // The SAME measurement under THIS suite: the stored row carries the
          // cluster it was first measured under, and aggregation groups by
          // cluster. Pushed as stored, every cell a boundary suite reused from
          // a parent fell out of the boundary's aggregate (2026-09-08: both
          // boundary frontiers published on partial unions for every cached
          // model). The cluster is the suite's grouping, not part of the
          // evidence; the row in the table is untouched.
          return { ...cached, clusterId: item.clusterId };
        }
        let outcome, quality, scorer, scorerUsage;
        {
          const stepCtx = item.tools !== undefined ? { ...ctx, params: { tools: item.tools } } : ctx;
          // JOURNEY items (2026-08-25): the same strategy answers every
          // step; only the final artifact is scored; usage sums over steps
          // (whole-job cost and wall time). trace stays [] — per-step
          // confidence is not a journey-level signal.
          outcome =
            item.journeySteps !== undefined
              ? {
                  ...(await executeJourney(item, async (messages) => {
                    const r = await execute(strategy, messages, stepCtx);
                    return { text: r.text, usage: r.usage };
                  })),
                  trace: [] as never[],
                  toolCalls: undefined,
                }
              : await execute(strategy, item.prompt, stepCtx);
          ({ quality, scorer, scorerUsage } = await scoreAnswer(
            item,
            outcome.text,
            { providers, prices },
            opts.judgeMaxTokens,
            outcome.toolCalls,
          ));
        }
        // usage = strategy usage + scoring overhead (llm-judge call), summed
        // over tokens and cost — the judge call is real provider spend and
        // MUST count against budget/spend (M1b fix: it was previously
        // discarded). latencyMs deliberately stays STRATEGY-ONLY: scorer
        // latency is not folded in, so latency aggregates keep their
        // pre-M1b meaning (strategy response time, not scoring overhead).
        // Serving truth vs measurement truth (2026-08-23): the cell's usage
        // is the ANSWER call only — it is what the frontier's cost axis
        // aggregates and what a receipt cites. The scorer's spend is kept on
        // its own field and added back into the run's spendUsd below, so the
        // budget belt still counts every dollar burned.
        const usage: Usage = {
          inputTokens: outcome.usage.inputTokens,
          outputTokens: outcome.usage.outputTokens,
          costUsd: outcome.usage.costUsd,
          latencyMs: outcome.usage.latencyMs,
        };
        const result: EvalResult = {
          runId,
          itemId: item.id,
          clusterId: item.clusterId,
          strategyHash: sh,
          strategyConfig: strategy,
          quality,
          scorer,
          usage,
          ...(scorerUsage !== undefined ? { scorerUsage } : {}),
          ...(opts.instrument !== undefined ? { instrument: opts.instrument } : {}),
          // Single-sample distribution: per-item latency IS the strategy's
          // aggregated usage.latencyMs; p50/p95 across items live on the aggregate.
          latencyMs: { p50: usage.latencyMs, p95: usage.latencyMs, mean: usage.latencyMs },
          ...(() => {
            const last = outcome.trace[outcome.trace.length - 1];
            return last?.confidence !== undefined ? { confidence: last.confidence, confidenceMethod: 'logprob' as const } : {};
          })(),
          modelVersions,
          pricesVersion: prices.version,
          providerMode,
          ...(opts.orgId !== undefined ? { orgId: opts.orgId } : {}),
          cacheKey,
          createdAt: new Date().toISOString(),
        };
        if (!cached) await upsertEvalResult(handle.db, result);
        executed++;
        judgeSpendUsd += scorerUsage?.costUsd ?? 0;
        executedSpendUsd += usage.costUsd + (scorerUsage?.costUsd ?? 0);
        return result;
      };

      // The pool: `cellConcurrency` workers pull items in order; each cell's
      // row lands in its item's slot so the strategy's rows enter `results`
      // in item order, exactly as the serial loop pushed them.
      const slots: (EvalResult | undefined)[] = new Array<EvalResult | undefined>(runItems.length);
      // Boxed so the read after the pool settles keeps the declared union:
      // TS does not see assignments made inside the workers' closures.
      const failure: { value: { item: EvalItem; err: unknown } | null } = { value: null };
      let cursor = 0;
      const pull = async (): Promise<void> => {
        for (;;) {
          if (failure.value !== null) return;
          const idx = cursor++;
          if (idx >= runItems.length) return;
          const item = runItems[idx]!;
          try {
            slots[idx] = await runCell(item);
          } catch (err) {
            if (failure.value === null) failure.value = { item, err };
            return;
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(cellConcurrency, Math.max(1, runItems.length)) }, pull));
      if (failure.value !== null) {
        const { item, err } = failure.value;
        if (!opts.containStrategyFailures) throw err;
        // Drop the WHOLE strategy: partial aggregates are biased (see the
        // option's doc), so its completed rows leave this run's results —
        // but their SPEND does not leave the books. Over-counting a cached
        // row's historical cost here is deliberate: the belt must err
        // toward "we spent more", never "less". Cells that were in flight
        // when the failure landed finish and stay cached for a cheap retry.
        const removed = slots.filter((r): r is EvalResult => r !== undefined);
        abandonedSpendUsd += removed.reduce((a, r) => a + r.usage.costUsd, 0);
        failedStrategies.push({
          strategyHash: sh,
          itemId: item.id,
          error: err instanceof Error ? err.message : String(err),
          completedCells: removed.length,
        });
        console.warn(
          `[harness] CONTAINED strategy ${sh.slice(0, 8)} after ${removed.length} cell(s): ` +
            `${err instanceof Error ? err.message : String(err)} — run continues without it`,
        );
        continue;
      }
      for (const r of slots) if (r !== undefined) results.push(r);
    }

    // ---- aggregate per (strategy × cluster) ----
    const groups = new Map<string, EvalResult[]>();
    for (const r of results) {
      const key = `${r.strategyHash}|${r.clusterId}`;
      const list = groups.get(key) ?? [];
      list.push(r);
      groups.set(key, list);
    }
    const aggregates: StrategyAggregate[] = [];
    // Cluster keys: flat suites are keyed by suiteId (== clusterId in the v1
    // world); v2 suites by their manifest clusterId.
    const clusterKeys = [
      ...opts.suiteIds,
      ...v2Suites.map((s) => s.manifest.clusterId),
    ];
    // Boundary suites (2026-09-08): an item's parent slice, when it names one.
    const sliceById = new Map<string, string>();
    for (const it of allItems) if (it.slice !== undefined) sliceById.set(it.id, it.slice);
    const sliceOf = sliceById.size > 0 ? (id: string) => sliceById.get(id) : undefined;
    for (const strategy of opts.strategies) {
      const sh = strategyHash(strategy);
      for (const clusterId of clusterKeys) {
        const group = groups.get(`${sh}|${clusterId}`) ?? [];
        if (group.length === 0) continue;
        aggregates.push(aggregateResults(clusterId, sh, strategy, group, prices.version, providerMode, sliceOf));
      }
    }

    // spendUsd = Σ per-result usage.costUsd — INCLUDES judge scoring cost
    // (folded into usage above), so live budget accounting sees real spend.
    const spendUsd = results.reduce((a, r) => a + r.usage.costUsd + (r.scorerUsage?.costUsd ?? 0), 0) + abandonedSpendUsd;
    return {
      runId,
      aggregates,
      spendUsd,
      executedSpendUsd,
      judgeSpendUsd,
      projectedSpendUsd,
      executed,
      cacheHits,
      skipped,
      failedStrategies,
      abandonedSpendUsd,
      results,
      simulated,
      providerMode,
    };
  } finally {
    if (ownHandle) await ownHandle.close();
  }
}
