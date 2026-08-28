// How the house talks about price against the premium counterfactual
// (2026-08-28, operator: "how the hell are we saving someone 99.7% — that
// makes no sense"). The number was arithmetically true and rhetorically
// broken: a naked percent-off against "the best scorer on everything"
// reads as a scam precisely when the measured gap is largest. The endorsed
// landing line proves the credible formula — a RATIO, bound to quality
// retention ("1/270th the price of the best scorer, at 99% of its
// quality") — so every surface now speaks that way:
//   · gap under 10× → "NN% less" (percent is believable at that scale);
//   · gap 10× and over → "1/Nth the price" (the engineering framing).
// Callers must place the quality context beside it; the formatter alone is
// never the whole sentence.

export function priceVsBaseline(costPer1K: number, baselineCostPer1K: number): string {
  if (!(costPer1K > 0) || !(baselineCostPer1K > 0) || costPer1K >= baselineCostPer1K) return '—';
  const ratio = baselineCostPer1K / costPer1K;
  if (ratio < 10) return `${Math.round((1 - costPer1K / baselineCostPer1K) * 100)}% less`;
  const rounded = ratio >= 100 ? Math.round(ratio / 10) * 10 : Math.round(ratio);
  return `1/${rounded}th the price`;
}

/** Savings with the comparator to be NAMED beside it by the caller
 * (operator, 2026-08-28: "it should say saving 99.7% versus the best model
 * per task, so that it is clear"). Percent + ratio together: the percent
 * answers "how much", the ratio keeps it credible at scale. One decimal in
 * the 99s; never a rounded 100. */
export function savingsWords(costPer1K: number, baselineCostPer1K: number): string {
  if (!(costPer1K > 0) || !(baselineCostPer1K > 0) || costPer1K >= baselineCostPer1K) return '—';
  const pct = (1 - costPer1K / baselineCostPer1K) * 100;
  const pctWords = pct >= 99.95 ? '99.9%' : pct >= 99 ? `${pct.toFixed(1)}%` : `${Math.round(pct)}%`;
  const ratio = baselineCostPer1K / costPer1K;
  if (ratio < 10) return pctWords;
  const rounded = ratio >= 100 ? Math.round(ratio / 10) * 10 : Math.round(ratio);
  return `${pctWords} (1/${rounded}th the price)`;
}
