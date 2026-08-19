// Provider model-list scanning (M4b, ROADMAP #37, SPEC §15.2): new-model
// detection for the autoresearcher. Raw fetch (no SDK), OpenRouter GET
// /models shape:
//   data[].{ id, canonical_slug, created, pricing.{prompt,completion},
//            supported_parameters }
// pricing values are USD PER-TOKEN STRINGS — converted to the price table's
// per-1M numbers with Number(...) × 1e6 (never string-concat). `created`
// (unix seconds) is carried for "new since last scan" reporting; the diff
// itself is against the prices.json registry (an id not in the registry IS
// new). supported_parameters (e.g. 'tools') is preserved for candidate-
// generation capability filters.
import type { PriceEntry, PriceTable } from '@potion/core';

export interface ModelListing {
  /** Provider-native id, e.g. 'anthropic/claude-fable-5'. */
  id: string;
  canonicalSlug?: string;
  /** Unix seconds (OpenRouter `created`). */
  created?: number;
  /** USD per token (parsed from strings). */
  promptPerToken?: number;
  completionPerToken?: number;
  supportedParameters?: string[];
}

export const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';

/** Deterministic registry alias for an OpenRouter id:
 * 'anthropic/claude-fable-5' → 'or-claude-fable-5'. Collisions with existing
 * aliases get a numeric suffix (or-…-2, -3, …). */
export function aliasForOpenRouterId(id: string, existing: ReadonlySet<string>): string {
  const tail = id.includes('/') ? id.slice(id.lastIndexOf('/') + 1) : id;
  const slug = tail
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
  let alias = `or-${slug || 'model'}`;
  for (let n = 2; existing.has(alias); n++) alias = `or-${slug || 'model'}-${n}`;
  return alias;
}

/** Fetch + parse the OpenRouter model list. Raw fetch with a timeout;
 * `fetchImpl` is the test seam. Defensive parsing: malformed entries are
 * skipped, never fatal. */
export async function fetchOpenRouterModels(opts: {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<ModelListing[]> {
  const url = opts.baseUrl ?? OPENROUTER_MODELS_URL;
  const doFetch = opts.fetchImpl ?? fetch;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? 15_000);
  try {
    const res = await doFetch(url, {
      headers: { authorization: `Bearer ${opts.apiKey}` },
      signal: ac.signal,
    });
    if (!res.ok) {
      throw new Error(`OpenRouter /models HTTP ${res.status}`);
    }
    const body = (await res.json()) as { data?: unknown };
    const data = Array.isArray(body.data) ? body.data : [];
    const out: ModelListing[] = [];
    for (const raw of data) {
      if (typeof raw !== 'object' || raw === null) continue;
      const r = raw as Record<string, unknown>;
      if (typeof r['id'] !== 'string' || r['id'].length === 0) continue;
      const pricing = (r['pricing'] ?? {}) as Record<string, unknown>;
      const prompt = Number(pricing['prompt']);
      const completion = Number(pricing['completion']);

      // NOT EVERY CATALOGUE ROW IS A SERVABLE MODEL. Measured against the
      // live OpenRouter catalogue (415 rows), two kinds must never become
      // routing candidates, and both would have without this:
      //
      //   NEGATIVE PRICING (5 rows: openrouter/auto, /auto-beta, /fusion,
      //   /pareto-code, /bodybuilder) — these are OpenRouter's OWN routers,
      //   and the negative number is a sentinel for "varies", not a price.
      //   Routing to a router is circular, unmeasurable, and a negative cost
      //   silently inverts every comparison that reads it: it sorts cheapest,
      //   so it would have become the class representative for the next
      //   sweep, and it makes budget arithmetic run backwards.
      //
      //   :batch VARIANTS (61 rows) — asynchronous batch endpoints, cheaper
      //   because delivery is deferred. A synchronous serving request cannot
      //   use one, so listing them as options for a chat endpoint offers a
      //   choice that cannot be honoured.
      //
      // `:free` variants are KEPT: they are real models on rate-limited
      // tiers, and being unmeasured they are visible-but-never-auto-selected
      // like anything else in the catalogue.
      if (prompt < 0 || completion < 0) continue;
      if (/[:-]batch$/.test(r['id'])) continue;

      out.push({
        id: r['id'],
        ...(typeof r['canonical_slug'] === 'string' ? { canonicalSlug: r['canonical_slug'] } : {}),
        ...(typeof r['created'] === 'number' ? { created: r['created'] } : {}),
        ...(Number.isFinite(prompt) ? { promptPerToken: prompt } : {}),
        ...(Number.isFinite(completion) ? { completionPerToken: completion } : {}),
        ...(Array.isArray(r['supported_parameters'])
          ? { supportedParameters: r['supported_parameters'].filter((p): p is string => typeof p === 'string') }
          : {}),
      });
    }
    return out;
  } finally {
    clearTimeout(timer);
  }
}

export interface ScanDiff {
  /** New registry entries (per-1M pricing converted, alias minted). */
  added: PriceEntry[];
  /** Ids skipped: already registered OR missing/unparseable pricing. */
  alreadyKnown: string[];
  skippedNoPricing: string[];
}

/** Diff listings against the price-table registry. A listing is KNOWN when
 * its id (or canonical slug) matches any entry's `model`. New listings with
 * parseable pricing become candidate registry entries (SPEC: "with
 * provider-reported pricing when present" — without it there is nothing to
 * cost against, so they are reported and skipped). */
/** A listing that came from the mock fixture source ('mock/…'), whatever
 * scan source reported it — the provider id must reflect that (G2.4). */
export function isMockListingId(id: string): boolean {
  return id.startsWith('mock/');
}

export function diffModelListings(listings: ModelListing[], prices: PriceTable): ScanDiff {
  const knownModels = new Set(prices.entries.map((e) => e.model));
  const knownAliases = new Set(prices.entries.map((e) => e.alias));
  const added: PriceEntry[] = [];
  const alreadyKnown: string[] = [];
  const skippedNoPricing: string[] = [];
  for (const l of listings) {
    if (knownModels.has(l.id) || (l.canonicalSlug !== undefined && knownModels.has(l.canonicalSlug))) {
      alreadyKnown.push(l.id);
      continue;
    }
    if (l.promptPerToken === undefined || l.completionPerToken === undefined) {
      skippedNoPricing.push(l.id);
      continue;
    }
    const alias = aliasForOpenRouterId(l.id, knownAliases);
    knownAliases.add(alias);
    knownModels.add(l.id);
    added.push({
      alias,
      // G2.4 (false-live class): a MOCK-namespaced listing keeps the 'mock'
      // provider id. Pre-G2.4 every scanned listing — including the
      // mock/* fixtures the mock scan source emits — was stamped
      // 'openrouter', which made the entries INVISIBLE to every
      // provider === 'mock' guard (reachable(), classRepresentative's
      // excludeProvider, MockAliasInLiveRunError) and therefore eligible
      // as live class representatives.
      provider: isMockListingId(l.id) ? 'mock' : 'openrouter',
      model: l.id,
      // per-token × 1e6 → per-1M (Number arithmetic, never string-concat).
      inputPer1M: l.promptPerToken * 1e6,
      outputPer1M: l.completionPerToken * 1e6,
    });
  }
  return { added, alreadyKnown, skippedNoPricing };
}

// ---------------------------------------------------------------------------
// Mock fixture (SPEC §15.2: "mock provider exposes models() fixture for
// tests") — deterministic listings standing in for a provider /models
// endpoint: one already-registered model, two NEW ones (with per-token
// string pricing, to exercise the ×1e6 path), one new one WITHOUT pricing.
// ---------------------------------------------------------------------------

export const MOCK_MODEL_LISTINGS: readonly ModelListing[] = [
  { id: 'mock-cheap-v1', canonicalSlug: 'mock-cheap-v1', created: 1_751_000_000 },
  {
    id: 'mock/mock-nova-1',
    canonicalSlug: 'mock/mock-nova-1',
    created: 1_754_500_000,
    promptPerToken: 2e-7, // $0.20 / 1M
    completionPerToken: 8e-7, // $0.80 / 1M
    supportedParameters: ['tools'],
  },
  {
    id: 'mock/mock-apex-1',
    canonicalSlug: 'mock/mock-apex-1',
    created: 1_754_600_000,
    promptPerToken: 1.2e-5, // $12.00 / 1M
    completionPerToken: 6e-5, // $60.00 / 1M
  },
  { id: 'mock/mock-free-0', canonicalSlug: 'mock/mock-free-0', created: 1_754_700_000 },
];

/** The mock "models()" fixture — same shape a live scan returns. */
export function mockModels(): ModelListing[] {
  return MOCK_MODEL_LISTINGS.map((l) => ({ ...l }));
}
