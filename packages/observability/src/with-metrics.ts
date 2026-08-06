// withMetrics (SPEC §12.3): transparent proxy over a provider set that
// observes every complete()/embed() call — duration, USD cost (via the
// existing `costOf` helper from @potion/providers), and errors. The proxy
// must be behavior-identical: same return values, same thrown errors, same
// ProviderId, embed stays undefined when the underlying provider lacks it.
import { performance } from 'node:perf_hooks';
import type { PriceEntry, PriceTable, ProviderId } from '@potion/core';
import type { CompleteRequest, CompleteResponse, Provider } from '@potion/providers';
import { costOf } from '@potion/providers';
import type { Metrics } from './metrics.js';

export interface WithMetricsOptions {
  /** Price table for cost accounting. Without it costs record as 0 (calls
   * and durations still observed). */
  prices?: PriceTable;
}

/** Alias-or-native-model lookup scoped to the provider (mirrors the
 * resolver's matching rule in @potion/strategies). */
function findPriceEntry(
  prices: PriceTable,
  provider: ProviderId,
  model: string,
): PriceEntry | undefined {
  return prices.entries.find(
    (e) => e.provider === provider && (e.alias === model || e.model === model),
  );
}

function errorLabel(err: unknown): string {
  if (err instanceof Error) return err.name || 'Error';
  return 'Error';
}

function wrapComplete(
  provider: Provider,
  meter: Metrics,
  prices: PriceTable | undefined,
): Provider['complete'] {
  return async (req: CompleteRequest): Promise<CompleteResponse> => {
    const t0 = performance.now();
    try {
      const res = await provider.complete(req);
      const entry = prices ? findPriceEntry(prices, provider.id, req.model) : undefined;
      const costUsd = entry ? costOf(res, entry) : 0;
      meter.observeProviderCall({
        provider: provider.id,
        model: req.model,
        // Provider-reported upstream latency when available (mock latency
        // profiles don't actually sleep), else measured wall time.
        durationMs: res.latencyMs > 0 ? res.latencyMs : performance.now() - t0,
        costUsd,
      });
      return res;
    } catch (err) {
      meter.observeProviderCall({
        provider: provider.id,
        model: req.model,
        durationMs: performance.now() - t0,
        costUsd: 0,
        error: errorLabel(err),
      });
      throw err;
    }
  };
}

function wrapEmbed(
  provider: Provider,
  embed: NonNullable<Provider['embed']>,
  meter: Metrics,
): NonNullable<Provider['embed']> {
  return async (texts: string[]): Promise<number[][]> => {
    const t0 = performance.now();
    try {
      const vectors = await embed.call(provider, texts);
      meter.observeProviderCall({
        provider: provider.id,
        model: 'embed',
        durationMs: performance.now() - t0,
        costUsd: 0, // embeddings carry no per-token price entry today
      });
      return vectors;
    } catch (err) {
      meter.observeProviderCall({
        provider: provider.id,
        model: 'embed',
        durationMs: performance.now() - t0,
        costUsd: 0,
        error: errorLabel(err),
      });
      throw err;
    }
  };
}

/** Wrap every provider in the set. Providers without `embed` keep it
 * undefined (the strategies/cluster packages feature-detect on that). */
export function withMetrics(
  providers: Record<ProviderId, Provider>,
  meter: Metrics,
  opts: WithMetricsOptions = {},
): Record<ProviderId, Provider> {
  const out = {} as Record<ProviderId, Provider>;
  for (const [id, provider] of Object.entries(providers) as Array<[ProviderId, Provider]>) {
    const wrapped: Provider = {
      id: provider.id,
      complete: wrapComplete(provider, meter, opts.prices),
    };
    if (provider.embed !== undefined) {
      wrapped.embed = wrapEmbed(provider, provider.embed, meter);
    }
    out[id] = wrapped;
  }
  return out;
}
