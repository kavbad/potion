import { describe, expect, it } from 'vitest';
import {
  accuracy,
  buildConfusionMatrix,
  formatConfusionMatrix,
  formatMetrics,
  precisionRecall,
} from './confusion.js';

/**
 * Tiny hand-computed example.
 *   actual    = [a, a, a, b, b, general]
 *   predicted = [a, a, b, b, general, general]
 * Rows = actual, columns = predicted, label order [a, b, general]:
 *        a        b        general
 *   a    2        1        0        → recall(a) = 2/3
 *   b    0        1        1        → recall(b) = 1/2
 *   g    0        0        1        → recall(general) = 1
 * Column sums: a=2, b=2, general=2 → precision = 1, 1/2, 1/2.
 * Accuracy = (2+1+1)/6 = 4/6.
 */
const ACTUAL = ['a', 'a', 'a', 'b', 'b', 'general'];
const PREDICTED = ['a', 'a', 'b', 'b', 'general', 'general'];
const LABELS = ['a', 'b', 'general'];

describe('buildConfusionMatrix', () => {
  it('counts actual×predicted pairs in the hand-computed example', () => {
    const m = buildConfusionMatrix(ACTUAL, PREDICTED, LABELS);
    expect(m.labels).toEqual(LABELS);
    expect(m.counts).toEqual([
      [2, 1, 0],
      [0, 1, 1],
      [0, 0, 1],
    ]);
  });

  it('unions labels from data in first-seen order when none are given', () => {
    const m = buildConfusionMatrix(['x', 'y', 'x'], ['y', 'y', 'x']);
    expect(m.labels).toEqual(['x', 'y']);
    expect(m.counts).toEqual([
      [1, 1],
      [0, 1],
    ]);
  });

  it('keeps explicitly listed labels even with zero counts, and appends unseen ones', () => {
    const m = buildConfusionMatrix(['a'], ['b'], ['a', 'b', 'c']);
    expect(m.labels).toEqual(['a', 'b', 'c']);
    expect(m.counts).toEqual([
      [0, 1, 0],
      [0, 0, 0],
      [0, 0, 0],
    ]);
  });

  it('rejects length mismatches', () => {
    expect(() => buildConfusionMatrix(['a'], [])).toThrowError(/length mismatch/);
  });
});

describe('precisionRecall / accuracy', () => {
  it('matches the hand-computed precision, recall, and accuracy', () => {
    const m = buildConfusionMatrix(ACTUAL, PREDICTED, LABELS);
    const metrics = precisionRecall(m);
    expect(metrics).toEqual([
      { label: 'a', support: 3, predictedCount: 2, truePositives: 2, precision: 1, recall: 2 / 3 },
      { label: 'b', support: 2, predictedCount: 2, truePositives: 1, precision: 0.5, recall: 0.5 },
      { label: 'general', support: 1, predictedCount: 2, truePositives: 1, precision: 0.5, recall: 1 },
    ]);
    expect(accuracy(m)).toBeCloseTo(4 / 6, 12);
  });

  it('returns 0 (not NaN) for labels never predicted or without support', () => {
    const m = buildConfusionMatrix(['a'], ['a'], ['a', 'ghost']);
    const [, ghost] = precisionRecall(m);
    expect(ghost!.precision).toBe(0);
    expect(ghost!.recall).toBe(0);
  });
});

describe('formatConfusionMatrix', () => {
  it('renders an aligned ASCII table for the hand-computed example', () => {
    const m = buildConfusionMatrix(ACTUAL, PREDICTED, LABELS);
    const table = formatConfusionMatrix(m);
    const lines = table.split('\n');
    // header + divider + one row per label
    expect(lines).toHaveLength(2 + LABELS.length);
    // all lines aligned to the same width
    const width = lines[0]!.length;
    for (const line of lines) expect(line).toHaveLength(width);
    // header names every predicted label in order
    expect(lines[0]).toContain('actual \\ predicted');
    expect(lines[0]!.indexOf('a')).toBeLessThan(lines[0]!.lastIndexOf('b'));
    expect(lines[0]!.lastIndexOf('b')).toBeLessThan(lines[0]!.indexOf('general'));
    // each row starts with its actual label followed by its count row
    const rowCells = (line: string): number[] =>
      line.split('|')[1]!.trim().split(/\s+/).map(Number);
    expect(lines[2]!.startsWith('a')).toBe(true);
    expect(rowCells(lines[2]!)).toEqual([2, 1, 0]);
    expect(lines[3]!.startsWith('b')).toBe(true);
    expect(rowCells(lines[3]!)).toEqual([0, 1, 1]);
    expect(lines[4]!.startsWith('general')).toBe(true);
    expect(rowCells(lines[4]!)).toEqual([0, 0, 1]);
  });

  it('stays aligned with long cluster labels and multi-digit counts', () => {
    const actual = Array.from({ length: 20 }, () => 'multi-step-reasoning');
    const predicted = [
      ...Array.from({ length: 18 }, () => 'multi-step-reasoning'),
      'general',
      'general',
    ];
    const m = buildConfusionMatrix(actual, predicted, ['multi-step-reasoning', 'general']);
    const lines = formatConfusionMatrix(m).split('\n');
    const width = lines[0]!.length;
    for (const line of lines) expect(line).toHaveLength(width);
    expect(lines[2]!.split('|')[1]!.trim().split(/\s+/).map(Number)).toEqual([18, 2]);
  });
});

describe('formatMetrics', () => {
  it('renders one aligned row per label with support/precision/recall', () => {
    const m = buildConfusionMatrix(ACTUAL, PREDICTED, LABELS);
    const table = formatMetrics(precisionRecall(m));
    const lines = table.split('\n');
    expect(lines).toHaveLength(2 + LABELS.length);
    expect(lines[0]).toContain('precision');
    expect(lines[2]).toContain('1.0000');
    expect(lines[2]).toContain('0.6667');
  });
});
