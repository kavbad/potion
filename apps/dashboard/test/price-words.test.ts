// The house's price language (2026-08-28): ratios bound to quality, never a
// naked percent-off that rounds toward disbelief.
import { describe, expect, it } from 'vitest';
import { priceVsBaseline } from '@/lib/price-words';

describe('priceVsBaseline', () => {
  it('the operator screenshot case: $0.06 vs $19.96 → a ratio, never 100%', () => {
    expect(priceVsBaseline(0.06, 19.96)).toBe('1/330th the price');
  });
  it('small gaps speak percent — believable at that scale', () => {
    expect(priceVsBaseline(6, 10)).toBe('40% less');
    expect(priceVsBaseline(1.2, 8)).toBe('85% less');
  });
  it('the boundary: 10x and over goes ratio', () => {
    expect(priceVsBaseline(1, 12)).toBe('1/12th the price');
  });
  it('degenerate inputs are a dash, not a lie', () => {
    expect(priceVsBaseline(0, 10)).toBe('—');
    expect(priceVsBaseline(10, 5)).toBe('—');
    expect(priceVsBaseline(10, 10)).toBe('—');
  });
});
