// Smoke test for the frontier chart data-mapping util (Gate 6): pure
// functions, no React/recharts/jsdom needed.
import { describe, expect, it } from 'vitest';
import {
  DOT_RADIUS_MAX,
  DOT_RADIUS_MIN,
  describeStrategy,
  dominatedRects,
  formatDollars,
  latencyRadius,
  qualityWord,
  toChartPoints,
  xDomain,
} from '../lib/frontier-chart';
import type { FrontierPointDto } from '../lib/types';

const point = (
  costPer1K: number,
  quality: number,
  latencyP95: number,
  strategyConfig: FrontierPointDto['strategyConfig'] = { type: 'single', model: 'sonnet-class' },
): FrontierPointDto => ({
  strategyHash: `hash-${costPer1K}`,
  strategyConfig,
  quality,
  costPer1K,
  latencyP95,
  dominated: false,
});

describe('qualityWord — plain-language ticks', () => {
  it('maps the documented tick values', () => {
    expect(qualityWord(0.2)).toBe('poor');
    expect(qualityWord(0.4)).toBe('fair');
    expect(qualityWord(0.6)).toBe('good');
    expect(qualityWord(0.8)).toBe('very good');
    expect(qualityWord(1.0)).toBe('excellent');
  });
  it('snaps in-between values to the nearest word', () => {
    expect(qualityWord(0.9)).toBe('very good'); // equidistant tie goes down
    expect(qualityWord(0.95)).toBe('excellent');
    expect(qualityWord(0.31)).toBe('fair');
  });
});

describe('formatDollars', () => {
  it('formats $ ticks with units', () => {
    expect(formatDollars(0)).toBe('$0');
    expect(formatDollars(0.004)).toBe('$0.004');
    expect(formatDollars(0.15)).toBe('$0.15');
    expect(formatDollars(1.2)).toBe('$1.2');
  });
});

describe('toChartPoints', () => {
  it('maps API points to x=$/1K, y=quality and sorts by cost ascending', () => {
    const pts = toChartPoints([
      point(0.5, 0.9, 900),
      point(0.05, 0.7, 400),
      point(0.2, 0.8, 1800),
    ]);
    expect(pts.map((p) => p.x)).toEqual([0.05, 0.2, 0.5]);
    expect(pts.map((p) => p.y)).toEqual([0.7, 0.8, 0.9]);
    expect(pts[0]!.label).toBe('Single model · sonnet-class');
  });

  it('scales dot radius with p95 latency (bigger dot = slower)', () => {
    expect(latencyRadius(0, 1000)).toBe(DOT_RADIUS_MIN);
    expect(latencyRadius(1000, 1000)).toBe(DOT_RADIUS_MAX);
    const pts = toChartPoints([point(0.05, 0.7, 400), point(0.5, 0.9, 1800)]);
    expect(pts.find((p) => p.latencyP95 === 1800)!.r).toBe(DOT_RADIUS_MAX);
    expect(pts.find((p) => p.latencyP95 === 400)!.r).toBeLessThan(DOT_RADIUS_MAX);
  });
});

describe('dominatedRects — the shaded region', () => {
  it('shades under the step line from cheapest point to the chart edge', () => {
    const pts = toChartPoints([point(0.1, 0.6, 100), point(0.4, 0.9, 100)]);
    const rects = dominatedRects(pts, 0.6);
    expect(rects).toEqual([
      { x1: 0.1, x2: 0.4, y1: 0, y2: 0.6 },
      { x1: 0.4, x2: 0.6, y1: 0, y2: 0.9 },
    ]);
  });

  it('shades nothing left of the cheapest point (nothing dominates there)', () => {
    const pts = toChartPoints([point(0.1, 0.6, 100)]);
    const rects = dominatedRects(pts, 0.5);
    expect(rects[0]!.x1).toBe(0.1);
  });

  it('is empty without points', () => {
    expect(dominatedRects([], 1)).toEqual([]);
  });
});

describe('xDomain', () => {
  it('pads the max cost and always starts at $0', () => {
    const pts = toChartPoints([point(1, 0.9, 100)]);
    const [lo, hi] = xDomain(pts);
    expect(lo).toBe(0);
    expect(hi).toBeCloseTo(1.15);
  });
  it('includes the operating point so "you are here" is never clipped', () => {
    const pts = toChartPoints([point(0.2, 0.9, 100)]);
    const [, hi] = xDomain(pts, [1.0]);
    expect(hi).toBeCloseTo(1.15);
  });
});

describe('describeStrategy', () => {
  it('describes a cascade in plain language', () => {
    expect(
      describeStrategy({
        type: 'cascade',
        stages: [
          { model: 'gpt-mini-class', escalateIf: { confidenceBelow: 0.7 } },
          { model: 'frontier-class' },
        ],
        confidenceMethod: 'self-report-calibrated',
      }),
    ).toBe('Cascade · gpt-mini-class → frontier-class (escalates when confidence < 0.7)');
  });
});
