// OUTCOME → ORG EVIDENCE (G1): the pure aggregation. Latest-signal-wins per
// (request, signal kind), serving-hash scoping, honest intervals, absent
// blocks over zeros.
import { describe, expect, it } from 'vitest';
import { clusterOutcomeEvidence, type OutcomeRowLike } from './outcome-evidence.js';

const SERVING = 'hash-serving';

let seq = 0;
function row(over: Partial<OutcomeRowLike> = {}): OutcomeRowLike {
  seq += 1;
  return {
    requestId: `chatcmpl-${seq}`,
    clusterId: 'classification',
    strategyHash: SERVING,
    success: null,
    score: null,
    human: null,
    createdAt: new Date(1_700_000_000_000 + seq),
    ...over,
  };
}

const args = { clusterId: 'classification', servingHash: SERVING };

describe('clusterOutcomeEvidence', () => {
  it('an empty window is an absent block, never zeros', () => {
    expect(clusterOutcomeEvidence([], args)).toBeNull();
    expect(clusterOutcomeEvidence([row({ clusterId: 'code-gen', success: true })], args)).toBeNull();
  });

  it('latest signal wins per request and per kind — a correction is one more row, never a double count', () => {
    const rows = [
      row({ requestId: 'r1', success: false }),
      row({ requestId: 'r1', success: true }), // correction: latest wins
      row({ requestId: 'r2', success: true }),
      row({ requestId: 'r2', success: true }), // retried POST: still one verdict
      row({ requestId: 'r1', human: 'accepted' }), // separate kind accumulates on r1
    ];
    const ev = clusterOutcomeEvidence(rows, args)!;
    expect(ev.requests).toBe(2);
    expect(ev.success).toMatchObject({ n: 2, rate: 1 });
    expect(ev.human).toMatchObject({ accepted: 1, edited: 0, rejected: 0, regenerated: 0 });
  });

  it('success carries the exact Jeffreys interval: lo ≤ rate ≤ hi, and 9/10 is not certainty', () => {
    const rows = [
      ...Array.from({ length: 9 }, (_, i) => row({ requestId: `s${i}`, success: true })),
      row({ requestId: 'f1', success: false }),
    ];
    const ev = clusterOutcomeEvidence(rows, args)!;
    expect(ev.success!.rate).toBeCloseTo(0.9, 6);
    expect(ev.success!.ci[0]).toBeLessThan(0.9);
    expect(ev.success!.ci[1]).toBeGreaterThan(0.9);
    expect(ev.success!.ci[1]).toBeLessThan(1);
  });

  it('scores aggregate on their own axis, independent of success', () => {
    const rows = [
      row({ requestId: 'q1', score: 0.8 }),
      row({ requestId: 'q1', score: 0.9 }), // latest wins
      row({ requestId: 'q2', score: 0.7 }),
    ];
    const ev = clusterOutcomeEvidence(rows, args)!;
    expect(ev.success).toBeNull();
    expect(ev.score!.n).toBe(2);
    expect(ev.score!.mean).toBeCloseTo(0.8, 6);
  });

  it("other strategies' signals are counted, never blended into the serving block", () => {
    const rows = [
      row({ requestId: 'mine', success: true }),
      row({ requestId: 'old-1', strategyHash: 'hash-rotated-out', success: false }),
      row({ requestId: 'old-2', strategyHash: 'hash-rotated-out', success: false }),
    ];
    const ev = clusterOutcomeEvidence(rows, args)!;
    expect(ev.requests).toBe(1);
    expect(ev.success).toMatchObject({ n: 1, rate: 1 }); // the rotated-out failures never touch it
    expect(ev.otherStrategyRequests).toBe(2);
  });
});
