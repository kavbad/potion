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
  loadDerivedSuite, createDb, getEvalResultByCacheKey, insertEvalResult, migrate, type DbHandle } from '@potion/db';
import {
  createMockProvider,
  createProviders,
  loadPrices,
  type Provider,
} from '@potion/providers';
import { createResolver, execute } from '@potion/strategies';
import { aggregateResults } from './aggregate.js';
import { BudgetCapError, projectRunCostUsd } from './estimate.js';
import { loadSuitesV2 } from './ingest/suite-v2.js';
import { crossCheckItem, type SuiteManifest } from './ingest/manifest.js';
import { scoreAnswer } from './scorers.js';
import { loadSuiteFile, resolveSuite } from './suites.js';

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
  suiteIds: string[];
  /** v2 suites (suites/v2/<id>/manifest.json + items) loaded through the v2
   * loader with manifest cross-checks (ROADMAP M1a). */
  suiteV2Ids?: string[];
  strategies: StrategyConfig[];
  budgetCapUsd: number;
  provider?: 'mock' | 'live';
  resume?: boolean;
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
}

/** Injectable seams for tests/CLI (all optional). */
export interface RunDeps {
  db?: DbHandle;
  suitesDir?: string;
  suitesV2Dir?: string;
  pricesPath?: string;
}

/** An item the runner deliberately did not execute (with the reason). */
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
  spendUsd: number;
  /**
   * Judge-scoring spend included in spendUsd: Σ over this run's EXECUTED
   * llm-judge scorer calls (scorerUsage.costUsd). 0 for runs with no
   * llm-judge items. Caveat: resume cache-hits reuse stored rows, which do
   * not retain the scorerUsage split — their judge cost IS inside spendUsd
   * (via usage.costUsd) but cannot be re-attributed here.
   */
  judgeSpendUsd: number;
  projectedSpendUsd: number;
  executed: number;
  cacheHits: number;
  skipped: SkippedItem[];
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
  }
}

/** Providers for a run: 'mock' puts the deterministic mock behind EVERY provider
 * id (so live-priced aliases still cost against their real price entries while
 * answering deterministically); 'live' builds the real factory (API keys). */
export function createRunProviders(
  mode: 'mock' | 'live',
  prices: PriceTable,
): Record<ProviderId, Provider> {
  if (mode === 'live') return createProviders({ prices });
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
  opts: { orgId?: string; providerMode?: ProviderMode } = {},
): string {
  const orgPart = opts.orgId !== undefined ? `|org:${opts.orgId}` : '';
  const livePart = opts.providerMode === 'live' ? '|live' : '';
  return sha256(
    `${sh}|${item.id}|${judgeVersionOf(scoring, prices)}|${prices.version}${orgPart}${livePart}`,
  );
}

/** G1.7: a run declared 'live' must never execute against mock-provider
 * aliases — the provider set still contains a real mock behind 'mock:', so
 * a mock alias would silently mock while the rows get stamped 'live' (the
 * false-live pattern; fourth instance made it a guard). */
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
  const { table: prices } = loadPrices(deps.pricesPath);
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
  const derivedIds = v2Ids.filter((id) => id.startsWith('agent-'));
  const authoredIds = v2Ids.filter((id) => !id.startsWith('agent-'));
  const v2Suites = loadSuitesV2(authoredIds, deps.suitesV2Dir);
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

  // ---- G1.7: false-live guard ----
  if ((opts.provider ?? 'mock') === 'live') {
    const mockAliases = new Set(
      prices.entries.filter((e) => e.provider === 'mock').map((e) => e.alias),
    );
    const offending = new Set<string>();
    for (const strategy of opts.strategies) {
      for (const alias of strategyModels(strategy)) {
        if (mockAliases.has(alias)) offending.add(alias);
      }
    }
    for (const item of runItems) {
      if (item.scoring.kind === 'llm-judge' && mockAliases.has(item.scoring.judgeModel)) {
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

  const providers = createRunProviders(opts.provider ?? 'mock', prices);
  const providerMode = opts.providerModeOverride ?? detectProviderMode(providers);
  const ctx = {
    providers,
    prices,
    resolve: createResolver(providers, prices),
    ...(opts.maxOutputTokens !== undefined ? { maxOutputTokens: opts.maxOutputTokens } : {}),
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

    for (const strategy of opts.strategies) {
      const sh = strategyHash(strategy);
      const modelVersions = modelVersionsFor(strategy, prices);
      for (const item of runItems) {
        const cacheKey = cacheKeyOf(sh, item, item.scoring, prices, {
          ...(opts.orgId !== undefined ? { orgId: opts.orgId } : {}),
          providerMode,
        });
        // Content-addressed cache: resume reuses hits; without resume we
        // recompute but never overwrite an existing row. Mock-world rows are
        // deterministic (identical content); live rows now live under
        // distinct |live keys, so a live run can neither cache-hit mock
        // evidence nor silently skip persisting its own (G1.7).
        const cached = await getEvalResultByCacheKey(handle.db, cacheKey);
        if (cached && opts.resume) {
          cacheHits++;
          results.push(cached);
          continue;
        }
        const outcome = await execute(strategy, item.prompt, ctx);
        const { quality, scorer, scorerUsage } = await scoreAnswer(
          item,
          outcome.text,
          { providers, prices },
          opts.judgeMaxTokens,
        );
        // usage = strategy usage + scoring overhead (llm-judge call), summed
        // over tokens and cost — the judge call is real provider spend and
        // MUST count against budget/spend (M1b fix: it was previously
        // discarded). latencyMs deliberately stays STRATEGY-ONLY: scorer
        // latency is not folded in, so latency aggregates keep their
        // pre-M1b meaning (strategy response time, not scoring overhead).
        const usage: Usage = {
          inputTokens: outcome.usage.inputTokens + (scorerUsage?.inputTokens ?? 0),
          outputTokens: outcome.usage.outputTokens + (scorerUsage?.outputTokens ?? 0),
          costUsd: outcome.usage.costUsd + (scorerUsage?.costUsd ?? 0),
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
          // Single-sample distribution: per-item latency IS the strategy's
          // aggregated usage.latencyMs; p50/p95 across items live on the aggregate.
          latencyMs: { p50: usage.latencyMs, p95: usage.latencyMs, mean: usage.latencyMs },
          modelVersions,
          pricesVersion: prices.version,
          providerMode,
          ...(opts.orgId !== undefined ? { orgId: opts.orgId } : {}),
          cacheKey,
          createdAt: new Date().toISOString(),
        };
        if (!cached) await insertEvalResult(handle.db, result);
        executed++;
        judgeSpendUsd += scorerUsage?.costUsd ?? 0;
        results.push(result);
      }
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
    for (const strategy of opts.strategies) {
      const sh = strategyHash(strategy);
      for (const clusterId of clusterKeys) {
        const group = groups.get(`${sh}|${clusterId}`) ?? [];
        if (group.length === 0) continue;
        aggregates.push(aggregateResults(clusterId, sh, strategy, group, prices.version, providerMode));
      }
    }

    // spendUsd = Σ per-result usage.costUsd — INCLUDES judge scoring cost
    // (folded into usage above), so live budget accounting sees real spend.
    const spendUsd = results.reduce((a, r) => a + r.usage.costUsd, 0);
    return {
      runId,
      aggregates,
      spendUsd,
      judgeSpendUsd,
      projectedSpendUsd,
      executed,
      cacheHits,
      skipped,
      results,
      simulated,
      providerMode,
    };
  } finally {
    if (ownHandle) await ownHandle.close();
  }
}
