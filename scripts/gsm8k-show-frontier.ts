// Read back a published frontier: what the compiler emitted, and the lower
// bound each point is judged on under a min_cost floor (core/select.ts).
const { createDb, getLatestFrontier } = await import('@potion/db');
const h = await createDb(`pglite://${process.argv[2]}`);
const f = await getLatestFrontier(h.db, process.argv[3] ?? 'gsm8k', null, 'default' as never);
if (!f) console.log('NO FRONTIER');
else {
  console.log(`frontier ${f.id} v${f.version} trigger=${f.trigger} prices=${f.pricesVersion} points=${f.points.length}`);
  type Shape = { type: string; model?: string; name?: string; stages?: { model: string }[] };
  const label = (c: Shape): string =>
    c.type === 'single' ? String(c.model)
    : c.type === 'program' ? `program:${String(c.name)}`
    : c.type === 'cascade' ? `cascade:${(c.stages ?? []).map((s) => s.model).join('>')}`
    : String(c.type);
  for (const p of [...f.points].sort((a, b) => a.costPer1K - b.costPer1K)) {
    const ev = (p.evidence ?? {}) as { qualityCi95?: number; n?: number };
    const ci = ev.qualityCi95 ?? 0;
    console.log(`  ${label(p.strategyConfig as Shape).padEnd(44)} q=${p.quality.toFixed(3)} ci95=${ci.toFixed(3)} lowerBound=${(p.quality - ci).toFixed(3)} $${p.costPer1K.toFixed(4)}/1K p95=${Math.round(p.latencyP95)}ms n=${ev.n} ${p.providerMode}`);
  }
}
await h.close?.();
