// THE WORKBENCH helpers (2026-09-02) — the pane's judgments derive from
// the polling DTO alone; these pin the pure parts: render-kind mapping,
// tab ordering (made artifacts lead), content-hash change detection (a
// size-equal rewrite still counts — the sandbox collection lesson), and
// the CSV parser's quote handling.
import { describe, expect, it } from 'vitest';
import {
  diffBenchFiles,
  elapsedLabel,
  orderBenchFiles,
  parseCsv,
  renderKindFor,
} from '../lib/workbench';

const f = (name: string, sha256 = 'a') => ({ name, mime: 'application/octet-stream', size: 1, sha256 });

describe('renderKindFor', () => {
  it('maps by extension first, mime as fallback, binary last', () => {
    expect(renderKindFor({ name: 'deliverables/analysis.xlsx', mime: 'application/octet-stream' })).toBe('sheet');
    expect(renderKindFor({ name: 'by-day.csv', mime: 'text/csv' })).toBe('csv');
    expect(renderKindFor({ name: 'chart.png', mime: 'image/png' })).toBe('image');
    expect(renderKindFor({ name: 'summary.txt', mime: 'text/plain' })).toBe('text');
    expect(renderKindFor({ name: 'noext', mime: 'image/png' })).toBe('image');
    expect(renderKindFor({ name: 'blob.bin', mime: 'application/octet-stream' })).toBe('binary');
  });
});

describe('orderBenchFiles', () => {
  it('deliverables lead, roots next, trees trail', () => {
    const ordered = orderBenchFiles([
      f('src/deep/thing.py'),
      f('orders.csv'),
      f('deliverables/chart.png'),
      f('deliverables/analysis.xlsx'),
    ]).map((x) => x.name);
    expect(ordered).toEqual([
      'deliverables/analysis.xlsx',
      'deliverables/chart.png',
      'orders.csv',
      'src/deep/thing.py',
    ]);
  });
});

describe('diffBenchFiles — content-hash detection', () => {
  it('a size-equal rewrite counts as changed; new names count as added', () => {
    const prev = new Map([
      ['analysis.xlsx', 'sha-old'],
      ['orders.csv', 'sha-same'],
    ]);
    const { changed, added } = diffBenchFiles(prev, [
      f('analysis.xlsx', 'sha-new'),
      f('orders.csv', 'sha-same'),
      f('chart.png', 'sha-first'),
    ]);
    expect(changed).toEqual(['analysis.xlsx']);
    expect(added).toEqual(['chart.png']);
  });
});

describe('parseCsv', () => {
  it('handles quoted commas, escaped quotes, CRLF, and the row cap', () => {
    const { rows } = parseCsv('a,b\n"x, y","he said ""hi"""\r\nlast,row\n');
    expect(rows).toEqual([
      ['a', 'b'],
      ['x, y', 'he said "hi"'],
      ['last', 'row'],
    ]);
    const capped = parseCsv('h\n' + Array.from({ length: 500 }, (_, i) => `r${i}`).join('\n'), 10);
    expect(capped.rows.length).toBe(10);
    expect(capped.truncated).toBe(true);
  });
});

describe('elapsedLabel', () => {
  it('renders a m:ss clock and never goes negative', () => {
    const t0 = new Date('2026-09-02T00:00:00Z');
    expect(elapsedLabel(t0.toISOString(), t0.getTime() + 74_000)).toBe('1:14');
    expect(elapsedLabel(t0.toISOString(), t0.getTime() - 5_000)).toBe('0:00');
  });
});
