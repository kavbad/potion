// M1a item 3 tests: rebuild-centroids script — dry-run prints per-cluster
// centroid norms and writes NOTHING; write mode upserts cluster_exemplars
// idempotently on PGlite with the mock embedder (zero network).
import { describe, expect, it } from 'vitest';
import { mockEmbedText } from '@potion/providers';
import { clusterExemplars, clusters, createDb, migrate } from '@potion/db';
import { parseRebuildArgs, runRebuildCentroids, type RebuildDeps } from './rebuild-centroids.js';
import type { EmbedderProviders } from './embedder-config.js';

const MOCK_PROVIDERS: EmbedderProviders = {
  mock: { embed: async (texts) => texts.map(mockEmbedText) },
};

function deps(extra: Partial<RebuildDeps> = {}) {
  const lines: string[] = [];
  const d: RebuildDeps = {
    env: {}, // no keys → mock embedder
    providers: MOCK_PROVIDERS,
    log: (m) => lines.push(m),
    ...extra,
  };
  return { deps: d, lines };
}

describe('parseRebuildArgs', () => {
  it('parses --dry-run and --taxonomy', () => {
    expect(parseRebuildArgs([])).toEqual({ dryRun: false, taxonomyPath: expect.any(String) });
    expect(parseRebuildArgs(['--dry-run']).dryRun).toBe(true);
    expect(parseRebuildArgs(['--taxonomy', '/tmp/t.json']).taxonomyPath).toBe('/tmp/t.json');
    expect(parseRebuildArgs(['--taxonomy=/tmp/t.json']).taxonomyPath).toBe('/tmp/t.json');
  });

  it('rejects unknown flags', () => {
    expect(() => parseRebuildArgs(['--write-everything'])).toThrowError(/unknown flag/);
  });
});

describe('runRebuildCentroids', () => {
  it('dry-run: prints per-cluster centroid norms and writes nothing', async () => {
    const handle = await createDb();
    try {
      await migrate(handle.db);
      const { deps: d, lines } = deps({ db: handle });
      const result = await runRebuildCentroids(['--dry-run'], d);

      expect(result.dryRun).toBe(true);
      expect(result.mode).toBe('mock');
      expect(result.dims).toBe(384);
      expect(result.clusters).toBe(10); // shipped taxonomy
      expect(result.exemplars).toBeGreaterThan(0);

      // per-cluster norm lines: mock embeddings are unit-norm and keyword
      // clustered, so the exemplar-mean norm is a healthy fraction of 1 (some
      // taxonomy clusters span several mock seed clusters, so the bound is
      // loose) and the final L2-normalized centroid norm is exactly 1.
      const clusterLines = lines.filter((l) => l.includes('meanNorm='));
      expect(clusterLines).toHaveLength(10);
      for (const line of clusterLines) {
        const meanNorm = Number(/meanNorm=([\d.]+)/.exec(line)?.[1]);
        const centroidNorm = Number(/centroidNorm=([\d.]+)/.exec(line)?.[1]);
        expect(meanNorm).toBeGreaterThan(0.5);
        expect(meanNorm).toBeLessThanOrEqual(1);
        expect(centroidNorm).toBe(1);
      }
      expect(lines.some((l) => l.includes('mode=mock'))).toBe(true);
      expect(lines.some((l) => l.includes('dry-run') && l.includes('no writes'))).toBe(true);

      // nothing written
      expect(await handle.db.select().from(clusters)).toHaveLength(0);
      expect(await handle.db.select().from(clusterExemplars)).toHaveLength(0);
    } finally {
      await handle.close();
    }
  }, 60_000);

  it('write mode upserts cluster + exemplar rows idempotently', async () => {
    const handle = await createDb();
    try {
      const first = await runRebuildCentroids([], deps({ db: handle }).deps);
      expect(first.dryRun).toBe(false);
      const clusterRows1 = await handle.db.select().from(clusters);
      const exemplarRows1 = await handle.db.select().from(clusterExemplars);
      expect(clusterRows1).toHaveLength(10);
      expect(exemplarRows1.length).toBe(first.exemplars);
      for (const row of exemplarRows1) {
        expect(row.embedding).toHaveLength(384); // vector(384) canonical column
      }

      // second run: same counts (delete+reinsert, upsert) — no duplication.
      await runRebuildCentroids([], deps({ db: handle }).deps);
      expect(await handle.db.select().from(clusters)).toHaveLength(10);
      expect(await handle.db.select().from(clusterExemplars)).toHaveLength(first.exemplars);
    } finally {
      await handle.close();
    }
  }, 60_000);
});
