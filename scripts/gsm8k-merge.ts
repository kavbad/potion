// GSM8K compile leg: merge eval_results cells measured in parallel stores into
// the publishing store. Cache keys are content-addressed (strategy|item|judge|
// prices|live|salt) and carry no store identity, so a merged cell is a $0
// resume hit for the final publishing leg.
//   npx tsx scripts/gsm8k-merge.ts <target-store> <source-store>...
import { evalResults } from '@potion/db';
const { createDb, migrate } = await import('@potion/db');
const [, , target, ...sources] = process.argv;
if (!target || sources.length === 0) throw new Error('usage: gsm8k-merge.ts <target> <source>...');
const rows: (typeof evalResults.$inferSelect)[] = [];
for (const src of sources) {
  const h = await createDb(`pglite://${src}`);
  const r = await h.db.select().from(evalResults);
  console.log(`${src}: ${r.length} cells`);
  rows.push(...r);
  await h.close?.();
}
const t = await createDb(`pglite://${target}`);
await migrate(t.db);
let inserted = 0;
for (let i = 0; i < rows.length; i += 200) {
  const chunk = rows.slice(i, i + 200);
  const res = await t.db.insert(evalResults).values(chunk).onConflictDoNothing().returning({ k: evalResults.cacheKey });
  inserted += res.length;
}
const total = await t.db.select().from(evalResults);
console.log(`merged: inserted ${inserted} new cells → target now holds ${total.length}`);
await t.close?.();
