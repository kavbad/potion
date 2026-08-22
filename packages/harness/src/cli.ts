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
import { createProviders, loadPrices, MOCK_PROVIDER_DISCLAIMER } from '@potion/providers';
import { sha256, StrategyConfigSchema, type PriceTable, type StrategyConfig } from '@potion/core';
import { createDb, insertJudgeCalibration, migrate } from '@potion/db';
import { BudgetCapError } from './estimate.js';
import { CALIBRATION_RUBRIC, runJudgeCalibration } from './calibrate.js';
import { loadSuiteV2 } from './ingest/suite-v2.js';
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
    case 'program':
      return `program:${cfg.name}`;
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
  /** Judge aliases for --calibrate (repeatable); empty → mock pair default. */
  judges: string[];
  /** Answerer alias for --calibrate; undefined → mock-cheap default. */
  calibrateAnswerer: string | undefined;
  /** Max items for --calibrate (G0.5: replaces the silent slice(0,30)). */
  calibrateN: number;
  /** Judge completion budget for --calibrate (verbose judges). */
  judgeMaxTokens: number | undefined;
  /** G1.4: reference-anchored calibration (replay-judging parity). */
  referenceAnchored: boolean;
  /** G1.7: judge-model override for the RUN path (derived suites bake the
   * nightly judge alias). */
  judgeModel: string | undefined;
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { suites: [], suitesV2: [], strategies: [], cap: NaN, provider: 'mock', calibrate: false, resume: false, simulatedOk: false, maxOutputTokens: undefined, judges: [], calibrateAnswerer: undefined, calibrateN: 30, judgeMaxTokens: undefined, referenceAnchored: false, judgeModel: undefined };
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
      case '--judge':
        args.judges.push(next());
        break;
      case '--answerer':
        args.calibrateAnswerer = next();
        break;
      case '--judge-model':
        args.judgeModel = next();
        break;
      case '--reference-anchored':
        args.referenceAnchored = true;
        break;
      case '--judge-max-tokens': {
        const v = Number(next());
        if (!Number.isInteger(v) || v <= 0) throw new Error('--judge-max-tokens must be a positive integer');
        args.judgeMaxTokens = v;
        break;
      }
      case '--calibrate-n': {
        const v = Number(next());
        if (!Number.isInteger(v) || v <= 0) throw new Error('--calibrate-n must be a positive integer');
        args.calibrateN = v;
        break;
      }
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
  // G0.2: --calibrate is a standalone mode — strategies optional (legacy
  // eval-then-calibrate still works when strategies are given).
  if (args.strategies.length === 0 && !args.calibrate) throw new Error('at least one --strategy is required');
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
  let summary: RunSummary | null = null;
  try {
    if (args.strategies.length > 0) summary = await runEval(
      {
        suiteIds: args.suites,
        suiteV2Ids: args.suitesV2,
        strategies: args.strategies,
        budgetCapUsd: args.cap,
        provider: args.provider,
        resume: args.resume,
        simulatedOk: args.simulatedOk,
        ...(args.maxOutputTokens !== undefined ? { maxOutputTokens: args.maxOutputTokens } : {}),
        // G1.7: judge budget + judge override reach the RUN path too.
        ...(args.judgeMaxTokens !== undefined ? { judgeMaxTokens: args.judgeMaxTokens } : {}),
        ...(args.judgeModel !== undefined ? { judgeModelOverride: args.judgeModel } : {}),
      },
      {},
    );
    if (summary?.simulated) console.log(`\n${simulatedBanner(summary)}\n`);
    if (summary) {
      console.log(`\nrun ${summary.runId} — projected $${summary.projectedSpendUsd.toFixed(4)} / cap $${args.cap.toFixed(2)} — spend $${summary.spendUsd.toFixed(4)} (${summary.executed} executed, ${summary.cacheHits} cache hits, ${summary.skipped.length} skipped)\n`);
      for (const s of summary.skipped) console.warn(`  skipped '${s.itemId}': ${s.reason}`);
      console.log(formatResultsTable(summary));
      if (summary.simulated) console.log(`\n${simulatedBanner(summary)}\n`);
    }
  } catch (e) {
    if (e instanceof BudgetCapError || e instanceof SimulatedSuiteError) {
      console.error(`\nREFUSED: ${e.message}\n`);
      return 2;
    }
    throw e;
  }

  if (args.calibrate) {
    // G0.2: standalone judge-truth calibration — v1 AND v2 suites, real or
    // mock judges, preflight-capped, persisted, LOUD on flag (exit 3).
    let report;
    let calClusterId: string | null = null;
    try {
      const items = (
      args.suites.length > 0
        ? (() => {
            const resolved = resolveSuite(args.suites[0]!);
            // M1a quarantine holds here too: simulated suites are CI
            // simulations and need the same explicit acknowledgment.
            if (resolved.simulated && !args.simulatedOk) throw new SimulatedSuiteError([resolved.suiteId]);
            return loadSuiteFile(resolved.path, resolved.suiteId);
          })()
        : loadSuiteV2(args.suitesV2[0]!).items
      ).slice(0, args.calibrateN);
      calClusterId = items[0]?.clusterId ?? null;
      const prices = loadPrices().table;
    const judges =
      args.judges.length > 0
        ? args.judges
        : args.provider === 'live'
          ? ['judge-class']
          : undefined;
      const providers = args.provider === 'live' ? createLiveCalibrationProviders(prices) : undefined;
      report = await runJudgeCalibration(items, {
        prices,
        ...(judges !== undefined ? { judgeModels: judges } : {}),
        ...(providers !== undefined ? { providers } : {}),
        ...(args.calibrateAnswerer !== undefined ? { answererModel: args.calibrateAnswerer } : {}),
        ...(args.judgeMaxTokens !== undefined ? { judgeMaxTokens: args.judgeMaxTokens } : {}),
        ...(args.referenceAnchored ? { referenceAnchored: true } : {}),
        // G2.4: the recorded mode gates alias eligibility — a live-stamped
        // calibration refuses mock judges/answerers instead of silently
        // calibrating against mock-cheap output.
        providerMode: args.provider,
        budgetCapUsd: args.cap,
      });
    } catch (e) {
      if (e instanceof BudgetCapError || e instanceof SimulatedSuiteError) {
        console.error(`\nREFUSED: ${e.message}\n`);
        return 2;
      }
      throw e;
    }
    console.log(
      `\njudge calibration vs DETERMINISTIC truth — ${report.n} items, answerer ${report.answererModel}, spend $${report.spendUsd.toFixed(4)}`,
    );
    for (const t of report.truth) {
      const pearsonLabel =
        t.pearsonVsTruth === null
          ? 'INDETERMINATE (constant truth — harder suite or weaker answerer needed)'
          : `pearson-vs-truth = ${t.pearsonVsTruth.toFixed(3)}, spearman = ${(t.spearmanVsTruth ?? 0).toFixed(3)}`;
      // THREE outcomes, not two. A run whose CI spans the bar established
      // nothing, and printing OK for it is how a guarantee ends up standing on
      // an unanswered question — the interval, not the point, is the verdict.
      const ci = t.pearsonCi95 ? ` CI95 [${t.pearsonCi95[0].toFixed(3)}, ${t.pearsonCi95[1].toFixed(3)}]` : '';
      const verdict = t.trustIndeterminateAtN
        ? `INDETERMINATE AT n=${report.n} ⚠ (interval spans 0.8 — more items needed to answer)`
        : t.flagged
          ? 'FLAGGED ⚠'
          : 'OK';
      console.log(
        `  ${t.judgeModel} (${t.resolvedModel}): ${pearsonLabel}${ci}, ` +
          `meanAbsErr = ${t.meanAbsErr.toFixed(3)} ${verdict}`,
      );
    }
    if (report.judges.length > 1) {
      console.log(`  agreement ${report.judgeA} vs ${report.judgeB} = ${report.pearson.toFixed(3)}`);
    }
    for (const sk of report.skipped) console.warn(`  skipped '${sk.itemId}': ${sk.reason}`);
    // Persist the evidence record (one row per judge).
    const handle = await createDb();
    try {
      await migrate(handle.db);
      const clusterId = calClusterId;
      const suiteId = args.suites[0] ?? args.suitesV2[0] ?? null;
      for (const t of report.truth) {
        await insertJudgeCalibration(handle.db, {
          clusterId,
          suiteId,
          judgeModel: t.judgeModel,
          judgeResolvedModel: t.resolvedModel,
          answererModel: report.answererModel,
          pricesVersion: report.pricesVersion,
          providerMode: args.provider,
          n: report.n,
          pearsonVsTruth: t.pearsonVsTruth,
          spearmanVsTruth: t.spearmanVsTruth,
          judgeAgreement: report.judges.length > 1 ? report.pearson : null,
          meanAbsErr: t.meanAbsErr,
          // G2.8: the intervals travel with the point estimates, so a later
          // reader can tell a measured verdict from an underpowered one.
          pearsonCi95: t.pearsonCi95,
          spearmanCi95: t.spearmanCi95,
          correlationSeed: t.correlationSeed,
          flagged: t.flagged,
          spendUsd: report.spendUsd,
          pairs: report.pairs.map((p) => ({ itemId: p.itemId, truth: p.truth, scores: p.scores })),
          // G1.5: the rubric the judge was calibrated UNDER — a rubric edit
          // must never inherit old trust evidence.
          rubricHash: sha256(CALIBRATION_RUBRIC),
        });
      }
      console.log(`  persisted ${report.truth.length} judge_calibrations record(s) (provider_mode=${args.provider})`);
    } finally {
      await handle.close();
    }
    if (report.flagged) {
      const anyStraddle = report.truth.some((t) => t.trustIndeterminateAtN);
      console.error(
        anyStraddle
          ? '\nCALIBRATION INDETERMINATE — the CI95 spans the 0.8 bar, so this run did NOT ' +
              'establish judge trust either way. Do not stand a guarantee on it; re-run with ' +
              'more items.\n'
          : '\nCALIBRATION FLAGGED — judge trust below 0.8; do not stand a guarantee on this judge.\n',
      );
      return 3;
    }
  }
  console.log('');
  return 0;
}

/** Live provider set for calibration: factory env-key fallback (M1b fix)
 * covers OPENAI_API_KEY etc.; resilient wrappers included. */
function createLiveCalibrationProviders(prices: PriceTable) {
  return createProviders({ prices });
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
