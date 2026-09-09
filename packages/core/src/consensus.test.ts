import { describe, expect, it } from 'vitest';
import { consensusKey, normalizeAnswer, numericAnswer } from './consensus.js';

describe('consensusKey — what makes two answers the same answer', () => {
  it('reads through the reasoning to the declared answer', () => {
    expect(consensusKey('Step 1: 9 sprints.\nStep 2: 9 x 60 = 540.\n\nFinal answer: 540'))
      .toBe(consensusKey('He runs 9 sprints.\nFinal answer: 540'));
  });
  it('separates answers that land on different values', () => {
    expect(consensusKey('...\nFinal answer: 540')).not.toBe(consensusKey('...\nFinal answer: 180'));
  });
  it('treats the same number written differently as one answer', () => {
    expect(consensusKey('Final answer: 1,234')).toBe(consensusKey('**Final answer: 1234**'));
    expect(consensusKey('Final answer: $18.00')).toBe(consensusKey('Final answer: 18'));
  });
  it('takes the LAST declaration when a model restates it', () => {
    expect(consensusKey('Final answer: 7\nOn reflection.\nFinal answer: 9')).toBe(consensusKey('Final answer: 9'));
  });
  it('compares non-numeric declarations as text', () => {
    expect(consensusKey('Final answer: Paris.')).toBe(consensusKey('final answer:  paris'));
    expect(consensusKey('Final answer: Paris')).not.toBe(consensusKey('Final answer: Lyon'));
  });
  it('falls back to the whole text when nothing is declared', () => {
    expect(consensusKey('Paris.')).toBe(consensusKey('  paris '));
    expect(consensusKey('const add = (a,b) => a+b')).not.toBe(consensusKey('const add = (a,b) => a-b'));
  });
  it('an empty declaration is not an answer', () => {
    expect(consensusKey('some working\nFinal answer:')).not.toBe(consensusKey('other working\nFinal answer:'));
  });
  it('a number must be the whole value', () => {
    expect(numericAnswer('12 apples')).toBeNull();
    expect(numericAnswer('$1,234.50')).toBe(1234.5);
    expect(normalizeAnswer(' A  b. ')).toBe('a b');
  });
});
