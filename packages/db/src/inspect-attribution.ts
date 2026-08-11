// F12 operator diagnostic: does a database carry the re-attribution
// fingerprint left by the pre-ledger boot path?
//
//   pnpm --filter @potion/db inspect-attribution <dir-of-pglite-instances>
//
// READ-ONLY by construction — it issues SELECTs and never migrates. Even so,
// point it at COPIES: opening a PGlite directory is not a neutral act, and
// the curated verdict trail under .pglite/ must never be opened in place.
//
// Reading the output:
//   provable-reattributed  rows attributed to an org but created BEFORE that
//                          org existed. Impossible unless something moved
//                          them. This is the only sound signal.
//   ambiguous              rows attributed to the org that owns their
//                          cluster, created after the org. This is ALSO the
//                          normal shape of legitimate org-owned evidence, so
//                          a nonzero count here is not by itself a finding.
//
// The detection is ONE-SIDED: `SET org_id = c.org_id WHERE org_id IS NULL`
// destroyed the bit that said "platform", so absence of the fingerprint is
// consistent with no damage but does not prove it. Say so when reporting.
import { readdirSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { createDb } from './db.js';

const ROOT = process.argv[2]!;

const PROBE = `
SELECT 'frontiers' AS tbl,
       count(*) FILTER (WHERE f.created_at::timestamptz < o.created_at)::int AS provable,
       count(*) FILTER (WHERE f.created_at::timestamptz >= o.created_at)::int AS ambiguous
FROM frontiers f JOIN clusters c ON c.id = f.cluster_id JOIN orgs o ON o.id = f.org_id
WHERE f.org_id IS NOT NULL AND c.org_id = f.org_id
UNION ALL
SELECT 'eval_results',
       count(*) FILTER (WHERE e.created_at::timestamptz < o.created_at)::int,
       count(*) FILTER (WHERE e.created_at::timestamptz >= o.created_at)::int
FROM eval_results e JOIN clusters c ON c.id = e.cluster_id JOIN orgs o ON o.id = e.org_id
WHERE e.org_id IS NOT NULL AND c.org_id = e.org_id`;

async function main() {
  for (const name of readdirSync(ROOT).sort()) {
    process.stdout.write(`\n=== ${name} ===\n`);
    let h;
    try {
      h = await createDb(`pglite://${ROOT}/${name}`);
    } catch (e) {
      console.log(`  could not open: ${(e as Error).message.slice(0, 80)}`);
      continue;
    }
    try {
      const orgs = await h.db.execute(sql.raw('SELECT count(*)::int AS n FROM orgs'));
      const nOrgs = (orgs as unknown as { rows: Array<{ n: number }> }).rows[0]!.n;
      const verdicts = await h.db.execute(
        sql.raw("SELECT count(*)::int AS n FROM guarantee_verdicts"),
      ).catch(() => ({ rows: [{ n: -1 }] }));
      const nV = (verdicts as unknown as { rows: Array<{ n: number }> }).rows[0]!.n;
      const vuln = await h.db.execute(sql.raw(`
        SELECT (SELECT count(*)::int FROM frontiers WHERE org_id IS NULL) AS plat_f_total,
               (SELECT count(*)::int FROM frontiers f JOIN clusters c ON c.id=f.cluster_id
                  WHERE f.org_id IS NULL AND c.org_id IS NOT NULL) AS plat_f_on_org_cluster,
               (SELECT count(*)::int FROM eval_results WHERE org_id IS NULL) AS plat_e_total,
               (SELECT count(*)::int FROM eval_results e JOIN clusters c ON c.id=e.cluster_id
                  WHERE e.org_id IS NULL AND c.org_id IS NOT NULL) AS plat_e_on_org_cluster,
               (SELECT count(*)::int FROM clusters WHERE org_id IS NOT NULL) AS org_clusters`));
      const v = (vuln as unknown as { rows: Array<Record<string, unknown>> }).rows[0]!;
      console.log(`  org-owned clusters=${v.org_clusters}; platform frontiers=${v.plat_f_total} (on org clusters: ${v.plat_f_on_org_cluster}); platform evals=${v.plat_e_total} (on org clusters: ${v.plat_e_on_org_cluster})`);
      const res = await h.db.execute(sql.raw(PROBE));
      const rows = (res as unknown as { rows: Array<Record<string, unknown>> }).rows;
      console.log(`  orgs=${nOrgs} guarantee_verdicts=${nV}`);
      for (const r of rows) {
        console.log(`  ${r.tbl}: provable-reattributed=${r.provable} ambiguous=${r.ambiguous}`);
      }
    } catch (e) {
      console.log(`  probe failed: ${(e as Error).message.slice(0, 120)}`);
    }
    await h.close();
  }
}
void main();
