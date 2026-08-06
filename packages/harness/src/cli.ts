// packages/harness CLI (SPEC §5): root script `pnpm harness -- ...`.
//   --suite <id>...            suite ids (code-gen, extraction, …) [repeatable]
//   --strategy '<json>'...     StrategyConfig JSON [repeatable]
//   --cap <usd>                budget cap (preflight refusal above projection)
//   --provider <mock|live>     provider mode (default mock; live needs API keys in env)
//   --calibrate                run judge calibration (mock-judge-a vs -b, 30 items)
//   --resume                   reuse content-addressed cache hits
//   --simulated-ok             REQUIRED to run suites from suites/simulated/
//                              (mock-corpus-derived; CI-only provenance)
// Prints the Gate-3 results table: strategy, quality mean±CI, $/1K req, p50/p95.
import { MOCK_PROVIDER_DISCLAIMER } from '@potion/providers';
import { StrategyConfigSchema, type StrategyConfig } from '@potion/core';
import { BudgetCapError } from './estimate.js';
import { runJudgeCalibration } from './calibrate.js';
import { SimulatedSuiteError, runEval, type RunSummary } from './runner.js';
import { loadSuiteFile, resolveSuite } from './suites.js';

export function strategyLabel(cfg: StrategyConfig): string {
  switch (cfg.type) {
    case 'single':
      return `single:${cfg.model}`;
    case 'cascade':
      return `cascade:${cfg.stages.map((s) => s.model).join('→')}`;
    case 'best-of-n':
      return `best-of-${cfg.n}:${cfg.model}+${cfg.judge.model}`;
    case 'draft-verify':
      return `draft-verify:${cfg.draftModel}→${cfg.verifierModel}`;
    case 'ensemble':
      return `ensemble:${cfg.models.join('+')}`;
    case 'decompose':
      return `decompose:${cfg.decomposerModel}`;
    case 'composite': // M3 #23 (SPEC §12.6)
      return `composite:${cfg.startModel}→${cfg.upgradeModel}`;
  }
}

interface CliArgs {
  suites: string[];
  suitesV2: string[];
  strategies: StrategyConfig[];
  cap: number;
  provider: 'mock' | 'live';
  calibrate: boolean;
  resume: boolean;
  simulatedOk: boolean;
  /** Answer output ceiling (RunOptions.maxOutputTokens); undefined → provider default. */
  maxOutputTokens: number | undefined;
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { suites: [], suitesV2: [], strategies: [], cap: NaN, provider: 'mock', calibrate: false, resume: false, simulatedOk: false, maxOutputTokens: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--') continue; // pnpm forwards the script separator literally
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`missing value for ${a}`);
      return v;
    };
    switch (a) {
      case '--suite':
        args.suites.push(next());
        break;
      case '--suite-v2':
        args.suitesV2.push(next());
        break;
      case '--strategy': {
        const raw: unknown = JSON.parse(next());
        args.strategies.push(StrategyConfigSchema.parse(raw) as StrategyConfig);
        break;
      }
      case '--cap':
        args.cap = Number(next());
        break;
      case '--provider': {
        const v = next();
        if (v !== 'mock' && v !== 'live') throw new Error(`--provider must be 'mock' or 'live', got '${v}'`);
        args.provider = v;
        break;
      }
      case '--calibrate':
        args.calibrate = true;
        break;
      case '--resume':
        args.resume = true;
        break;
      case '--simulated-ok':
        args.simulatedOk = true;
        break;
      case '--max-output-tokens': {
        const v = Number(next());
        if (!Number.isInteger(v) || v <= 0) throw new Error('--max-output-tokens must be a positive integer');
        args.maxOutputTokens = v;
        break;
      }
      default:
        throw new Error(`unknown flag '${a}'`);
    }
  }
  if (args.suites.length === 0 && args.suitesV2.length === 0) throw new Error('at least one --suite or --suite-v2 is required');
  if (args.strategies.length === 0) throw new Error('at least one --strategy is required');
  if (!Number.isFinite(args.cap) || args.cap < 0) throw new Error('--cap <usd> is required (non-negative number)');
  return args;
}

function fmt(x: number, digits = 3): string {
  return x.toFixed(digits);
}

export function formatResultsTable(summary: RunSummary): string {
  const lines: string[] = [];
  const header = [
    'suite'.padEnd(12),
    'strategy'.padEnd(42),
    'quality (mean ± CI95)'.padEnd(22),
    'n'.padStart(3),
    '$/1K req'.padStart(9),
    'p50 ms'.padStart(8),
    'p95 ms'.padStart(8),
  ].join(' ');
  lines.push(header);
  lines.push('-'.repeat(header.length));
  for (const agg of summary.aggregates) {
    lines.push(
      [
        String(agg.clusterId).padEnd(12),
        strategyLabel(agg.strategyConfig).padEnd(42),
        `${fmt(agg.qualityMean)} ± ${fmt(agg.qualityCi95)}`.padEnd(22),
        String(agg.n).padStart(3),
        `$${agg.costPer1K.toFixed(2)}`.padStart(9),
        String(Math.round(agg.latencyP50)).padStart(8),
        String(Math.round(agg.latencyP95)).padStart(8),
      ].join(' '),
    );
  }
  // Footnote (less invasive than a new column): make judge scoring spend
  // visible whenever llm-judge items were scored — $/1K and spend include it.
  if (summary.judgeSpendUsd > 0) {
    lines.push(
      `note: spend and $/1K include llm-judge scoring cost — judge calls this run: $${summary.judgeSpendUsd.toFixed(4)}`,
    );
  }
  return lines.join('\n');
}

/** Loud, unmissable banner printed whenever simulated suites were involved. */
export function simulatedBanner(summary: RunSummary): string {
  const bar = '!'.repeat(78);
  return [
    bar,
    '!!! SIMULATED EVAL RESULTS — NOT EVIDENCE OF REAL-WORLD QUALITY'.padEnd(78),
    `!!! ${MOCK_PROVIDER_DISCLAIMER}`.padEnd(78),
    `!!! run ${summary.runId}: suite(s) from suites/simulated/ (mock-corpus-derived,`.padEnd(78),
    '!!! CI-only provenance). See packages/harness/suites/simulated/README.md.'.padEnd(78),
    bar,
  ].join('\n');
}

export async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args.suites.length > 0) {
    console.warn(
      `[deprecation] flat JSONL suites (--suite ${args.suites.join(' ')}) are deprecated; ` +
        'prefer v2 suites with provenance manifests (--suite-v2 <id>, see packages/harness/suites/v2).',
    );
  }
  let summary: RunSummary;
  try {
    summary = await runEval(
      {
        suiteIds: args.suites,
        suiteV2Ids: args.suitesV2,
        strategies: args.strategies,
        budgetCapUsd: args.cap,
        provider: args.provider,
        resume: args.resume,
        simulatedOk: args.simulatedOk,
        ...(args.maxOutputTokens !== undefined ? { maxOutputTokens: args.maxOutputTokens } : {}),
      },
      {},
    );
    if (summary.simulated) console.log(`\n${simulatedBanner(summary)}\n`);
    console.log(`\nrun ${summary.runId} — projected $${summary.projectedSpendUsd.toFixed(4)} / cap $${args.cap.toFixed(2)} — spend $${summary.spendUsd.toFixed(4)} (${summary.executed} executed, ${summary.cacheHits} cache hits, ${summary.skipped.length} skipped)\n`);
    for (const s of summary.skipped) console.warn(`  skipped '${s.itemId}': ${s.reason}`);
    console.log(formatResultsTable(summary));
    if (summary.simulated) console.log(`\n${simulatedBanner(summary)}\n`);
  } catch (e) {
    if (e instanceof BudgetCapError || e instanceof SimulatedSuiteError) {
      console.error(`\nREFUSED: ${e.message}\n`);
      return 2;
    }
    throw e;
  }

  if (args.calibrate) {
    if (args.suites.length === 0) throw new Error('--calibrate requires a flat --suite (v2 calibration not wired yet)');
    const resolved = resolveSuite(args.suites[0]!);
    const items = loadSuiteFile(resolved.path, resolved.suiteId).slice(0, 30);
    const report = await runJudgeCalibration(items);
    console.log(
      `\njudge calibration: ${report.judgeA} vs ${report.judgeB} on ${report.n} double-scored answers\n` +
        `  pearson agreement = ${report.pearson.toFixed(3)} ` +
        `${report.flagged ? 'FLAGGED (< 0.8) ⚠' : 'OK (>= 0.8)'}`,
    );
  }
  console.log('');
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
