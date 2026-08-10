// Per-call spend metering (post-capstone item 1, SPEC §12): a transparent
// wrapper over a provider set that reports every successful complete() call's
// spend AS IT OCCURS — before the response is returned to the caller. The
// three filed instances this closes share one shape: spend became durable
// only at handler COMPLETION, so a killed leg leaked its spend (G2.8 legs
// 3/4: $1.5594 of $2.5881 unmetered) and a fully-cached re-run re-billed
// evidence cost as if it were new spend ($1.1045, zero provider calls).
//
// Modeled on @potion/observability withMetrics (whole-record wrap, per-call
// price re-derivation, provider-scoped alias-or-native lookup), with three
// deliberate differences:
//   1. The sink is AWAITED before the response is returned. An unawaited
//      write dies with the process — which is the under-metering bug in
//      miniature. A sink failure therefore fails the call loudly: silently
//      losing a spend record is the defect this module exists to close.
//   2. Wrapping is memoized BY UNDERLYING INSTANCE. detectProviderMode works
//      by reference identity across the five provider keys (the mock world
//      puts ONE instance behind every id); a naive per-key wrap would make a
//      mock set report 'live'.
//   3. Only successful calls meter — a failed call returns no usage, so
//      there is nothing to bill. (Hedge losers' provider-side tokens are a
//      recorded residual: the winner's response is the only usage returned.)
//
// This wrapper sits OUTSIDE resilient() (which lives inside each factory
// provider), so a retried request meters once, on the attempt that succeeds.
import { costUsd, roundCost } from '@potion/core';
import type { PriceEntry, PriceTable, ProviderId } from '@potion/core';
import type { CompleteRequest, CompleteResponse, Provider } from '@potion/providers';

/** One successful provider call's spend, as reported to the sink. */
export interface SpendCall {
  provider: ProviderId;
  /** The requested model string (alias or native id). */
  model: string;
  /** The provider-resolved concrete version (response.modelVersion). */
  resolvedModel: string;
  inputTokens: number;
  outputTokens: number;
  /** roundCost(costUsd(usage, entry)); 0 when no price entry matches (the
   * call still meters its tokens — spend visibility beats precision). */
  costUsd: number;
  latencyMs: number;
}

/** Awaited per call, BEFORE the response returns to the caller. Throwing
 * fails the call — a spend record that cannot be written must not let the
 * spend proceed invisibly. */
export type SpendSink = (call: SpendCall) => void | Promise<void>;

/** Alias-or-native lookup scoped to the provider (mirrors withMetrics and
 * the strategies resolver matching rule). */
function findPriceEntry(
  prices: PriceTable,
  provider: ProviderId,
  model: string,
): PriceEntry | undefined {
  return prices.entries.find(
    (e) => e.provider === provider && (e.alias === model || e.model === model),
  );
}

function wrapComplete(
  provider: Provider,
  prices: PriceTable,
  sink: SpendSink,
  warned: Set<string>,
): Provider['complete'] {
  return async (req: CompleteRequest): Promise<CompleteResponse> => {
    const res = await provider.complete(req);
    const entry = findPriceEntry(prices, provider.id, req.model);
    if (!entry) {
      const key = `${provider.id}:${req.model}`;
      if (!warned.has(key)) {
        warned.add(key);
        console.warn(
          `[metered-providers] no price entry for ${key} — call meters with costUsd 0 (tokens still recorded)`,
        );
      }
    }
    await sink({
      provider: provider.id,
      model: req.model,
      resolvedModel: res.modelVersion,
      inputTokens: res.usage.inputTokens,
      outputTokens: res.usage.outputTokens,
      costUsd: entry ? roundCost(costUsd(res.usage, entry)) : 0,
      latencyMs: res.latencyMs,
    });
    return res;
  };
}

/**
 * Wrap every provider in the set so each successful complete() reports its
 * spend to `sink` before returning. Identity-preserving: two keys backed by
 * the SAME underlying instance map to the same wrapped instance, so
 * detectProviderMode sees the wrapped set exactly as it saw the original.
 * embed passes through unwrapped (no per-token price entry today — the
 * withMetrics precedent).
 */
export function meteredProviders(
  providers: Record<ProviderId, Provider>,
  prices: PriceTable,
  sink: SpendSink,
): Record<ProviderId, Provider> {
  const memo = new Map<Provider, Provider>();
  const warned = new Set<string>();
  const out = {} as Record<ProviderId, Provider>;
  for (const [id, provider] of Object.entries(providers) as Array<[ProviderId, Provider]>) {
    let wrapped = memo.get(provider);
    if (!wrapped) {
      wrapped = {
        id: provider.id,
        complete: wrapComplete(provider, prices, sink, warned),
      };
      if (provider.embed !== undefined) {
        wrapped.embed = provider.embed.bind(provider);
      }
      memo.set(provider, wrapped);
    }
    out[id] = wrapped;
  }
  return out;
}
