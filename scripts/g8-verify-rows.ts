const { createDb, judgeCalibrations } = await import('@potion/db');
const h = await createDb(process.env.DATABASE_URL);
const rows = await h.db.select().from(judgeCalibrations);
console.log('judge_calibrations rows:', rows.length);
for (const r of rows.slice(-12)) {
  console.log(
    ` ${(r.clusterId ?? '?').padEnd(16)} ${r.judgeModel.padEnd(16)} n=${r.n} r=${r.pearsonVsTruth === null ? 'null' : r.pearsonVsTruth.toFixed(3)} anchored=${String((r as Record<string, unknown>).referenceAnchored ?? '?')} flagged=${r.flagged}`,
  );
}
await h.close?.();
