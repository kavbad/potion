import { createHash } from 'node:crypto';

/** Canonical JSON: stable key order, no whitespace. Arrays keep order. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = sortKeys((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

export function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** sha256 of the canonical JSON of a strategy config. */
export function strategyHash(cfg: unknown): string {
  return sha256(canonicalJson(cfg));
}

/**
 * The identity of what a suite MEASURES (F7).
 *
 * Certification used to be keyed on `(suiteId, suiteVersion)`, and the version
 * moves in exactly one place — when items are ADDED. So removal never moved
 * it, and rewriting every item's judge rubric never moved it: a suite could be
 * halved by a retention purge, or re-scored against a completely different
 * rubric, and its certification stood. Measured, all three cases.
 *
 * This hashes the set that actually determines the measurement: the item
 * roster plus, per item, the prompt, the reference answer, and the scoring
 * config (which carries the rubric, the judge model, and the scale).
 *
 * Order-independent by construction — items are sorted by id before hashing —
 * because insertion order is not part of what a suite means, and a gate that
 * flipped on row order would be a random refusal generator.
 */
export function suiteContentHash(
  items: ReadonlyArray<{
    itemId: string;
    prompt: unknown;
    reference?: unknown;
    scoring: unknown;
  }>,
): string {
  const canonical = [...items]
    .sort((a, b) => (a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0))
    .map((i) => ({
      itemId: i.itemId,
      prompt: i.prompt,
      reference: i.reference ?? null,
      scoring: i.scoring,
    }));
  return sha256(canonicalJson(canonical));
}
