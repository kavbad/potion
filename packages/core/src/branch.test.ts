// C3: conditional execution, measured.
import { describe, expect, it } from 'vitest';
import { branchStats, pathLengthOf, BRANCH_MIN_SERVINGS } from './branch.js';

const runs = (worstCount: number, cheapCount: number, worst = 2, cheap = 1) => [
  ...Array.from({ length: worstCount }, () => worst),
  ...Array.from({ length: cheapCount }, () => cheap),
];

describe('reading a branch rate off served traffic', () => {
  it('a gate that decides is conditional, and says how often', () => {
    const s = branchStats(runs(30, 70), 2);
    expect(s.verdict).toBe('conditional');
    expect(s.worstCaseRate).toBeCloseTo(0.3, 5);
    expect(s.reason).toContain('30.0%');
  });

  it('a gate that ALWAYS escalates is its escalation target plus a wasted call', () => {
    const s = branchStats(runs(100, 0), 2);
    expect(s.verdict).toBe('always-worst-case');
    expect(s.reason).toContain('the escalation target alone would be cheaper');
  });

  it('a gate that NEVER escalates has an untested safety branch', () => {
    const s = branchStats(runs(0, 100), 2);
    expect(s.verdict).toBe('never-escalates');
    expect(s.reason).toContain('untested in production');
  });

  it('too little traffic is its own verdict, and carries no rate at all', () => {
    const s = branchStats(runs(1, 1), 2);
    expect(s.verdict).toBe('insufficient');
    expect(s.worstCaseRate).toBeNull();
    expect(s.n).toBeLessThan(BRANCH_MIN_SERVINGS);
  });

  it('a path LONGER than the static bound still counts as worst case', () => {
    // It should be impossible — programCallCount is the maximum — so if one
    // ever appears, it is a bound violation. Counting it as worst case makes
    // the rate rise toward 1 and the mechanism read as degenerate, which is
    // the direction that gets someone to look. `=== worstCase` would have
    // silently DROPPED it and reported the program as healthier than it is.
    const s = branchStats([...Array.from({ length: 50 }, () => 3), ...Array.from({ length: 50 }, () => 1)], 2);
    expect(s.worstCaseRate).toBeCloseTo(0.5, 5);
  });

  it('worst case is >=, not ==, so a three-call program counts its full path', () => {
    // consensus-or-escalate: 2 calls when the peers agree, 3 when they do not.
    const s = branchStats(runs(50, 50, 3, 2), 3);
    expect(s.worstCaseRate).toBeCloseTo(0.5, 5);
  });
});

describe('reading the path back out of a recorded trace', () => {
  it('finds the stage count', () => {
    expect(pathLengthOf('cluster=x;strategy=abc;program=verified-cascade;path=cheap>strong')).toBe(2);
    expect(pathLengthOf('cluster=x;path=cheap')).toBe(1);
  });

  it('returns null rather than a zero that would read as "no calls"', () => {
    expect(pathLengthOf(null)).toBeNull();
    expect(pathLengthOf('')).toBeNull();
    expect(pathLengthOf('cluster=x;strategy=abc')).toBeNull();
    expect(pathLengthOf('cluster=x;path=')).toBeNull();
  });

  it('is not fooled by a field that merely ENDS in path', () => {
    expect(pathLengthOf('cluster=x;subpath=a>b>c;path=one')).toBe(1);
  });
});
