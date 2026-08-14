// The grant-value redactor (Step 10 §1) — the KNOWN-VALUE scrub that runs
// BEFORE the pattern gate ever sees a tool result. Patterns cannot own a
// server echoing back the exact bearer it was sent (token formats are
// arbitrary); this can, because we HOLD the value. Order is pinned by test:
// redactor first (known values), then the Step 3 secret gate (shapes,
// still fail-closed on credential-shaped content that is not the user's).
//
// Forms scrubbed per held secret — the STANDARD whole-token encodings a
// server echo would reach for:
//   · exact          — the raw token
//   · base64 / base64url (padded + unpadded) — the trivial disguise
//   · URL-encoded    — the query-string disguise
//   · hex (lower + upper) — the other one-line transform (Step 10 review:
//     a hosted server that hex-encodes the bearer it received evaded the
//     original set, which had base64url but not hex — same tier, added)
//   · contiguous fragments ≥ SPLIT_TOKEN_MIN_MATCH chars — the cheap
//     structural half of the split-token defense (review addition 4): a
//     token chopped in two inside ONE result still dies here, because any
//     visible piece ≥ 12 chars is recognized as a piece.
// What remains the NAMED Step 12 adversarial target (not owned here): a
// token split into sub-12-char shards ACROSS separate results, and
// ARBITRARY/LAYERED transforms (gzip+base64, rot-N, custom encodings) —
// the redactor covers the standard whole-token encodings a real echo uses;
// exhaustive transform coverage is the adversarial pass's job.

export const REDACTED_GRANT = '[REDACTED:grant]';
export const REDACTED_FRAGMENT = '[REDACTED:grant-fragment]';

/** Fragments shorter than this are not recognizable as pieces of a token.
 * 12 chars of a ≥ 20-char credential is long enough to be unambiguous and
 * short enough that a split needs 4+ shards to evade — Step 12's corpus
 * attacks exactly that residual. */
export const SPLIT_TOKEN_MIN_MATCH = 12;

function encodedForms(secret: string): string[] {
  const buf = Buffer.from(secret, 'utf8');
  const b64 = buf.toString('base64');
  const hex = buf.toString('hex');
  const forms = new Set<string>([
    secret,
    b64,
    b64.replace(/=+$/, ''),
    buf.toString('base64url'),
    encodeURIComponent(secret),
    hex,
    hex.toUpperCase(),
  ]);
  return [...forms].filter((f) => f.length >= 8);
}

/** All SPLIT_TOKEN_MIN_MATCH-grams of the secret → their start offsets. */
function gramIndex(secret: string): Map<string, number[]> {
  const grams = new Map<string, number[]>();
  for (let i = 0; i + SPLIT_TOKEN_MIN_MATCH <= secret.length; i++) {
    const gram = secret.slice(i, i + SPLIT_TOKEN_MIN_MATCH);
    const at = grams.get(gram);
    if (at === undefined) grams.set(gram, [i]);
    else at.push(i);
  }
  return grams;
}

function scrubFragments(text: string, secret: string, grams: Map<string, number[]>): string {
  if (secret.length < SPLIT_TOKEN_MIN_MATCH) return text;
  let out = '';
  let i = 0;
  while (i + SPLIT_TOKEN_MIN_MATCH <= text.length) {
    const anchors = grams.get(text.slice(i, i + SPLIT_TOKEN_MIN_MATCH));
    if (anchors === undefined) {
      out += text[i];
      i += 1;
      continue;
    }
    // Extend the anchored match as far as the secret allows; longest wins.
    let best = SPLIT_TOKEN_MIN_MATCH;
    for (const j of anchors) {
      let len = SPLIT_TOKEN_MIN_MATCH;
      while (i + len < text.length && j + len < secret.length && text[i + len] === secret[j + len]) {
        len += 1;
      }
      if (len > best) best = len;
    }
    out += REDACTED_FRAGMENT;
    i += best;
  }
  return out + text.slice(i);
}

export type Redactor = <T>(value: T) => T;

/** Build a redactor over the leg's HELD secret values (access + refresh
 * tokens of every opened grant). Walks any JSON-shaped value; strings are
 * scrubbed, everything else passes through untouched. */
export function grantValueRedactor(secrets: Array<string | null | undefined>): Redactor {
  const held = secrets.filter((s): s is string => typeof s === 'string' && s.length >= 8);
  const forms = held.flatMap(encodedForms).sort((a, b) => b.length - a.length);
  const fragmentSources = held.map((s) => ({ secret: s, grams: gramIndex(s) }));

  const scrubString = (s: string): string => {
    let out = s;
    for (const form of forms) {
      if (out.includes(form)) out = out.split(form).join(REDACTED_GRANT);
    }
    for (const { secret, grams } of fragmentSources) {
      out = scrubFragments(out, secret, grams);
    }
    return out;
  };

  const walk = (value: unknown): unknown => {
    if (typeof value === 'string') return scrubString(value);
    if (Array.isArray(value)) return value.map(walk);
    if (value !== null && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) out[scrubString(k)] = walk(v);
      return out;
    }
    return value;
  };

  return ((value: unknown) => (held.length === 0 ? value : walk(value))) as Redactor;
}
