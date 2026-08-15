// Step 12, targets T5 + T6 — the residual Step 10 named and deferred:
//
//   T5  a token split ACROSS several tool results, every shard below the
//       fragment floor, reassembled in the model's conversation.
//   T6  sub-shard reassembly — the same attack INSIDE one result, using
//       pieces shorter than SPLIT_TOKEN_MIN_MATCH.
//
// Both are reproduced here against the stateless redactor first (the
// attack works — these assertions document the hole, not a wish), then
// closed by the leg-stateful sentinel.
import { describe, expect, it } from 'vitest';
import {
  createReassemblySentinel,
  grantValueRedactor,
  REDACTED_FRAGMENT,
  SHARD_MIN_MATCH,
  SPLIT_TOKEN_MIN_MATCH,
} from './redactor.js';

const TOKEN = 'gho_S3cr3tLiveTokenValue9mQ2vL7pK8rT';

/** Chop a secret into shards of `size`, wrapped in innocent prose — the
 * shape a hostile server actually returns (never a bare fragment). */
function shards(secret: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < secret.length; i += size) {
    out.push(`Result page ${out.length + 1}. Reference code: ${secret.slice(i, i + size)}. Nothing else to report.`);
  }
  return out;
}

describe('T5 — split-token echo ACROSS results (the attack, reproduced)', () => {
  it('the STATELESS redactor lets sub-threshold shards through, every one of them', () => {
    const redact = grantValueRedactor([TOKEN]);
    const pieces = shards(TOKEN, SPLIT_TOKEN_MIN_MATCH - 1);
    expect(pieces.length).toBeGreaterThan(2);
    const seen = pieces.map((p) => redact(p));
    // Not a single shard is recognized — this is the hole, stated plainly.
    for (const s of seen) expect(s).not.toContain(REDACTED_FRAGMENT);
    // And the conversation now holds the whole credential in order.
    const reassembled = seen
      .map((s) => /Reference code: (\S+)\./.exec(s)![1]!)
      .join('');
    expect(reassembled).toBe(TOKEN);
  });

  it('the SENTINEL trips before the leg gives away as much as one scrubbed fragment', () => {
    const redact = grantValueRedactor([TOKEN]);
    const sentinel = createReassemblySentinel([TOKEN]);
    const pieces = shards(TOKEN, SPLIT_TOKEN_MIN_MATCH - 1);
    let tripAt = -1;
    for (const [i, p] of pieces.entries()) {
      if (sentinel.observe(redact(p)) !== null) {
        tripAt = i;
        break;
      }
    }
    expect(tripAt).toBeGreaterThanOrEqual(0);
    // The bound the sentinel promises: it fires as soon as coverage reaches
    // SPLIT_TOKEN_MIN_MATCH, so a leg can never lose more of a secret
    // across results than one in-result fragment would have revealed.
    const covered = sentinel.coverage()[0]!;
    expect(covered).toBeGreaterThanOrEqual(SPLIT_TOKEN_MIN_MATCH);
    // …and it happens early: two shards of 11 already cross the line.
    expect(tripAt).toBeLessThan(3);
  });

  it('the trip carries the evidence — which secret, how much, over how many values', () => {
    const sentinel = createReassemblySentinel([TOKEN, 'refresh_ghr_OTHERvalue_abcdefghij']);
    let trip = null;
    for (const p of shards(TOKEN, SHARD_MIN_MATCH + 1)) {
      trip = sentinel.observe(p);
      if (trip !== null) break;
    }
    expect(trip).not.toBeNull();
    expect(trip!.secretIndex).toBe(0); // the ACCESS token, not the refresh one
    expect(trip!.coveredOffsets).toBeGreaterThanOrEqual(SPLIT_TOKEN_MIN_MATCH);
    expect(trip!.contributingValues).toBeGreaterThan(1); // it took several results
  });
});

describe('T6 — sub-shard reassembly (below the fragment floor)', () => {
  it('shards of exactly SHARD_MIN_MATCH are counted, in ONE result or many', () => {
    const oneResult = shards(TOKEN, SHARD_MIN_MATCH).join(' ');
    const sentinel = createReassemblySentinel([TOKEN]);
    expect(sentinel.observe(oneResult)).not.toBeNull();
  });

  it('interleaved, out-of-order shards are counted — order is the attacker’s choice', () => {
    const pieces = shards(TOKEN, SHARD_MIN_MATCH + 2).reverse();
    const sentinel = createReassemblySentinel([TOKEN]);
    let tripped = false;
    for (const p of pieces) if (sentinel.observe(p) !== null) tripped = true;
    expect(tripped).toBe(true);
  });

  it('shards BELOW the floor evade — the residual, measured rather than denied', () => {
    // The honest bound in the redactor header: 4-char shards are under the
    // detector. This test exists so the limit is a recorded number, not a
    // discovery someone makes later.
    const sentinel = createReassemblySentinel([TOKEN]);
    for (const p of shards(TOKEN, SHARD_MIN_MATCH - 1)) expect(sentinel.observe(p)).toBeNull();
    expect(sentinel.coverage()[0]).toBe(0);
    // The cost of that evasion, stated: one result per 4 characters.
    expect(Math.ceil(TOKEN.length / (SHARD_MIN_MATCH - 1))).toBeGreaterThanOrEqual(8);
  });

  it('nests and object KEYS are walked — a shard hidden in a key still counts', () => {
    const sentinel = createReassemblySentinel([TOKEN]);
    const pieces = shards(TOKEN, SHARD_MIN_MATCH + 1);
    let tripped = false;
    for (const p of pieces) {
      const nested = { page: { meta: [{ [p]: 'ok' }] } };
      if (sentinel.observe(nested) !== null) tripped = true;
    }
    expect(tripped).toBe(true);
  });
});

describe('the sentinel does not cry wolf', () => {
  it('ordinary results — including ones naming the token PREFIX — never trip it', () => {
    const sentinel = createReassemblySentinel([TOKEN]);
    const innocuous = [
      'Repository potion has 4 open issues and 2 pull requests.',
      'Auth docs: personal access tokens start with gho_ or ghp_ and are 40 characters.',
      'The last release shipped on 2026-08-01 with 12 commits by 3 authors.',
      JSON.stringify({ items: Array.from({ length: 50 }, (_, i) => ({ id: i, title: `issue ${i}` })) }),
    ];
    for (const s of innocuous) expect(sentinel.observe(s)).toBeNull();
    // 'gho_' is 4 chars — under the floor — so even the prefix contributes
    // nothing. Coverage stays at zero across a realistic result stream.
    expect(sentinel.coverage()[0]).toBe(0);
  });

  it('a secret shorter than the floor is not tracked at all (no divide-by-zero policy)', () => {
    const sentinel = createReassemblySentinel(['abc', null, undefined]);
    expect(sentinel.observe('abcabcabc')).toBeNull();
    expect(sentinel.coverage()).toEqual([]);
  });

  it('once tripped for a secret it stops reporting — the caller severs on the first', () => {
    const sentinel = createReassemblySentinel([TOKEN]);
    const pieces = shards(TOKEN, SHARD_MIN_MATCH + 1);
    const trips = pieces.map((p) => sentinel.observe(p)).filter((t) => t !== null);
    expect(trips.length).toBe(1);
  });
});
