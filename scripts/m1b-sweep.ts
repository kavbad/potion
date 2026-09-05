// M1b ten-cluster frontier sweep (docs/M1B-RUNBOOK.md §2): runs the
// 3-baseline + 3-composite strategy set on the 8 AUTHORED breadth suites
// (flat JSONL in packages/harness/suites/ — NOT suites/simulated/, NOT v2)
// against LIVE providers via OpenRouter, under a hard total budget cap.
//
//   LIVE (operator machine, needs OPENROUTER_API_KEY):
//     pnpm tsx scripts/m1b-sweep.ts --cap 15
//   DRY-RUN (mock provider, identical orchestration, zero network/spend):
//     pnpm tsx scripts/m1b-sweep.ts --cap 15 --dry-run
//
// Budget governance (SPEC §5 + runbook "Safety rails"):
//   1. PREFLIGHT: project spend across ALL suites × strategies up front
//      (harness estimator, packages/harness/src/estimate.ts) and REFUSE to
//      start (exit 2) when the projection exceeds --cap.
//   2. Suites run SEQUENTIALLY; before each suite the remaining budget is
//      re-checked and the sweep stops gracefully when the next suite's
//      projection wouldn't fit. Each runEval call additionally gets its own
//      budgetCapUsd = remaining budget, so the harness preflight is a second
//      enforcement layer on the live path.
//   3. Running spend is printed after every suite; the final line prints
//      TOTAL SPEND and remaining cap for the operator's ledger.
//
// Safety: live mode fails fast when OPENROUTER_API_KEY (or a judge-model
// provider key) is missing; the key is never logged; live calls only ever
// happen through the budget-capped runEval path. --dry-run is byte-for-byte
// the same orchestration against the deterministic mock provider.
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { EvalItem, PriceTable, ProviderId, StrategyConfig } from '@potion/core';
import { loadPrices } from '@potion/providers';
import {
  formatResultsTable,
  loadSuite,
  projectRunCostUsd,
  runEval,
  strategyLabel,
  SUITE_OUTPUT_CEILINGS,
  type RunSummary,
} from '@potion/harness';

const PRICES_PATH = fileURLToPath(new URL('../prices.json', import.meta.url));
const ARTIFACTS_DIR = fileURLToPath(new URL('../artifacts', import.meta.url));

/** The 8 authored breadth suites (ten-cluster frontier sweep; flat JSONL). */
export const SWEEP_SUITES = [
  'code-review',
  'summarization',
  'classification',
  'multi-step-reasoning',
  'creative',
  'rewrite-edit',
  'rag-answer',
  'agentic-tool-use',
] as const;

/** The 3-baseline + 3-composite strategy set (M1b, all OpenRouter aliases). */
export const SWEEP_STRATEGIES: StrategyConfig[] = [
  { type: 'single', model: 'or-gpt-mini' },
  { type: 'single', model: 'or-gpt-full' },
  { type: 'single', model: 'or-sonnet' },
  {
    type: 'cascade',
    stages: [
      { model: 'or-gpt-mini', escalateIf: { confidenceBelow: 0.72 } },
      { model: 'or-sonnet' },
    ],
    confidenceMethod: 'self-report-calibrated',
  },
  { type: 'best-of-n', model: 'or-gpt-mini', n: 3, judge: { model: 'or-judge' } },
  { type: 'draft-verify', draftModel: 'or-gpt-mini', verifierModel: 'or-sonnet' },
];

const ENV_VAR_BY_PROVIDER: Partial<Record<ProviderId, string>> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GOOGLE_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
};

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested in scripts/m1b-sweep.test.ts — mock, zero network)
// ---------------------------------------------------------------------------

export interface CliArgs {
  cap: number;
  dryRun: boolean;
  resume: boolean;
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { cap: 15, dryRun: false, resume: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--') continue; // pnpm forwards the script separator literally
    switch (a) {
      case '--cap': {
        const v = argv[++i];
        if (v === undefined) throw new Error('missing value for --cap');
        args.cap = Number(v);
        break;
      }
      case '--dry-run':
        args.dryRun = true;
        break;
      case '--resume':
        args.resume = true;
        break;
      default:
        throw new Error(`unknown flag '${a}' (supported: --cap <usd>, --dry-run, --resume)`);
    }
  }
  if (!Number.isFinite(args.cap) || args.cap < 0) {
    throw new Error('--cap must be a non-negative number (USD)');
  }
  return args;
}

/** Preflight projection for ONE suite across all sweep strategies — bound to
 * the suite's configured output ceiling (SUITE_OUTPUT_CEILINGS), exactly as
 * the run will execute. */
export function projectSuiteCostUsd(
  strategies: StrategyConfig[],
  items: EvalItem[],
  prices: PriceTable,
  maxOutputTokens?: number,
): number {
  return projectRunCostUsd(strategies, items, prices, maxOutputTokens);
}

/** Preflight projection for the WHOLE sweep (all suites × strategies).
 * suiteIds (parallel to itemsBySuite) select each suite's output ceiling. */
export function projectSweepCostUsd(
  strategies: StrategyConfig[],
  itemsBySuite: ReadonlyArray<EvalItem[]>,
  prices: PriceTable,
  suiteIds: ReadonlyArray<string> = [],
): number {
  return itemsBySuite.reduce(
    (total, items, i) =>
      total + projectSuiteCostUsd(strategies, items, prices, ceilingFor(suiteIds[i])),
    0,
  );
}

/** The suite's configured answer-output ceiling (undefined → provider default). */
export function ceilingFor(suiteId: string | undefined): number | undefined {
  return suiteId === undefined ? undefined : SUITE_OUTPUT_CEILINGS[suiteId];
}

/** Graceful-stop gate: true when the next suite's projection fits the
 * remaining budget. Equality fits (a $0.00 remainder is still legal).
 * A 1-nanodollar tolerance absorbs IEEE754 noise on exact-fit budgets
 * (e.g. `3p - 2p < p` in doubles) — immaterial for USD governance. */
export function fitsBudget(projectedUsd: number, remainingUsd: number): boolean {
  return projectedUsd <= remainingUsd + 1e-9;
}

/** Provider env vars a live run needs: every strategy model's provider plus
 * every llm-judge scorer's provider (judge calls happen at score time, inside
 * runEval — a missing key there would crash the sweep AFTER money was spent,
 * so we fail fast up front instead). */
export function requiredLiveEnvVars(
  strategies: StrategyConfig[],
  itemsBySuite: ReadonlyArray<EvalItem[]>,
  prices: PriceTable,
): string[] {
  const providers = new Set<ProviderId>();
  const addModel = (alias: string) => {
    const entry = prices.entries.find((e) => e.alias === alias || e.model === alias);
    if (!entry) throw new Error(`unknown model '${alias}' — not an alias or native id in prices.json`);
    providers.add(entry.provider);
  };
  for (const strategy of strategies) {
    switch (strategy.type) {
      case 'single':
        addModel(strategy.model);
        break;
      case 'cascade':
        strategy.stages.forEach((s) => addModel(s.model));
        break;
      case 'best-of-n':
        addModel(strategy.model);
        addModel(strategy.judge.model);
        break;
      case 'draft-verify':
        addModel(strategy.draftModel);
        addModel(strategy.verifierModel);
        break;
      case 'ensemble':
        strategy.models.forEach(addModel);
        if (strategy.fusion.judge) addModel(strategy.fusion.judge.model);
        break;
      case 'decompose':
        addModel(strategy.decomposerModel);
        Object.values(strategy.routing).forEach(addModel);
        if (strategy.fusion?.judge) addModel(strategy.fusion.judge.model);
        break;
    }
  }
  for (const items of itemsBySuite) {
    for (const item of items) {
      if (item.scoring.kind === 'llm-judge') addModel(item.scoring.judgeModel);
    }
  }
  const vars: string[] = [];
  for (const provider of providers) {
    const envVar = ENV_VAR_BY_PROVIDER[provider]; // 'mock' needs no key
    if (envVar) vars.push(envVar);
  }
  return vars.sort();
}

export interface SuiteOutcome {
  suiteId: string;
  projectedUsd: number;
  summary: RunSummary;
}

export interface SweepOutcome {
  outcomes: SuiteOutcome[];
  stoppedEarly: boolean;
  stopReason: string | null;
  totalSpendUsd: number;
}

/** Injectable seam (tests/mock): defaults to the harness runEval. */
export type RunEvalFn = typeof runEval;

export interface SweepLoopInput {
  suiteIds: readonly string[];
  itemsBySuite: ReadonlyArray<EvalItem[]>;
  strategies: StrategyConfig[];
  prices: PriceTable;
  capUsd: number;
  provider: 'mock' | 'live';
  resume?: boolean;
  runEvalFn?: RunEvalFn;
  /** Called after each suite (printing hook; tests capture it). */
  onSuiteDone?: (outcome: SuiteOutcome, runningSpendUsd: number, remainingUsd: number) => void;
}

/**
 * Sequential budget-governed loop: re-check remaining budget before each
 * suite and stop gracefully when the next suite's projection wouldn't fit.
 * Per-suite runEval gets budgetCapUsd = remaining (harness preflight is the
 * second enforcement layer). Preflight refusal for the WHOLE sweep lives in
 * main() before this loop is entered.
 */
export async function runSweepLoop(input: SweepLoopInput): Promise<SweepOutcome> {
  const run = input.runEvalFn ?? runEval;
  const outcomes: SuiteOutcome[] = [];
  let totalSpendUsd = 0;
  let stoppedEarly = false;
  let stopReason: string | null = null;

  for (let i = 0; i < input.suiteIds.length; i++) {
    const suiteId = input.suiteIds[i]!;
    const items = input.itemsBySuite[i]!;
    const remaining = input.capUsd - totalSpendUsd;
    const projected = projectSuiteCostUsd(input.strategies, items, input.prices, ceilingFor(suiteId));
    if (!fitsBudget(projected, remaining)) {
      stoppedEarly = true;
      stopReason =
        `suite '${suiteId}' projected $${projected.toFixed(4)} does not fit the remaining ` +
        `$${remaining.toFixed(4)} of the $${input.capUsd.toFixed(2)} cap — stopping gracefully ` +
        `(${outcomes.length}/${input.suiteIds.length} suites completed)`;
      break;
    }
    // Hoisted: the guard and the value must be the SAME expression for the
    // narrowing to hold, or the spread reintroduces `number | undefined`
    // against an exactOptionalPropertyTypes `maxOutputTokens?: number`.
    const ceiling = ceilingFor(suiteId);
    const summary = await run(
      {
        suiteIds: [suiteId],
        strategies: input.strategies,
        budgetCapUsd: remaining,
        provider: input.provider,
        ...(input.resume ? { resume: true } : {}),
        ...(ceiling !== undefined ? { maxOutputTokens: ceiling } : {}),
      },
      {},
    );
    totalSpendUsd += summary.spendUsd;
    const outcome: SuiteOutcome = { suiteId, projectedUsd: projected, summary };
    outcomes.push(outcome);
    input.onSuiteDone?.(outcome, totalSpendUsd, input.capUsd - totalSpendUsd);
  }
  return { outcomes, stoppedEarly, stopReason, totalSpendUsd };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

function fmtUsd(x: number, digits = 4): string {
  return `$${x.toFixed(digits)}`;
}

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const provider = args.dryRun ? 'mock' : 'live';
  const { table: prices, stale } = loadPrices(PRICES_PATH);

  console.log('── Potion M1b: ten-cluster frontier sweep ──────────────────────');
  console.log(
    `mode          : ${args.dryRun ? 'DRY-RUN (mock) — no spend' : 'LIVE (OpenRouter)'}`,
  );
  console.log(
    `prices        : v${prices.version} (${prices.entries.length} aliases)${stale ? ' [STALE — list prices may have drifted]' : ''}`,
  );
  console.log(`suites        : ${SWEEP_SUITES.length} authored breadth suites × 6 strategies`);
  console.log(`budget cap    : $${args.cap.toFixed(2)} (total, preflight-enforced)`);

  // Load all suite items up front (authored dir only — loadSuite never falls
  // back to suites/simulated/, so the mock-corpus quarantine cannot leak in).
  const itemsBySuite = SWEEP_SUITES.map((id) => loadSuite(id));
  const itemCounts = SWEEP_SUITES.map((id, i) => `${id}:${itemsBySuite[i]!.length}`);

  // Live-mode key check BEFORE anything else can spend. Keys are only checked
  // for presence — never printed.
  if (!args.dryRun) {
    const required = requiredLiveEnvVars(SWEEP_STRATEGIES, itemsBySuite, prices);
    const missing = required.filter((v) => !process.env[v]);
    if (missing.length > 0) {
      console.error(
        `\nREFUSED: live mode requires ${required.join(', ')} in the environment; missing: ` +
          `${missing.join(', ')}. Set them (e.g. \`set -a; source .env; set +a\`) and re-run. ` +
          `No run was started, nothing was spent. (Hint: OPENROUTER_API_KEY covers the or-* ` +
          `strategy/judge models; llm-judge-scored suites may require their judge provider's key too.)`,
      );
      return 2;
    }
  }

  // ---- PREFLIGHT: projected spend across ALL suites × strategies ----------
  const perSuiteProjections = itemsBySuite.map((items, i) =>
    projectSuiteCostUsd(SWEEP_STRATEGIES, items, prices, ceilingFor(SWEEP_SUITES[i])),
  );
  const totalProjection = perSuiteProjections.reduce((a, b) => a + b, 0);
  console.log('\npreflight projection (harness worst-case estimator):');
  SWEEP_SUITES.forEach((id, i) => {
    console.log(`  ${id.padEnd(22)} ${itemCounts[i]!.split(':')[1]} items  ${fmtUsd(perSuiteProjections[i]!)}`);
  });
  console.log(`  ${'TOTAL'.padEnd(22)} ${' '.repeat(8)} ${fmtUsd(totalProjection)}  (cap $${args.cap.toFixed(2)})`);
  if (!fitsBudget(totalProjection, args.cap)) {
    console.error(
      `\nPREFLIGHT REFUSAL: projected sweep spend ${fmtUsd(totalProjection)} exceeds the ` +
        `$${args.cap.toFixed(2)} cap — refusing to start ANY suite. Raise --cap or trim the ` +
        `strategy/suite set. Nothing was run, nothing was spent.`,
    );
    return 2;
  }

  // ---- sequential, budget-governed execution ------------------------------
  const startedAt = new Date();
  const sweep = await runSweepLoop({
    suiteIds: SWEEP_SUITES,
    itemsBySuite,
    strategies: SWEEP_STRATEGIES,
    prices,
    capUsd: args.cap,
    provider,
    resume: args.resume,
    onSuiteDone: (outcome, runningSpend, remaining) => {
      console.log(`\n┌─ suite '${outcome.suiteId}' — run ${outcome.summary.runId} ` +
        `(projected ${fmtUsd(outcome.projectedUsd)}, spend ${fmtUsd(outcome.summary.spendUsd)}, ` +
        `${outcome.summary.executed} executed, ${outcome.summary.skipped.length} skipped)`);
      console.log(formatResultsTable(outcome.summary));
      console.log(
        `└─ running spend ${fmtUsd(runningSpend)} / cap $${args.cap.toFixed(2)} — remaining ${fmtUsd(remaining)}`,
      );
    },
  });
  if (sweep.stopReason) console.log(`\nGRACEFUL STOP: ${sweep.stopReason}`);

  // ---- final combined summary (per cluster × per strategy) -----------------
  const allAggregates = sweep.outcomes.flatMap((o) => o.summary.aggregates);
  console.log('\n══ COMBINED SUMMARY — per cluster × per strategy ══════════════');
  if (allAggregates.length === 0) {
    console.log('(no suites ran)');
  } else {
    console.log(
      formatResultsTable({
        runId: 'm1b-sweep-combined',
        aggregates: allAggregates,
        spendUsd: sweep.totalSpendUsd,
        judgeSpendUsd: sweep.outcomes.reduce((a, o) => a + o.summary.judgeSpendUsd, 0),
        projectedSpendUsd: totalProjection,
        executed: sweep.outcomes.reduce((a, o) => a + o.summary.executed, 0),
        cacheHits: sweep.outcomes.reduce((a, o) => a + o.summary.cacheHits, 0),
        skipped: sweep.outcomes.flatMap((o) => o.summary.skipped),
        // These three were simply absent from the combined summary — RunSummary
        // gained them and this literal never caught up, which nothing noticed
        // because scripts/ was outside the typecheck. abandonedSpendUsd is the
        // one that matters: its own doc says hiding abandoned spend is how a
        // campaign "under budget" costs more than its ledger claims, and the
        // COMBINED table is exactly where an operator reads the total.
        executedSpendUsd: sweep.outcomes.reduce((a, o) => a + o.summary.executedSpendUsd, 0),
        abandonedSpendUsd: sweep.outcomes.reduce((a, o) => a + o.summary.abandonedSpendUsd, 0),
        failedStrategies: sweep.outcomes.flatMap((o) => o.summary.failedStrategies),
        results: [],
        simulated: false,
        providerMode: provider,
      }),
    );
  }
  console.log('\nstrategies:');
  SWEEP_STRATEGIES.forEach((s) => console.log(`  ${strategyLabel(s)}`));

  // ---- JSON artifact (full RunSummary objects for the orchestrator) --------
  mkdirSync(ARTIFACTS_DIR, { recursive: true });
  const stamp = startedAt.toISOString().replace(/[:.]/g, '-');
  const artifactPath = `${ARTIFACTS_DIR}/m1b-sweep-${stamp}.json`;
  const artifact = {
    generatedAt: startedAt.toISOString(),
    mode: args.dryRun ? 'dry-run (mock — no spend)' : 'live (openrouter)',
    providerMode: provider,
    dryRun: args.dryRun,
    capUsd: args.cap,
    projectedSweepUsd: totalProjection,
    totalSpendUsd: sweep.totalSpendUsd,
    remainingCapUsd: args.cap - sweep.totalSpendUsd,
    suitesPlanned: [...SWEEP_SUITES],
    suitesRun: sweep.outcomes.map((o) => o.suiteId),
    stoppedEarly: sweep.stoppedEarly,
    stopReason: sweep.stopReason,
    strategies: SWEEP_STRATEGIES,
    runs: sweep.outcomes.map((o) => o.summary),
  };
  writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`);
  console.log(`\nartifact      : ${artifactPath}`);

  // ---- operator ledger line (always last) ----------------------------------
  console.log(
    `TOTAL SPEND ${fmtUsd(sweep.totalSpendUsd)}${args.dryRun ? ' (DRY-RUN mock accounting — no real spend)' : ''} — ` +
      `remaining cap ${fmtUsd(args.cap - sweep.totalSpendUsd)} of $${args.cap.toFixed(2)} (--cap). ` +
      `Paste projected ${fmtUsd(totalProjection)} / actual ${fmtUsd(sweep.totalSpendUsd)} into the tasks/todo.md ledger.`,
  );
  return 0;
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '');
if (isMain) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((e) => {
      console.error(e instanceof Error ? e.message : e);
      process.exit(1);
    });
}
