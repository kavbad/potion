// Alias → provider+price resolver (SPEC §3 ExecContext.resolve helper).
import type { PriceEntry, PriceTable, ProviderId } from '@potion/core';
import type { Provider } from '@potion/providers';

/** Build the ExecContext.resolve function from providers + price table. */
export function createResolver(
  providers: Record<ProviderId, Provider>,
  prices: PriceTable,
): (model: string) => { provider: Provider; entry: PriceEntry } {
  return (model: string) => {
    const entry = prices.entries.find((e) => e.alias === model || e.model === model);
    if (!entry) {
      throw new Error(
        `unknown model '${model}' — not an alias or native id in prices.json ` +
          `(version ${prices.version})`,
      );
    }
    const provider = providers[entry.provider];
    if (!provider) throw new Error(`no provider instance for '${entry.provider}'`);
    return { provider, entry };
  };
}
