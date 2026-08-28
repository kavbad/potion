// Cluster assignment units — the word-boundary regression (2026-08-28,
// caught LIVE by the operator: the showcase example drew a needless
// cluster-uncertain draft because 'pr' matched inside "pricing").
import { describe, expect, it } from 'vitest';
import { assignCluster } from './cluster.js';

const MARKET_BRIEF_GOAL =
  'Every weekday morning, read the newsletters and alerts in my inbox, pull out anything that moves our market — competitor launches, pricing changes, funding rounds — and draft me a five-minute brief with the two things I should act on first';

describe('assignCluster — word-boundary matching', () => {
  it("'pricing' does not score code-review via the 'pr' keyword (the live regression)", () => {
    // With substring matching, code-review tied summarization and the hint
    // (whatever it was) could not agree with a unique leader. With word
    // boundaries, 'brief' stands alone and a summarization hint agrees.
    const r = assignCluster(MARKET_BRIEF_GOAL, 'summarization');
    expect(r.outcome).toBe('assigned');
    if (r.outcome === 'assigned') expect(r.clusterId).toBe('summarization');
  });

  it('multi-word phrases still match across their own word boundaries', () => {
    const r = assignCluster('Review the open pull request queue and flag risky diffs', 'code-review');
    expect(r.outcome).toBe('assigned');
    if (r.outcome === 'assigned') expect(r.clusterId).toBe('code-review');
  });

  it('a flat-zero lexical field stays uncertain even with a confident hint', () => {
    const r = assignCluster('Do the usual thing for the team every day', 'summarization');
    expect(r.outcome).toBe('uncertain');
  });

  it('disagreement between a scored leader and the hint stays uncertain', () => {
    const r = assignCluster('Summarize the weekly digest into a brief recap', 'code-gen');
    expect(r.outcome).toBe('uncertain');
    if (r.outcome === 'uncertain') expect(r.candidates).toContain('summarization');
  });
});
