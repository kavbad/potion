// P0-3 (external review, 2026-09-05): the cache key and the embedded text
// disagreed.
//
// `assignmentCacheKey` hashed `contents.join('\n').slice(0, 512)` while every
// one of its three call sites embedded the join UNTRUNCATED. Two requests
// sharing a 512-character prefix therefore got the first one's classification.
//
// It bites agent traffic hardest, which is the target workload class: in a
// long session the first user turn carries the task and usually exceeds 512
// characters, so every subsequent turn silently reuses turn one's cluster.
import { describe, expect, it } from 'vitest';
import { assignmentCacheKey } from '../src/context.js';
import { AssignCache } from '../src/assign-cache.js';

const PREFIX = 'A'.repeat(512);

describe('the key covers exactly what gets embedded', () => {
  it('two prompts sharing a 512-char prefix do NOT collide', () => {
    expect(assignmentCacheKey([`${PREFIX} extract the invoice total`]))
      .not.toBe(assignmentCacheKey([`${PREFIX} write a haiku about rain`]));
  });

  it('the agent session: turn two does not inherit turn one classification', () => {
    // A real shape — a long task brief, then a short follow-up. Both turns are
    // keyed on the whole conversation, and the briefs are identical, so before
    // the fix these two collided on the brief alone.
    const brief = `You are an invoice processing agent. ${'Follow the schema exactly. '.repeat(20)}`;
    const turn1 = [brief, 'Here is the first invoice.'];
    const turn2 = [brief, 'Now summarise the quarter in prose.'];
    expect(brief.length).toBeGreaterThan(512);
    expect(assignmentCacheKey(turn1)).not.toBe(assignmentCacheKey(turn2));

    // and end to end through the cache: turn two must MISS
    const cache = new AssignCache<string>();
    cache.set(assignmentCacheKey(turn1), 'extraction');
    expect(cache.get(assignmentCacheKey(turn2))).toBeUndefined();
  });

  it('identical content still shares a key — this is a cache, not a nonce', () => {
    const c = ['the same thing', 'twice'];
    expect(assignmentCacheKey(c)).toBe(assignmentCacheKey([...c]));
  });

  it('the join is part of the identity: ["ab"] and ["a","b"] are different requests', () => {
    expect(assignmentCacheKey(['ab'])).not.toBe(assignmentCacheKey(['a', 'b']));
  });

  it('a long input still yields a fixed-size key — there was never a size reason to truncate', () => {
    const huge = assignmentCacheKey(['x'.repeat(2_000_000)]);
    expect(huge).toHaveLength(assignmentCacheKey(['x']).length);
  });
});
