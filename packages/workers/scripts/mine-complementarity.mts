// Observatory rung 1 — the complementarity miner (docs/OBSERVATORY.md §4).
//
// For every cluster with per-item single-model evidence at the given prices
// version: each pair's ORACLE-FUSION CEILING (mean of per-item max — right
// whenever either is right) against the best single, ranked by lift. High
// lift = decorrelated failures = a mixing asset; the Track B shortlist is
// this output, not a guess. $0: reads evidence already paid for.
//
// Usage:
//   DB_COPY=/path/to/pglite-copy [PRICES_VERSION=...] npx tsx scripts/mine-complementarity.mts
//
// ALWAYS run against a COPY of the campaign db, never the live directory —
// PGlite is single-writer and a second opener is the corruption class that
// cost this project ~$13 once already.
import { createDb } from '@potion/db';

const PV = process.env.PRICES_VERSION ?? '2026-08-04-or2+tranche-2026-08-19';
const dbPath = process.env.DB_COPY;
if (!dbPath) throw new Error('set DB_COPY to a COPY of the campaign pglite dir');

const handle = await createDb(`pglite://${dbPath}`);
const rows = (await handle.db.execute(`
  select cluster_id, item_id, strategy_config->>'model' as model, quality
  from eval_results
  where prices_version = '${PV.replace(/'/g, "''")}' and strategy_config->>'type' = 'single'
`)).rows as Array<{ cluster_id: string; item_id: string; model: string; quality: number }>;
await handle.close();

const byCluster = new Map<string, Map<string, Map<string, number>>>();
for (const r of rows) {
  if (!r.model) continue;
  const c = byCluster.get(r.cluster_id) ?? new Map<string, Map<string, number>>();
  byCluster.set(r.cluster_id, c);
  const m = c.get(r.model) ?? new Map<string, number>();
  c.set(r.model, m);
  m.set(r.item_id, Number(r.quality));
}

for (const [cluster, models] of [...byCluster.entries()].sort()) {
  const names = [...models.keys()];
  if (names.length < 4) continue;
  const items = [...(models.get(names[0]!) ?? new Map<string, number>()).keys()].filter((it) =>
    names.every((n) => models.get(n)!.has(it)),
  );
  if (items.length < 10) continue;
  const mean = (n: string): number =>
    items.reduce((s, it) => s + models.get(n)!.get(it)!, 0) / items.length;
  const singles = names.map((n) => ({ n, q: mean(n) })).sort((a, b) => b.q - a.q);
  const best = singles[0]!;
  const pairs: Array<{ a: string; b: string; oracle: number; lift: number }> = [];
  for (let i = 0; i < names.length; i++)
    for (let j = i + 1; j < names.length; j++) {
      const A = models.get(names[i]!)!;
      const B = models.get(names[j]!)!;
      const oracle =
        items.reduce((s, it) => s + Math.max(A.get(it)!, B.get(it)!), 0) / items.length;
      pairs.push({ a: names[i]!, b: names[j]!, oracle, lift: oracle - best.q });
    }
  pairs.sort((x, y) => y.lift - x.lift);
  console.log(
    `\n=== ${cluster} (${items.length} items, ${names.length} models) — best single ${best.n} ${best.q.toFixed(3)} ===`,
  );
  for (const p of pairs.slice(0, 5))
    console.log(
      `  oracle ${p.oracle.toFixed(3)} (+${(p.lift * 100).toFixed(1)}pts)  ${p.a} + ${p.b}`,
    );
  if ((pairs[0]?.lift ?? 0) <= 0.001)
    console.log('  (no pair beats the best single — zero fusion headroom on this instrument)');
}
