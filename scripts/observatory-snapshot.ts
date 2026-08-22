// Observatory invariant helper: print each platform cluster's latest frontier
// version in the research store. Run before and after a week; canaries must
// never move a version, only an audition that EARNS a slot may.
const { createDb } = await import('@potion/db');
const { sql } = await import('drizzle-orm');
const h = await createDb(`pglite://${process.env.OBSERVATORY_DB ?? '/research/store'}`);
const r = await h.db.execute(sql`select cluster_id, max(version) v from frontiers where org_id is null group by 1 order by 1`);
console.log((r.rows as Array<{ cluster_id: string; v: number }>).map((x) => `${x.cluster_id}:v${x.v}`).join(' '));
await h.close();
