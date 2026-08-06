// Ingest CLI (ROADMAP M1a):
//   pnpm --filter @potion/harness ingest -- --source humaneval --file <path> --out suites/v2/<id> [flags]
//
// Flags:
//   --source <kind>            adapter key: humaneval | jsonl-authored   [required]
//   --file <path>              input file (JSONL)                        [required]
//   --out <dir>                output suite dir; suiteId = basename      [required]
//   --cluster <clusterId>      target cluster (default: code-gen)
//   --version <semver>         suite version (default: 1.0.0)
//   --id-prefix <prefix>       prepended to item ids (stability by prefixing)
//   --transpile-js <path>      humaneval only: JSON map task_id → {entryPoint, solution, tests}
//   --source-kind <kind>       provenance override: public-benchmark | authored
//   --source-name <name>       provenance override
//   --license <spdx-or-note>   provenance override
//   --uri <url>                provenance override
//
// Writes <out>/manifest.json + <out>/items.jsonl. Pure conversion logic lives
// in ./adapters.ts — this file is IO + arg parsing only.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { getAdapter, ingest, type IngestRequest } from './adapters.js';
import { JsTranspilationMapSchema } from './humaneval.js';
import { SUITE_ID_RE } from './manifest.js';

interface CliArgs {
  source: string;
  file: string;
  out: string;
  cluster: string;
  version?: string;
  idPrefix?: string;
  transpileJs?: string;
  sourceKind?: 'public-benchmark' | 'authored';
  sourceName?: string;
  license?: string;
  uri?: string;
}

export function parseIngestArgs(argv: string[]): CliArgs {
  // pnpm forwards the script separator literally (`pnpm ingest -- --source …`).
  const args: Partial<CliArgs> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--') continue;
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`missing value for ${a}`);
      return v;
    };
    switch (a) {
      case '--source':
        args.source = next();
        break;
      case '--file':
        args.file = next();
        break;
      case '--out':
        args.out = next();
        break;
      case '--cluster':
        args.cluster = next();
        break;
      case '--version':
        args.version = next();
        break;
      case '--id-prefix':
        args.idPrefix = next();
        break;
      case '--transpile-js':
        args.transpileJs = next();
        break;
      case '--source-kind': {
        const v = next();
        if (v !== 'public-benchmark' && v !== 'authored') {
          throw new Error(`--source-kind must be 'public-benchmark' or 'authored' (got '${v}')`);
        }
        args.sourceKind = v;
        break;
      }
      case '--source-name':
        args.sourceName = next();
        break;
      case '--license':
        args.license = next();
        break;
      case '--uri':
        args.uri = next();
        break;
      default:
        throw new Error(`unknown flag '${a}'`);
    }
  }
  if (!args.source) throw new Error('--source is required');
  if (!args.file) throw new Error('--file is required');
  if (!args.out) throw new Error('--out is required');
  return { cluster: 'code-gen', ...args } as CliArgs;
}

export function runIngest(args: CliArgs): { outDir: string; itemCount: number; warnings: string[] } {
  const adapter = getAdapter(args.source);
  const suiteId = basename(resolve(args.out));
  if (!SUITE_ID_RE.test(suiteId)) {
    throw new Error(`--out basename must be a valid suite id ([a-z0-9-]+), got '${suiteId}'`);
  }
  const raw = readFileSync(args.file, 'utf8');
  const req: IngestRequest = {
    suiteId,
    clusterId: args.cluster,
    version: args.version,
    idPrefix: args.idPrefix,
    source: {
      ...(args.sourceKind ? { kind: args.sourceKind } : {}),
      ...(args.sourceName ? { name: args.sourceName } : {}),
      ...(args.license ? { license: args.license } : {}),
      ...(args.uri ? { uri: args.uri } : {}),
    },
    transpilations: args.transpileJs
      ? JsTranspilationMapSchema.parse(JSON.parse(readFileSync(args.transpileJs, 'utf8')))
      : undefined,
  };
  const result = ingest(adapter.source, raw, req);

  const outDir = resolve(args.out);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(`${outDir}/manifest.json`, JSON.stringify(result.manifest, null, 2) + '\n');
  writeFileSync(
    `${outDir}/items.jsonl`,
    result.items.map((i) => JSON.stringify(i)).join('\n') + '\n',
  );
  return { outDir, itemCount: result.items.length, warnings: result.warnings };
}

export function main(argv: string[]): number {
  const args = parseIngestArgs(argv);
  const { outDir, itemCount, warnings } = runIngest(args);
  console.log(`ingested ${itemCount} item(s) → ${outDir}`);
  console.log(`  wrote manifest.json + items.jsonl`);
  for (const w of warnings) console.warn(`  WARNING: ${w}`);
  return 0;
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '');
if (isMain) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  }
}
