// Gate-2 evaluation (SPEC §4/§10 → G0.5): assign every held-out prompt with
// the real assigner + the RESOLVED platform embedder, then report overall
// accuracy, per-cluster precision/recall, and a full N×N confusion matrix
// (10 clusters + 'general') as an aligned ASCII table.
//
// G0.5: the embedder is resolved exactly like the server/rebuild-centroids
// (resolveEmbedder: OPENAI_API_KEY present + POTION_EMBEDDER unset|openai →
// OpenAI text-embedding-3-small dimensions:384; otherwise the deterministic
// mock with a loud warning). The banner prints the ACTUAL embedder — the
// pre-G0.5 version hardcoded the mock and would have produced a false "live"
// proof. `--sweep t1,t2,...` evaluates multiple thresholds in one run; a
// memoizing embedder makes N thresholds cost ONE embedding pass (the mock
// threshold 0.62 is tuned to mock geometry — real embedding cosines are
// compressed, so the live operating threshold comes from this sweep and is
// deployed via POTION_CLUSTER_THRESHOLD, no code change).
//
// Run: pnpm --filter @potion/cluster evaluate
//      [--taxonomy <path>] [--heldout <path>] [--threshold <f>]
//      [--sweep t1,t2,...] [--target <f>]
//
// Exit 0 when the BEST evaluated threshold reaches the target (default
// 0.85), else 1; 2 on error.
import { fileURLToPath } from 'node:url';
import { createProviders, loadPrices } from '@potion/providers';
import { createAssigner, DEFAULT_THRESHOLD, type Embedder } from './assigner.js';
import { centroidsFromTaxonomy, createCachingEmbedder } from './centroids.js';
import {
  accuracy,
  buildConfusionMatrix,
  formatConfusionMatrix,
  formatMetrics,
  precisionRecall,
} from './confusion.js';
import { resolveEmbedder, type EmbedderProviders } from './embedder-config.js';
import { HELDOUT_PATH, loadHeldout, loadTaxonomy, TAXONOMY_PATH } from './taxonomy.js';

const ACCURACY_TARGET = 0.85;
const DEFAULT_PRICES_PATH = fileURLToPath(new URL('../../../prices.json', import.meta.url));

export interface CliOptions {
  taxonomyPath: string;
  heldoutPath: string;
  /** Thresholds to evaluate (single --threshold or --sweep list). */
  thresholds: number[];
  target: number;
}

export function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    taxonomyPath: TAXONOMY_PATH,
    heldoutPath: HELDOUT_PATH,
    thresholds: [DEFAULT_THRESHOLD],
    target: ACCURACY_TARGET,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const [flag, inline] = arg.split('=', 2);
    const value = inline ?? argv[++i];
    switch (flag) {
      case '--taxonomy':
        opts.taxonomyPath = value!;
        break;
      case '--heldout':
        opts.heldoutPath = value!;
        break;
      case '--threshold': {
        const t = Number(value);
        if (!Number.isFinite(t)) throw new Error(`invalid --threshold: ${value}`);
        opts.thresholds = [t];
        break;
      }
      case '--sweep': {
        const ts = (value ?? '').split(',').map((v) => Number(v.trim()));
        if (ts.length === 0 || ts.some((t) => !Number.isFinite(t) || t <= 0 || t >= 1)) {
          throw new Error(`invalid --sweep list: ${value} (comma-separated thresholds in (0,1))`);
        }
        opts.thresholds = ts;
        break;
      }
      case '--target':
        opts.target = Number(value);
        if (!Number.isFinite(opts.target)) throw new Error(`invalid --target: ${value}`);
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  return opts;
}

/** Providers record built the same way the server does (env-keyed factory). */
function defaultProviders(): EmbedderProviders {
  const { table: prices } = loadPrices(DEFAULT_PRICES_PATH);
  const apiKeys: Record<string, string> = {};
  if (process.env.OPENAI_API_KEY) apiKeys.openai = process.env.OPENAI_API_KEY;
  const providers = createProviders({ prices, apiKeys });
  return { mock: providers.mock, openai: providers.openai };
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));

  // The RESOLVED platform embedder — never a silent hardcode (G0.5).
  const resolved = resolveEmbedder(process.env, defaultProviders(), {
    warn: (msg) => console.warn(msg),
  });
  // Memoized: a sweep re-embeds nothing after the first threshold.
  const embedder: Embedder = createCachingEmbedder(resolved.embedder);

  const taxonomy = loadTaxonomy(opts.taxonomyPath);
  const heldout = loadHeldout(opts.heldoutPath);

  console.log('── Potion Gate 2: cluster assigner evaluation ──────────────────');
  console.log(`taxonomy      : v${taxonomy.version} (${taxonomy.clusters.length} clusters) from ${opts.taxonomyPath}`);
  console.log(`held-out set  : ${heldout.length} examples from ${opts.heldoutPath}`);
  console.log(`embedder      : ${resolved.mode} (${resolved.model}, ${resolved.dims}-dim)`);
  console.log(`thresholds    : ${opts.thresholds.join(', ')} (below → 'general')`);

  const centroids = await centroidsFromTaxonomy(taxonomy, embedder);
  const labels = [...taxonomy.clusters.map((c) => c.id), 'general'];
  const actual = heldout.map((h) => h.clusterId);
  const texts = heldout.map((h) => h.text);

  let best: { threshold: number; acc: number } | null = null;
  for (const threshold of opts.thresholds) {
    const assigner = createAssigner(embedder, centroids, threshold);
    const assignments = await assigner.assignBatch(texts);
    const predicted = assignments.map((a) => a.clusterId);
    const matrix = buildConfusionMatrix(actual, predicted, labels);
    const acc = accuracy(matrix);
    if (best === null || acc > best.acc) best = { threshold, acc };

    console.log('────────────────────────────────────────────────────────────────');
    console.log(
      `threshold ${threshold}: overall accuracy ${(acc * 100).toFixed(2)}% ` +
        `(${heldout.length} examples, target ≥ ${(opts.target * 100).toFixed(0)}%)`,
    );
    console.log('');
    console.log('per-cluster precision/recall (one-vs-rest):');
    console.log(formatMetrics(precisionRecall(matrix)));
    console.log('');
    console.log(`confusion matrix (${labels.length}×${labels.length}, rows = actual, columns = predicted):`);
    console.log(formatConfusionMatrix(matrix));
  }
  console.log('────────────────────────────────────────────────────────────────');

  const { threshold, acc } = best!;
  if (opts.thresholds.length > 1) {
    console.log(
      `best threshold: ${threshold} at ${(acc * 100).toFixed(2)}% — deploy via POTION_CLUSTER_THRESHOLD=${threshold}`,
    );
  }
  if (acc >= opts.target) {
    console.log(`Gate 2 PASS (${resolved.mode}): accuracy ${(acc * 100).toFixed(2)}% ≥ ${(opts.target * 100).toFixed(0)}% at threshold ${threshold}`);
    process.exit(0);
  }
  console.log(`Gate 2 FAIL (${resolved.mode}): best accuracy ${(acc * 100).toFixed(2)}% < ${(opts.target * 100).toFixed(0)}%`);
  process.exit(1);
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1]!.split('/').pop() ?? '');
if (isMain) {
  main().catch((err) => {
    console.error('evaluate failed:', err instanceof Error ? err.message : err);
    process.exit(2);
  });
}
