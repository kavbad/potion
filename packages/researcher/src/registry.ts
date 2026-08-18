// Model registry (SPEC §15.1): the class-pruned view of the versioned price
// table the candidate generator reasons over. A registry entry is a price
// entry plus its capability class — 'cheap' | 'mid' | 'strong' answerers and
// the 'judge' class (scorers that never answer).
//
// classifyModel precedence:
//   1. alias hints (human-named aliases encode intent: *-cheap-class, or-judge…)
//   2. price bands on inputPer1M (≤ $0.5 cheap, ≤ $3 mid, > $3 strong)
// Scanned OpenRouter models arrive with machine aliases (or-<slug>) and
// provider-reported pricing, so the price band is what classifies them —
// the bands are deliberately wide and documented rather than "smart".
import type { PriceEntry, PriceTable, ProviderId } from '@potion/core';

export type ModelClass = 'cheap' | 'mid' | 'strong' | 'judge';
export const MODEL_CLASSES: readonly ModelClass[] = ['cheap', 'mid', 'strong', 'judge'];

/** Answerer classes in escalation order (judge is not an answerer). */
export const ANSWERER_CLASSES = ['cheap', 'mid', 'strong'] as const;
export type AnswererClass = (typeof ANSWERER_CLASSES)[number];

export interface ModelRegistryEntry {
  alias: string;
  provider: ProviderId;
  cls: ModelClass;
  inputPer1M: number;
  outputPer1M: number;
}

const CHEAP_HINTS = ['cheap', 'haiku', 'mini', 'flash'];
const STRONG_HINTS = ['frontier', 'opus'];

/** Classify one price entry. Alias hints win — matched against alias
 * SEGMENTS (split on -/_./space), never raw substrings, so 'gemini-pro' is
 * not felled by the 'mini' inside 'gemini'. Price bands are the fallback. */
export function classifyModel(entry: PriceEntry): ModelClass {
  const segments = entry.alias.toLowerCase().split(/[-_./\s]+/);
  if (segments.includes('judge')) return 'judge';
  if (CHEAP_HINTS.some((h) => segments.includes(h))) return 'cheap';
  if (STRONG_HINTS.some((h) => segments.includes(h))) return 'strong';
  if (entry.inputPer1M <= 0.5) return 'cheap';
  if (entry.inputPer1M <= 3) return 'mid';
  return 'strong';
}

/** Build the class-annotated registry from a price table. Mock aliases stay
 * in (mock research cycles generate candidates over the mock registry —
 * SPEC §15.3); callers that want live-only registries filter provider. */
export function buildRegistry(prices: PriceTable): ModelRegistryEntry[] {
  return prices.entries.map((e) => ({
    alias: e.alias,
    provider: e.provider,
    cls: classifyModel(e),
    inputPer1M: e.inputPer1M,
    outputPer1M: e.outputPer1M,
  }));
}

/** The deterministic class representative: cheapest input price, alias as
 * tie-break. `excludeProvider` skips entries of one provider (cross-provider
 * peer selection). */
export function classRepresentative(
  registry: ModelRegistryEntry[],
  cls: ModelClass,
  excludeProvider?: ProviderId,
): ModelRegistryEntry | null {
  const pool = registry
    .filter((e) => e.cls === cls && e.provider !== excludeProvider)
    .sort((x, y) => x.inputPer1M - y.inputPer1M || x.alias.localeCompare(y.alias));
  return pool[0] ?? null;
}

/**
 * EVERY model of a class, cheapest first (alias tie-break) — the widened
 * counterpart to classRepresentative (SERVING-ROADMAP S6).
 *
 * `classRepresentative` returns ONE model per class, which is right when the
 * question is "a representative of this tier" and wrong when the question is
 * "what can we actually route to". Measured against the real OpenRouter-
 * reachable registry that single pick discarded five of eight answerers —
 * or-gemini-flash, or-gpt-mini, or-haiku, or-gpt-full and or-sonnet were in
 * the catalog and had never been evaluated on any cluster. Under dial honesty
 * an unmeasured model is never routable, so those five were, in practice,
 * unreachable breadth.
 *
 * Deterministic ordering (price, then alias) so a sweep's candidate set is
 * reproducible from the registry alone — the same discipline the
 * representative pick already had, applied to the whole class.
 */
export function classMembers(
  registry: ModelRegistryEntry[],
  cls: ModelClass,
  excludeProvider?: ProviderId,
): ModelRegistryEntry[] {
  return registry
    .filter((e) => e.cls === cls && e.provider !== excludeProvider)
    .sort((x, y) => x.inputPer1M - y.inputPer1M || x.alias.localeCompare(y.alias));
}

/** Up to `n` same-class peers from providers OTHER than `provider`,
 * provider-diverse first (one per provider), then cheapest fill — fully
 * deterministic (price, alias ordering). */
export function crossProviderPeers(
  registry: ModelRegistryEntry[],
  cls: ModelClass,
  provider: ProviderId,
  n: number,
): ModelRegistryEntry[] {
  const pool = registry
    .filter((e) => e.cls === cls && e.provider !== provider)
    .sort((x, y) => x.inputPer1M - y.inputPer1M || x.alias.localeCompare(y.alias));
  const seen = new Set<ProviderId>();
  const diverse: ModelRegistryEntry[] = [];
  const rest: ModelRegistryEntry[] = [];
  for (const e of pool) {
    if (!seen.has(e.provider)) {
      seen.add(e.provider);
      diverse.push(e);
    } else {
      rest.push(e);
    }
  }
  return [...diverse, ...rest].slice(0, n);
}
