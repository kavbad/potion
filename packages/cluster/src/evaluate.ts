// Gate-2 evaluation (SPEC §4/§10): assign every held-out prompt with the real
// assigner + the deterministic MOCK embedder, then report overall accuracy,
// per-cluster precision/recall, and a full N×N confusion matrix (10 clusters
// + 'general') as an aligned ASCII table.
//
// Run: pnpm --filter @potion/cluster evaluate
//      [--taxonomy <path>] [--heldout <path>] [--threshold <f>] [--target <f>]
//
// Exit 0 when overall accuracy ≥ target (default 0.85), else 1.
import { mockEmbedText } from '@potion/providers';
import { createAssigner, DEFAULT_THRESHOLD, type Embedder } from './assigner.js';
import { centroidsFromTaxonomy } from './centroids.js';
import {
  accuracy,
  buildConfusionMatrix,
  formatConfusionMatrix,
  formatMetrics,
  precisionRecall,
} from './confusion.js';
import { HELDOUT_PATH, loadHeldout, loadTaxonomy, TAXONOMY_PATH } from './taxonomy.js';

const ACCURACY_TARGET = 0.85;

interface CliOptions {
  taxonomyPath: string;
  heldoutPath: string;
  threshold: number;
  target: number;
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    taxonomyPath: TAXONOMY_PATH,
    heldoutPath: HELDOUT_PATH,
    threshold: DEFAULT_THRESHOLD,
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
      case '--threshold':
        opts.threshold = Number(value);
        if (!Number.isFinite(opts.threshold)) throw new Error(`invalid --threshold: ${value}`);
        break;
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

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));

  // Deterministic mock embedder (SPEC §2/§4 contract) from @potion/providers.
  const embedder: Embedder = { embed: async (texts) => texts.map(mockEmbedText) };

  const taxonomy = loadTaxonomy(opts.taxonomyPath);
  const heldout = loadHeldout(opts.heldoutPath);

  console.log('── Potion Gate 2: cluster assigner evaluation ──────────────────');
  console.log(`taxonomy      : v${taxonomy.version} (${taxonomy.clusters.length} clusters) from ${opts.taxonomyPath}`);
  console.log(`held-out set  : ${heldout.length} examples from ${opts.heldoutPath}`);
  console.log(`embedder      : mock (deterministic, 384-dim, ‖noise‖ ≤ 0.15)`);
  console.log(`threshold     : ${opts.threshold} (below → 'general')`);

  const centroids = await centroidsFromTaxonomy(taxonomy, embedder);
  const assigner = createAssigner(embedder, centroids, opts.threshold);

  const assignments = await assigner.assignBatch(heldout.map((h) => h.text));
  const actual = heldout.map((h) => h.clusterId);
  const predicted = assignments.map((a) => a.clusterId);

  // Row/column order: taxonomy clusters in file order, 'general' last (the
  // fallback bucket is always a possible prediction even if never gold).
  const labels = [...taxonomy.clusters.map((c) => c.id), 'general'];
  const matrix = buildConfusionMatrix(actual, predicted, labels);
  const acc = accuracy(matrix);

  console.log('────────────────────────────────────────────────────────────────');
  console.log(`overall accuracy: ${(acc * 100).toFixed(2)}% (${heldout.length} examples, target ≥ ${(opts.target * 100).toFixed(0)}%)`);
  console.log('');
  console.log('per-cluster precision/recall (one-vs-rest):');
  console.log(formatMetrics(precisionRecall(matrix)));
  console.log('');
  console.log(`confusion matrix (${labels.length}×${labels.length}, rows = actual, columns = predicted):`);
  console.log(formatConfusionMatrix(matrix));
  console.log('────────────────────────────────────────────────────────────────');

  if (acc >= opts.target) {
    console.log(`Gate 2 PASS: accuracy ${(acc * 100).toFixed(2)}% ≥ ${(opts.target * 100).toFixed(0)}%`);
    process.exit(0);
  }
  console.log(`Gate 2 FAIL: accuracy ${(acc * 100).toFixed(2)}% < ${(opts.target * 100).toFixed(0)}%`);
  process.exit(1);
}

main().catch((err) => {
  console.error('evaluate failed:', err instanceof Error ? err.message : err);
  process.exit(2);
});
