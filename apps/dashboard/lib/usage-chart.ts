// Usage chart data-mapping (M2 Wave 2, ROADMAP #17/#18). PURE functions —
// no React — so the stacked-bar mapping is unit-testable and the component
// stays a thin SVG renderer (same pattern as lib/frontier-chart.ts).
import type { UsageDayRowDto } from './types';

/** Muted palette in the dashboard's design language (accent first). */
export const CLUSTER_COLORS = [
  '#6d5ef0', // accent violet
  '#0e9f6e', // green
  '#e0a030', // amber
  '#3d8bfd', // blue
  '#d5629f', // pink
  '#6b7280', // gray
  '#0ea5b7', // teal
  '#b95c38', // rust
] as const;

/** Deterministic color for a cluster: sorted-cluster index mod palette
 * (an id missing from the order list takes the next slot past it). */
export function clusterColor(clusterId: string, orderedClusters: string[]): string {
  const found = orderedClusters.indexOf(clusterId);
  const idx = found === -1 ? orderedClusters.length : found;
  return CLUSTER_COLORS[idx % CLUSTER_COLORS.length]!;
}

export interface UsageStackSegment {
  clusterId: string;
  requests: number;
  /** Stack offsets in REQUEST units (y0 bottom, y1 top). */
  y0: number;
  y1: number;
  color: string;
}

export interface UsageStackBar {
  day: string;
  total: number;
  segments: UsageStackSegment[];
}

export interface UsageStacks {
  bars: UsageStackBar[];
  /** Max single-day total (y-axis ceiling; 0 when no data). */
  maxTotal: number;
  /** Sorted cluster ids seen across the window (legend order = color order). */
  clusters: string[];
  grandTotal: number;
}

/** Map group_by=day rows into stacked bars (days ascending, clusters sorted). */
export function buildUsageStacks(rows: UsageDayRowDto[]): UsageStacks {
  const clusters = [...new Set(rows.flatMap((r) => r.clusters.map((c) => c.clusterId)))].sort();
  const bars = [...rows]
    .sort((a, b) => a.day.localeCompare(b.day))
    .map((r) => {
      let y = 0;
      const segments = [...r.clusters]
        .sort((a, b) => a.clusterId.localeCompare(b.clusterId))
        .map((c) => {
          const seg: UsageStackSegment = {
            clusterId: c.clusterId,
            requests: c.requests,
            y0: y,
            y1: y + c.requests,
            color: clusterColor(c.clusterId, clusters),
          };
          y += c.requests;
          return seg;
        });
      return { day: r.day, total: r.requests, segments };
    });
  return {
    bars,
    maxTotal: bars.reduce((m, b) => Math.max(m, b.total), 0),
    clusters,
    grandTotal: bars.reduce((s, b) => s + b.total, 0),
  };
}

/** '2026-08-02' → 'Aug 2' (UTC — the day strings are UTC by contract). */
export function formatDay(day: string): string {
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const [, m, d] = day.split('-').map((x) => Number(x));
  return `${MONTHS[(m ?? 1) - 1]} ${d}`;
}

/** $ formatter for usage magnitudes: sub-cent precision only when needed. */
export function formatUsd(n: number): string {
  if (n === 0) return '$0.00';
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

/** 12345 → '12,345'. */
export function formatInt(n: number): string {
  return n.toLocaleString('en-US');
}
