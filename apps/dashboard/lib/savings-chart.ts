// Savings chart data-mapping (M3 #21 shadow mode, SPEC §12.4). PURE
// functions — no React — so the bar mapping is unit-testable (vitest) and
// the component stays a thin SSR SVG renderer (same pattern as
// lib/usage-chart.ts / lib/frontier-chart.ts).
//
// Chart contract: one vertical bar per entry — the ACTUAL window spend
// first (accent), then each shadowed candidate's PROJECTED spend, sorted
// biggest saving first (the report's own ordering). Low-saturation warm
// palette shared with the usage chart.
import type { SavingsReportDto } from './types';
import { CLUSTER_COLORS } from './usage-chart';

/** Actual spend takes the accent; candidates cycle the muted palette
 * starting past the accent slot (same palette as lib/usage-chart.ts). */
export const ACTUAL_COLOR = CLUSTER_COLORS[0]; // accent violet
export const ALTERNATIVE_COLORS = CLUSTER_COLORS.slice(1);

export interface SavingsBar {
  /** 'actual' or the candidate strategyHash. */
  key: string;
  /** Short axis label: 'actual' or the candidate's short hash. */
  axisLabel: string;
  /** Full label for the hover title. */
  label: string;
  spendUsd: number;
  kind: 'actual' | 'alternative';
  color: string;
  /** deltaUsd for alternatives (hover title); null for actual. */
  deltaUsd: number | null;
}

export interface SavingsBars {
  bars: SavingsBar[];
  /** Max bar value (y-axis ceiling; 0 when the window is empty). */
  maxSpend: number;
}

/** Map a SavingsReport into renderable bars (actual first, then the
 * report-ordered alternatives). Empty report → empty bars. */
export function buildSavingsBars(report: SavingsReportDto): SavingsBars {
  const bars: SavingsBar[] = [
    {
      key: 'actual',
      axisLabel: 'actual',
      label: 'What you actually spent',
      spendUsd: report.actualSpendUsd,
      kind: 'actual',
      color: ACTUAL_COLOR,
      deltaUsd: null,
    },
    ...report.alternatives.map((a, i): SavingsBar => ({
      key: a.strategyHash,
      axisLabel: a.strategyHash.slice(0, 8),
      label: a.label,
      spendUsd: a.projectedSpendUsd,
      kind: 'alternative',
      color: ALTERNATIVE_COLORS[i % ALTERNATIVE_COLORS.length]!,
      deltaUsd: a.deltaUsd,
    })),
  ];
  return { bars, maxSpend: bars.reduce((m, b) => Math.max(m, b.spendUsd), 0) };
}

/** Confidence badge copy: low <30, medium <200, high ≥200 samples — the
 * report already tiered it; this is the plain-language hint. */
export function confidenceHint(c: 'low' | 'medium' | 'high'): string {
  switch (c) {
    case 'low':
      return 'few samples — directional only';
    case 'medium':
      return 'reasonable sample size';
    case 'high':
      return 'statistically solid';
  }
}
