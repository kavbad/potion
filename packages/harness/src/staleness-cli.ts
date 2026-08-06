// Staleness CLI (ROADMAP M1a item 6):
//   pnpm --filter @potion/harness staleness -- [--check] [--prices-version <v>]
//     [--judge-model <m>] [--model-versions '{"alias":"version"}'] [--db <url>]
//
//   --check            dry run: print counts of stale rows by cause, modify nothing
//   --prices-version   current prices.json version (default: loaded from prices.json)
//   --judge-model      current judge model; llm-judge rows scored otherwise flag
//   --model-versions   JSON object alias → current resolved version
//   --db               database url (default: DATABASE_URL env, else in-memory PGlite)
//
// Without --check the matching rows are marked stale=true (idempotent).
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createDb, migrate } from '@potion/db';
import { loadPrices } from '@potion/providers';
import { markStale, stalenessReport, type StalenessCurrent, type StaleCounts } from './staleness.js';

/** Default current prices version comes from prices.json — the repo-root
 * copy, so the CLI works from any cwd (pnpm --filter runs in the package). */
function defaultPricesVersion(): string {
  const cwdPath = `${process.cwd()}/prices.json`;
  const repoPath = fileURLToPath(new URL('../../../prices.json', import.meta.url));
  return loadPrices(existsSync(cwdPath) ? cwdPath : repoPath).table.version;
}

interface CliArgs {
  check: boolean;
  pricesVersion?: string;
  judgeModel?: string;
  modelVersions?: Record<string, string>;
  db?: string;
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { check: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`missing value for ${a}`);
      return v;
    };
    switch (a) {
      case '--': // pnpm inserts a literal separator: `pnpm ... staleness -- --check`
        break;
      case '--check':
        args.check = true;
        break;
      case '--prices-version':
        args.pricesVersion = next();
        break;
      case '--judge-model':
        args.judgeModel = next();
        break;
      case '--model-versions': {
        const raw: unknown = JSON.parse(next());
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
          throw new Error('--model-versions must be a JSON object {"alias":"version"}');
        }
        args.modelVersions = raw as Record<string, string>;
        break;
      }
      case '--db':
        args.db = next();
        break;
      default:
        throw new Error(`unknown flag '${a}'`);
    }
  }
  return args;
}

function fmtCounts(counts: StaleCounts, verb: string): string {
  return [
    `  pricesVersion mismatch: ${counts.byCause.pricesVersion}`,
    `  judgeModel mismatch:    ${counts.byCause.judgeModel}`,
    `  modelVersions mismatch: ${counts.byCause.modelVersions}`,
    `  total ${verb}:         ${counts.newlyFlagged}`,
  ].join('\n');
}

export async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const current: StalenessCurrent = {
    // Default the prices cause to the repo prices.json version.
    pricesVersion: args.pricesVersion ?? defaultPricesVersion(),
    ...(args.judgeModel !== undefined ? { judgeModel: args.judgeModel } : {}),
    ...(args.modelVersions !== undefined ? { modelVersions: args.modelVersions } : {}),
  };

  const handle = await createDb(args.db);
  try {
    await migrate(handle.db);
    console.log(
      `staleness ${args.check ? 'CHECK (dry run)' : 'MARK'} — db ${handle.driver}\n` +
        `current: pricesVersion=${current.pricesVersion}` +
        `${current.judgeModel ? ` judgeModel=${current.judgeModel}` : ''}` +
        `${current.modelVersions ? ` modelVersions=${JSON.stringify(current.modelVersions)}` : ''}`,
    );
    if (args.check) {
      const report = await stalenessReport(handle.db, current);
      console.log(
        `eval_results: ${report.scanned} rows scanned, ${report.alreadyStale} already stale\n` +
          fmtCounts(report, 'would flag') +
          `\n(no rows modified — re-run without --check to mark stale)`,
      );
    } else {
      const counts = await markStale(handle.db, current);
      console.log(
        `eval_results: ${counts.scanned} rows scanned, ${counts.alreadyStale} already stale\n` +
          fmtCounts(counts, 'newly marked stale'),
      );
    }
  } finally {
    await handle.close();
  }
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
