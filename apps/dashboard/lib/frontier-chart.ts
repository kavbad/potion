// Frontier chart data-mapping (SPEC §9 "money shot"). PURE functions — no
// React, no recharts — so the mapping is unit-testable (vitest) and the chart
// component stays a thin renderer.
//
// Chart contract:
//   x = cost per 1K requests, in DOLLARS ($ formatted ticks)
//   y = quality 0–1 with plain-language ticks (poor/fair/good/very good/excellent)
//   dot radius scales with p95 latency (bigger dot = slower)
//   dominated region = the shaded area under/left of the frontier step line
//   frontier points are connected by a step line
import type { FrontierPointDto, StrategyConfig } from './types';

/** One renderable point on the chart. */
export interface ChartPoint {
  /** $ per 1K requests (x). */
  x: number;
  /** quality 0–1 (y). */
  y: number;
  /** dot radius in px — scales with p95 latency. */
  r: number;
  strategyHash: string;
  /** Plain-language strategy description for the hover card. */
  label: string;
  quality: number;
  costPer1K: number;
  latencyP95: number;
  dominated: boolean;
}

/** One shaded rectangle of the dominated region (recharts ReferenceArea). */
export interface DominatedRect {
  x1: number;
  x2: number;
  y1: number;
  y2: number;
}

// ---- plain-language quality scale (axis ticks + hover cards) ----

export const QUALITY_TICKS: Array<{ value: number; word: string }> = [
  { value: 0.2, word: 'poor' },
  { value: 0.4, word: 'fair' },
  { value: 0.6, word: 'good' },
  { value: 0.8, word: 'very good' },
  { value: 1.0, word: 'excellent' },
];

/** Word for a quality score — nearest tick, ties go down. */
export function qualityWord(q: number): string {
  let best = QUALITY_TICKS[0]!;
  for (const t of QUALITY_TICKS) {
    if (Math.abs(q - t.value) < Math.abs(q - best.value)) best = t;
  }
  return best.word;
}

/** Dollar tick label: $0.004 stays cents-precise, $1.20 trims to $1.2. */
export function formatDollars(per1K: number): string {
  if (per1K === 0) return '$0';
  if (per1K < 0.01) return `$${per1K.toFixed(3)}`;
  if (per1K < 1) return `$${per1K.toFixed(2)}`;
  return `$${Number(per1K.toFixed(2))}`;
}

// ---- strategy descriptions (hover card) ----

/** Plain-language one-liner for a strategy config — no jargon, model names
 * kept as-is because buyers recognize tiers ("sonnet-class"). */
export function describeStrategy(config: StrategyConfig): string {
  switch (config.type) {
    case 'single':
      return `Single model · ${config.model}`;
    case 'cascade': {
      const chain = config.stages.map((s) => s.model).join(' → ');
      const threshold = config.stages.find((s) => s.escalateIf?.confidenceBelow !== undefined)
        ?.escalateIf?.confidenceBelow;
      return threshold !== undefined
        ? `Cascade · ${chain} (escalates when confidence < ${threshold})`
        : `Cascade · ${chain}`;
    }
    case 'best-of-n':
      return `Best-of-${config.n} · ${config.model}, judged by ${config.judge.model}`;
    case 'draft-verify':
      return `Draft & verify · ${config.draftModel} drafted, ${config.verifierModel} checked`;
    case 'ensemble':
      return `Ensemble · ${config.models.join(' + ')} (${config.fusion.method})`;
    case 'decompose':
      return `Decompose · ${config.decomposerModel} splits, specialists answer`;
  }
}

// ---- point mapping ----

export const DOT_RADIUS_MIN = 5;
export const DOT_RADIUS_MAX = 11;

/** Dot radius scales with p95 latency: slowest point gets DOT_RADIUS_MAX,
 * an instant point would get DOT_RADIUS_MIN. Linear in latency. */
export function latencyRadius(latencyP95: number, maxLatencyP95: number): number {
  if (maxLatencyP95 <= 0) return DOT_RADIUS_MIN;
  const t = Math.max(0, Math.min(1, latencyP95 / maxLatencyP95));
  return DOT_RADIUS_MIN + t * (DOT_RADIUS_MAX - DOT_RADIUS_MIN);
}

/** Map API frontier points to chart points, sorted by cost ascending (the
 * frontier line reads cheap→expensive, lower→higher quality). */
export function toChartPoints(points: FrontierPointDto[]): ChartPoint[] {
  const maxLatency = Math.max(0, ...points.map((p) => p.latencyP95));
  return [...points]
    .sort((a, b) => a.costPer1K - b.costPer1K || b.quality - a.quality)
    .map((p) => ({
      x: p.costPer1K,
      y: p.quality,
      r: latencyRadius(p.latencyP95, maxLatency),
      strategyHash: p.strategyHash,
      label: describeStrategy(p.strategyConfig),
      quality: p.quality,
      costPer1K: p.costPer1K,
      latencyP95: p.latencyP95,
      dominated: p.dominated,
    }));
}

// ---- axes ----

/** Nice x-domain: [0, max cost padded 15%], never collapsing to a point. */
export function xDomain(points: ChartPoint[], extraX: number[] = []): [number, number] {
  const max = Math.max(0, ...points.map((p) => p.x), ...extraX);
  return [0, max > 0 ? max * 1.15 : 0.01];
}

export const Y_DOMAIN: [number, number] = [0, 1.02];

// ---- dominated region ----

/**
 * The shaded "not worth it" region: everything below the frontier step line,
 * from the cheapest frontier point rightward to the chart edge. With the step
 * line (quality of the cheapest point that costs ≤ x), a buyer sees at a
 * glance that any offer inside the shaded area is beaten by a point on the
 * line. One rect per step segment keeps this renderable as ReferenceAreas.
 */
export function dominatedRects(points: ChartPoint[], xMax: number): DominatedRect[] {
  if (points.length === 0 || xMax <= 0) return [];
  const rects: DominatedRect[] = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    const next = points[i + 1];
    const x2 = next ? next.x : xMax;
    if (x2 <= p.x) continue;
    rects.push({ x1: p.x, x2, y1: 0, y2: p.y });
  }
  return rects;
}
