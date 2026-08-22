// Frontier Notes — replay findings straight from a research store handle.
// The same query packages/workers/scripts/replay-mixtures.mts prints from,
// returned as data. $0: nothing here calls a provider.
import { replayCluster, type ClusterMatrix, type ClusterReplay } from '../replay.js';

export interface StoreLike {
  execute(sql: string): Promise<{ rows: unknown[] }>;
}

export async function loadReplaysFromStore(db: StoreLike, pricesVersion: string): Promise<ClusterReplay[]> {
  const rows = (
    await db.execute(`
      select cluster_id, item_id, strategy_config->>'model' as model, quality, confidence,
             coalesce((usage->>'costUsd')::double precision, 0) as cost_usd
      from eval_results
      where prices_version = '${pricesVersion.replace(/'/g, "''")}' and strategy_config->>'type' = 'single'
        and provider_mode = 'live' and org_id is null
    `)
  ).rows as Array<{ cluster_id: string; item_id: string; model: string; quality: number; confidence: number | null; cost_usd: number }>;
  const byCluster = new Map<string, ClusterMatrix>();
  for (const r of rows) {
    const m = byCluster.get(r.cluster_id) ?? new Map();
    byCluster.set(r.cluster_id, m);
    const row = m.get(r.item_id) ?? new Map();
    m.set(r.item_id, row);
    row.set(r.model, { quality: Number(r.quality), costUsd: Number(r.cost_usd), ...(r.confidence !== null ? { confidence: Number(r.confidence) } : {}) });
  }
  return [...byCluster.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([clusterId, matrix]) => replayCluster(clusterId, matrix));
}
