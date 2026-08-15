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
//
// Step 12 (targets T5/T6) added the SECOND half — see the reassembly
// sentinel at the bottom of this file, which is stateful across a leg and
// therefore sees what a per-value scrub structurally cannot.
//
// ARBITRARY/LAYERED transforms (gzip+base64, rot-N, custom encodings)
// remain outside what a known-value scrub can reach at all; Step 12 pins
// that as a fact rather than pretending otherwise (T7).

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

// ───────────────────────── the reassembly sentinel (T5/T6) ──────────────
//
// The per-value scrub above is STATELESS, and that is exactly its residual:
// a server that returns `gho_`, then `ABSE`, then `NCEc`… across separate
// tool results emits nothing that any single result recognizes as a token,
// yet the model's conversation ends up holding the whole credential. Step
// 10 named this (spec §12.1); Step 12 owns it.
//
// The sentinel is per-LEG and observes values AFTER the scrub — so every
// byte it sees is a byte that ESCAPED. For each held secret it accumulates
// the set of secret OFFSETS covered by escaped shards, and trips when that
// set reaches SPLIT_TOKEN_MIN_MATCH: the rule is
//
//     across a whole leg, no more of a secret may accumulate than ONE
//     scrubbed fragment would have revealed inside a single result.
//
// On a trip the caller fails closed — the offending result is withheld and
// the connector is severed for the rest of the leg.
//
// TWO honest bounds, stated rather than papered over:
//   1. Shards shorter than SHARD_MIN_MATCH are below the detector. The
//      floor is 5 and not 4 because a 4-gram of a random credential
//      collides with ordinary prose often enough (≈62⁻⁴ per position) that
//      a long run would sever itself; at 5 the false-positive rate is ~62×
//      smaller. An attacker CAN drop to 4-char shards — and then needs ten
//      or more separate tool results for a 40-char token, every one of them
//      metered against the per-tool call cap.
//   2. Up to SPLIT_TOKEN_MIN_MATCH − 1 offsets escape before the trip. The
//      sentinel bounds the leak; it does not make it zero. Nothing keyed on
//      known values can.

/** Shortest escaped run counted as evidence of a shard. See bound (1). */
export const SHARD_MIN_MATCH = 5;

export interface ReassemblyTrip {
  /** Index into the secrets array the sentinel was built over. */
  secretIndex: number;
  /** Distinct offsets of that secret seen across the leg, at the trip. */
  coveredOffsets: number;
  /** How many observed values contributed at least one shard. */
  contributingValues: number;
}

export interface ReassemblySentinel {
  /** Fold one already-redacted value in. Returns a trip the first time the
   * accumulated coverage crosses the threshold, then null (already tripped
   * secrets stop reporting — the caller severs on the first). */
  observe: (value: unknown) => ReassemblyTrip | null;
  /** Distinct covered offsets per secret — the exhibit's measurement. */
  coverage: () => number[];
}

/** Every SHARD_MIN_MATCH-gram of the secret → its start offsets. */
function shardIndex(secret: string): Map<string, number[]> {
  const grams = new Map<string, number[]>();
  for (let i = 0; i + SHARD_MIN_MATCH <= secret.length; i++) {
    const gram = secret.slice(i, i + SHARD_MIN_MATCH);
    const at = grams.get(gram);
    if (at === undefined) grams.set(gram, [i]);
    else at.push(i);
  }
  return grams;
}

export function createReassemblySentinel(
  secrets: Array<string | null | undefined>,
): ReassemblySentinel {
  const held = secrets.filter((s): s is string => typeof s === 'string' && s.length >= 8);
  const state = held.map((secret) => ({
    secret,
    grams: shardIndex(secret),
    covered: new Set<number>(),
    contributors: 0,
    tripped: false,
  }));

  const markString = (s: string, st: (typeof state)[number]): boolean => {
    let touched = false;
    for (let i = 0; i + SHARD_MIN_MATCH <= s.length; i++) {
      const anchors = st.grams.get(s.slice(i, i + SHARD_MIN_MATCH));
      if (anchors === undefined) continue;
      for (const j of anchors) {
        let len = SHARD_MIN_MATCH;
        while (i + len < s.length && j + len < st.secret.length && s[i + len] === st.secret[j + len]) {
          len += 1;
        }
        for (let k = 0; k < len; k++) st.covered.add(j + k);
        touched = true;
      }
    }
    return touched;
  };

  const walkStrings = (value: unknown, visit: (s: string) => void): void => {
    if (typeof value === 'string') visit(value);
    else if (Array.isArray(value)) for (const v of value) walkStrings(v, visit);
    else if (value !== null && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) {
        visit(k);
        walkStrings(v, visit);
      }
    }
  };

  return {
    observe: (value: unknown): ReassemblyTrip | null => {
      for (const [secretIndex, st] of state.entries()) {
        if (st.tripped) continue;
        let touched = false;
        walkStrings(value, (s) => {
          if (markString(s, st)) touched = true;
        });
        if (touched) st.contributors += 1;
        if (st.covered.size >= SPLIT_TOKEN_MIN_MATCH) {
          st.tripped = true;
          return {
            secretIndex,
            coveredOffsets: st.covered.size,
            contributingValues: st.contributors,
          };
        }
      }
      return null;
    },
    coverage: () => state.map((st) => st.covered.size),
  };
}
