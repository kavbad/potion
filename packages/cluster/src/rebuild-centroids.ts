// Centroid rebuild script (ROADMAP M1a item 3): re-embeds the taxonomy
// exemplars with the RESOLVED platform embedder (resolveEmbedder — mock by
// default, OpenAI text-embedding-3-small dimensions:384 when configured) and
// upserts the clusters + cluster_exemplars rows (embedding vector(384)) so
// the db mirrors the canonical embedding space. Idempotent: exemplar rows are
// deleted+reinserted per cluster, cluster rows upserted by id.
//
// Run:  pnpm --filter @potion/cluster rebuild-centroids [--dry-run] [--taxonomy <path>]
//
// --dry-run prints per-cluster centroid norms (raw-mean norm = coherence
// signal; final centroids are L2-normalized to 1) WITHOUT writing anything.
import { fileURLToPath, pathToFileURL } from 'node:url';
import { eq } from 'drizzle-orm';
import {
  clusterExemplars,
  clusters,
  createDb,
  migrate,
  type DbHandle,
} from '@potion/db';
import { createProviders, loadPrices } from '@potion/providers';
import type { Embedder } from './assigner.js';
import { createCachingEmbedder } from './centroids.js';
import {
  resolveEmbedder,
  type EmbedderEnv,
  type EmbedderProviders,
  type ResolvedEmbedder,
} from './embedder-config.js';
import { loadTaxonomy, TAXONOMY_PATH } from './taxonomy.js';

/** Repo-root prices.json (packages/cluster/src → ../../../prices.json). */
const DEFAULT_PRICES_PATH = fileURLToPath(new URL('../../../prices.json', import.meta.url));

export interface RebuildOptions {
  dryRun: boolean;
  taxonomyPath: string;
}

export function parseRebuildArgs(argv: string[]): RebuildOptions {
  const opts: RebuildOptions = { dryRun: false, taxonomyPath: TAXONOMY_PATH };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const [flag, inline] = arg.split('=', 2);
    if (flag === '--dry-run') {
      opts.dryRun = true;
    } else if (flag === '--taxonomy') {
      opts.taxonomyPath = inline ?? argv[++i]!;
    } else {
      throw new Error(`unknown flag: ${arg} (supported: --dry-run, --taxonomy <path>)`);
    }
  }
  return opts;
}

function l2Norm(v: readonly number[]): number {
  let n = 0;
  for (const x of v) n += x * x;
  return Math.sqrt(n);
}

export interface RebuildDeps {
  /** Env for resolveEmbedder (default: process.env). */
  env?: EmbedderEnv;
  /** Providers record for resolveEmbedder (default: built from env keys). */
  providers?: EmbedderProviders;
  /** Injected db handle (tests); when absent one is created and closed. */
  db?: DbHandle;
  log?: (msg: string) => void;
}

export interface RebuildResult {
  mode: ResolvedEmbedder['mode'];
  model: string;
  dims: number;
  dryRun: boolean;
  clusters: number;
  exemplars: number;
}

/**
 * Build the providers record the same way the server does: env-keyed live
 * factory (mock provider is always present behind providers.mock).
 */
function defaultProviders(): EmbedderProviders {
  const { table: prices } = loadPrices(DEFAULT_PRICES_PATH);
  const apiKeys: Record<string, string> = {};
  if (process.env.OPENAI_API_KEY) apiKeys.openai = process.env.OPENAI_API_KEY;
  const providers = createProviders({ prices, apiKeys });
  return { mock: providers.mock, openai: providers.openai };
}

export async function runRebuildCentroids(
  argv: string[],
  deps: RebuildDeps = {},
): Promise<RebuildResult> {
  const opts = parseRebuildArgs(argv);
  const log = deps.log ?? ((msg: string) => console.log(msg));

  const resolved = resolveEmbedder(deps.env ?? process.env, deps.providers ?? defaultProviders(), {
    warn: log,
  });
  log(
    `rebuild-centroids: embedder mode=${resolved.mode} model=${resolved.model} dims=${resolved.dims}` +
      (opts.dryRun ? ' (dry-run)' : ''),
  );

  const taxonomy = loadTaxonomy(opts.taxonomyPath);
  const embedder: Embedder = createCachingEmbedder(resolved.embedder);

  // ---- embed every cluster's exemplars; compute mean + normalized centroid ----
  interface ClusterBuild {
    id: string;
    name: string;
    description: string;
    rows: Array<{ clusterId: string; text: string; embedding: number[] }>;
    meanNorm: number;
    centroidNorm: number;
  }
  const builds: ClusterBuild[] = [];
  let exemplarTotal = 0;
  for (const cluster of taxonomy.clusters) {
    const embeddings = await embedder.embed([...cluster.exemplars]);
    const dim = embeddings[0]?.length ?? 0;
    const mean = new Array<number>(dim).fill(0);
    for (const emb of embeddings) {
      for (let i = 0; i < dim; i++) mean[i] = (mean[i] ?? 0) + (emb[i] ?? 0);
    }
    for (let i = 0; i < dim; i++) mean[i] = (mean[i] ?? 0) / embeddings.length;
    const meanNorm = l2Norm(mean);
    const centroidNorm = meanNorm === 0 ? 0 : 1; // centroids are L2-normalized
    builds.push({
      id: cluster.id,
      name: cluster.name,
      description: cluster.description,
      rows: embeddings.map((embedding, i) => ({
        clusterId: cluster.id,
        text: cluster.exemplars[i]!,
        embedding,
      })),
      meanNorm,
      centroidNorm,
    });
    exemplarTotal += embeddings.length;
    log(
      `  ${cluster.id}: exemplars=${embeddings.length} meanNorm=${meanNorm.toFixed(4)} ` +
        `centroidNorm=${centroidNorm.toFixed(4)}`,
    );
  }

  if (opts.dryRun) {
    log(`dry-run: ${builds.length} clusters / ${exemplarTotal} exemplars embedded — no writes`);
    return {
      mode: resolved.mode,
      model: resolved.model,
      dims: resolved.dims,
      dryRun: true,
      clusters: builds.length,
      exemplars: exemplarTotal,
    };
  }

  // ---- write: upsert cluster rows, replace exemplar rows per cluster ----
  const ownDb = deps.db === undefined;
  const handle = deps.db ?? (await createDb());
  try {
    await migrate(handle.db);
    for (const build of builds) {
      await handle.db
        .insert(clusters)
        .values({
          id: build.id,
          name: build.name,
          description: build.description,
          exemplarCount: build.rows.length,
        })
        .onConflictDoUpdate({
          target: clusters.id,
          set: {
            name: build.name,
            description: build.description,
            exemplarCount: build.rows.length,
          },
        });
      await handle.db.delete(clusterExemplars).where(eq(clusterExemplars.clusterId, build.id));
      if (build.rows.length > 0) await handle.db.insert(clusterExemplars).values(build.rows);
    }
    log(`rebuilt centroids: ${builds.length} clusters / ${exemplarTotal} exemplars written`);
  } finally {
    if (ownDb) await handle.close();
  }
  return {
    mode: resolved.mode,
    model: resolved.model,
    dims: resolved.dims,
    dryRun: false,
    clusters: builds.length,
    exemplars: exemplarTotal,
  };
}

// Run as CLI only when executed directly (imported by tests without side effects).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runRebuildCentroids(process.argv.slice(2))
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('rebuild-centroids failed:', err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
