// Observatory invariant helper: print each platform cluster's latest frontier
// version in the research store. Run before and after a week; canaries must
// never move a version, only an audition that EARNS a slot may.
const { createDb, getLatestFrontier } = await import('@potion/db');
const { PLATFORM_SUITE_BY_CLUSTER } = await import('@potion/workers');
const h = await createDb(`pglite://${process.env.OBSERVATORY_DB ?? '/research/store'}`);
const out: string[] = [];
for (const clusterId of Object.keys(PLATFORM_SUITE_BY_CLUSTER).sort()) {
  const f = await getLatestFrontier(h.db, clusterId, null);
  out.push(`${clusterId}:v${f?.version ?? '-'}`);
}
console.log(out.join(' '));
await h.close();
