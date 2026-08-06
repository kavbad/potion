// Versioned price table loading + cost accounting (SPEC §2/§5).
import { readFileSync } from 'node:fs';
import { PriceTableSchema, costUsd } from '@potion/core';
import type { PriceEntry, PriceTable } from '@potion/core';
import type { CompleteResponse } from './types.js';

export const STALENESS_DAYS = 30;

export interface LoadedPrices {
  table: PriceTable;
  /** true when updatedAt is more than STALENESS_DAYS old (also console.warn's). */
  stale: boolean;
  path: string;
}

export interface Staleness {
  stale: boolean;
  ageDays: number;
}

/** Staleness check against `now` (injectable for tests). */
export function pricesStaleness(table: PriceTable, now: Date = new Date()): Staleness {
  const ageMs = now.getTime() - new Date(table.updatedAt).getTime();
  const ageDays = Math.floor(ageMs / 86_400_000);
  return { stale: ageDays > STALENESS_DAYS, ageDays };
}

/**
 * Load + validate a prices.json. Defaults to `<cwd>/prices.json`.
 * Warns (console.warn) and flags when the table is older than 30 days.
 */
export function loadPrices(path: string = `${process.cwd()}/prices.json`): LoadedPrices {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  const table = PriceTableSchema.parse(raw);
  const { stale, ageDays } = pricesStaleness(table);
  if (stale) {
    console.warn(
      `[potion] prices.json (version ${table.version}) is ${ageDays} days old ` +
        `(updatedAt ${table.updatedAt}) — list prices may have drifted; refresh the table.`,
    );
  }
  return { table, stale, path };
}

/** USD cost of one call's response under a price entry (delegates to core costUsd). */
export function costOf(response: CompleteResponse, priceEntry: PriceEntry): number {
  return costUsd(response.usage, priceEntry);
}
