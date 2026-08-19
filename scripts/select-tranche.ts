// Choose WHICH models to measure — the part that cannot be automated by
// sorting on price.
//
// THE PROBLEM. Ingesting OpenRouter gives 349 servable models. Measuring all
// of them is ~$620 at S6's measured rate, and most of that buys noise: the
// catalogue is thick with variants, re-releases and tiny models nobody should
// route production traffic to. But we cannot rank by QUALITY first — that is
// what the measurement is for. So selection has to stand on structural
// grounds, not on a guess about which model is good.
//
// THE RULE, and why each part of it:
//   · one model per (VENDOR, CLASS) — vendor diversity is the thing the
//     current registry lacks most (3 vendors of 57), and twelve variants of
//     one family teach us far less than twelve vendors' flagships.
//   · within a (vendor, class), take the NEWEST — cheapest-within-vendor
//     picks that vendor's weakest entry, which is the opposite of what a
//     representative should be. Recency is a structural proxy for "the one
//     they would tell you to use", and it does not pretend to know quality.
//   · balanced ACROSS classes, so the measured frontier spans the cost axis
//     and a customer gets a real trade-off curve rather than a cluster of
//     similarly-priced options.
//   · tool-capable preferred within a tie, because agentic-tool-use is one of
//     the ten clusters and an untooled model cannot serve it at all.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fetchOpenRouterModels, loadPrices } from '@potion/providers';
import { classifyModel } from '@potion/researcher';
import type { PriceEntry } from '@potion/core';

const REPO = fileURLToPath(new URL('..', import.meta.url));
for (const line of readFileSync(`${REPO}/.env`, 'utf8').split('\n')) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
  if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.trim().replace(/^["']|["']$/g, '');
}
const apiKey = process.env.OPENROUTER_API_KEY!;
const PER_CLASS = Number(process.env.TRANCHE_PER_CLASS ?? 10);

const { table } = loadPrices(`${REPO}/prices.json`);
const known = new Set(table.entries.map((e) => e.model));
const listings = await fetchOpenRouterModels({ apiKey });

interface Cand { id: string; vendor: string; cls: string; inPer1M: number; outPer1M: number; created: number; tools: boolean }
const cands: Cand[] = [];
for (const l of listings) {
  if (known.has(l.id)) continue;
  if (l.promptPerToken === undefined || l.completionPerToken === undefined) continue;
  const inPer1M = l.promptPerToken * 1e6;
  const outPer1M = l.completionPerToken * 1e6;
  if (!(inPer1M > 0)) continue; // free tiers: rate-limited, not production serving
  // MOVING POINTERS are not measurable artifacts. `~vendor/x-latest` and
  // `…-latest` resolve to whatever the vendor ships today, so evidence
  // collected against one is untethered from the thing it measured the
  // moment the pointer moves — and every eval row here is content-addressed
  // precisely so that cannot happen. Measure the pinned release instead.
  if (l.id.startsWith('~') || /[-:]latest$/.test(l.id)) continue;
  const entry = { alias: `or-${l.id.split('/')[1] ?? l.id}`, provider: 'openrouter', model: l.id, inputPer1M: inPer1M, outputPer1M: outPer1M } as PriceEntry;
  cands.push({
    id: l.id, vendor: l.id.split('/')[0]!, cls: classifyModel(entry),
    inPer1M, outPer1M, created: l.created ?? 0,
    tools: (l.supportedParameters ?? []).includes('tools'),
  });
}

// newest per (vendor, class); tool-capable wins a tie on the same day
const best = new Map<string, Cand>();
for (const c of cands) {
  const k = `${c.vendor}|${c.cls}`;
  const cur = best.get(k);
  if (!cur || c.created > cur.created || (c.created === cur.created && c.tools && !cur.tools)) best.set(k, c);
}

const picked: Cand[] = [];
for (const cls of ['cheap', 'mid', 'strong']) {
  const pool = [...best.values()].filter((c) => c.cls === cls).sort((a, b) => b.created - a.created);
  picked.push(...pool.slice(0, PER_CLASS));
}

console.log(`candidates after exclusions : ${cands.length}`);
console.log(`vendor x class representatives: ${best.size}`);
console.log(`SELECTED                     : ${picked.length}  (${PER_CLASS}/class)\n`);
for (const cls of ['cheap', 'mid', 'strong']) {
  const rows = picked.filter((p) => p.cls === cls);
  console.log(`${cls.toUpperCase()} (${rows.length})`);
  for (const r of rows) {
    console.log(`  ${r.id.padEnd(46)} $${r.inPer1M.toFixed(3).padStart(8)}/1M in  ${r.tools ? 'tools' : '     '}  ${new Date(r.created * 1000).toISOString().slice(0, 10)}`);
  }
}
console.log(`\ndistinct vendors in tranche: ${new Set(picked.map((p) => p.vendor)).size}`);
