// The price-drift watcher (agenda item B, 2026-08-23). Quality has canaries;
// cost had nothing: a frontier point's costPer1K is frozen at measurement
// time while the upstream reprices continuously. This compares the measured
// roster's stored prices against the live catalog and reports movers, so a
// stale price is a line in a report instead of a silent lie on a receipt.
import type { PriceTable } from '@potion/core';

export interface CatalogListing {
  id: string;
  promptPerToken?: number;
  completionPerToken?: number;
}

export interface PriceMover {
  alias: string;
  model: string;
  storedInPer1M: number;
  storedOutPer1M: number;
  liveInPer1M: number;
  liveOutPer1M: number;
  /** Blended 25/75 in/out change, live vs stored, as a fraction (+ = pricier). */
  blendedDelta: number;
}

export interface PriceDriftReport {
  checked: number;
  movers: PriceMover[];
  /** Roster models the live catalog no longer lists — a louder alarm than a
   * price change: the model may be going away. */
  missing: string[];
  markdown: string;
}

const blend = (inP: number, outP: number) => 0.25 * inP + 0.75 * outP;

export function priceDriftReport(
  roster: PriceTable,
  listings: CatalogListing[],
  thresholdPct = 10,
  now = 'today',
): PriceDriftReport {
  const byId = new Map(listings.map((l) => [l.id, l]));
  const movers: PriceMover[] = [];
  const missing: string[] = [];
  let checked = 0;
  for (const e of roster.entries) {
    if (e.provider !== 'openrouter' || /-class$/.test(e.alias)) continue;
    checked++;
    const live = byId.get(e.model);
    if (!live || live.promptPerToken === undefined || live.completionPerToken === undefined) {
      missing.push(e.alias);
      continue;
    }
    const liveIn = live.promptPerToken * 1e6;
    const liveOut = live.completionPerToken * 1e6;
    const stored = blend(e.inputPer1M, e.outputPer1M);
    if (stored <= 0) continue;
    const delta = (blend(liveIn, liveOut) - stored) / stored;
    if (Math.abs(delta) * 100 >= thresholdPct) {
      movers.push({ alias: e.alias, model: e.model, storedInPer1M: e.inputPer1M, storedOutPer1M: e.outputPer1M, liveInPer1M: liveIn, liveOutPer1M: liveOut, blendedDelta: delta });
    }
  }
  movers.sort((a, b) => Math.abs(b.blendedDelta) - Math.abs(a.blendedDelta));
  const lines = [
    `# Price drift — ${now}`,
    '',
    `${checked} measured OpenRouter models checked against the live catalog; threshold ±${thresholdPct}%.`,
    '',
    movers.length === 0 ? 'No movers. Stored prices hold.' : `## ${movers.length} mover${movers.length === 1 ? '' : 's'}`,
    ...(movers.length > 0
      ? ['', '| alias | stored in/out per 1M | live in/out per 1M | blended Δ |', '|---|---|---|---|',
         ...movers.map((m) => `| ${m.alias} | $${m.storedInPer1M}/$${m.storedOutPer1M} | $${m.liveInPer1M.toFixed(2)}/$${m.liveOutPer1M.toFixed(2)} | ${(m.blendedDelta * 100).toFixed(1)}% |`)]
      : []),
    ...(missing.length > 0 ? ['', `## No longer listed upstream`, '', missing.map((m) => `\`${m}\``).join(' · '), '', 'A missing listing is louder than a price change — the model may be going away; re-measure or retire the point.'] : []),
    '',
    'A mover on a frontier model means the frontier’s cost axis is stale: re-measure the cluster or re-price the point before the next receipt cites it.',
    '',
  ];
  return { checked, movers, missing, markdown: lines.join('\n') };
}
