// The incumbent picker's roster: the models a customer could plausibly be
// using today, with names a person recognises, built from the price table's
// native ids. Excludes the withheld winner, mock aliases, and the *-class
// pseudo-aliases. A customer whose model is not here types it; the audit
// then waits until that model is priced and measured.
import type { PriceTable } from '@potion/core';

const WITHHELD = /solar|upstage/i;

const VENDOR: Record<string, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  google: 'Google',
  'x-ai': 'xAI',
  deepseek: 'DeepSeek',
  'moonshotai': 'Moonshot',
  qwen: 'Qwen',
  'z-ai': 'Z.ai',
  nvidia: 'NVIDIA',
  inclusionai: 'inclusionAI',
  'kwaipilot': 'Kwaipilot',
  bytedance: 'ByteDance',
};

function titleFromNative(native: string): { name: string; vendor: string } {
  const [vendorRaw, ...rest] = native.split('/');
  const model = rest.join('/') || native;
  const vendor = VENDOR[vendorRaw ?? ''] ?? (vendorRaw ?? '').replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  const name = model
    .replace(/[-_]/g, ' ')
    .replace(/\bgpt\b/i, 'GPT')
    .replace(/\bclaude\b/i, 'Claude')
    .replace(/\bgemini\b/i, 'Gemini')
    .replace(/\bgrok\b/i, 'Grok')
    .replace(/\bdeepseek\b/i, 'DeepSeek')
    .replace(/\bqwen\b/i, 'Qwen')
    .replace(/\bkimi\b/i, 'Kimi')
    .replace(/\bglm\b/i, 'GLM')
    .replace(/\b(\w)/g, (c) => c.toUpperCase())
    .replace(/\bGpt\b/g, 'GPT')
    .replace(/\bGlm\b/g, 'GLM');
  return { name, vendor };
}

export interface RosterEntry {
  alias: string;
  name: string;
  vendor: string;
  native: string;
  /** Other aliases priced for the same native model (2026-08-22: the
   * picker showed one model twice when a tranche alias duplicated it). */
  alternates: string[];
}

export function incumbentRoster(prices: PriceTable): RosterEntry[] {
  const byNative = new Map<string, RosterEntry>();
  for (const e of prices.entries) {
    if (e.provider === 'mock' || /-class$/.test(e.alias) || WITHHELD.test(e.alias) || WITHHELD.test(e.model)) continue;
    const key = `${e.provider}:${e.model}`;
    const seen = byNative.get(key);
    if (seen) {
      // Canonical alias = the shortest; a tranche or dated alias is longer.
      const aliases = [...seen.alternates, seen.alias, e.alias].sort((a, b) => a.length - b.length || a.localeCompare(b));
      seen.alias = aliases[0]!;
      seen.alternates = aliases.slice(1);
      continue;
    }
    const { name, vendor } = titleFromNative(e.model);
    byNative.set(key, { alias: e.alias, name, vendor, native: e.model, alternates: [] });
  }
  return [...byNative.values()].sort((a, b) => a.vendor.localeCompare(b.vendor) || a.name.localeCompare(b.name));
}

/**
 * A model the customer TYPED ("other" in the picker), resolved against the
 * roster so the learning period can measure it: an exact alias, a native id,
 * or a case-insensitive match on the display name. Null when nothing in the
 * measured roster is that model — the honest answer is then "not measured
 * yet", not a guess.
 */
export function resolveTypedModel(typed: string, roster: RosterEntry[]): RosterEntry | null {
  const t = typed.trim().toLowerCase();
  if (t === '') return null;
  const norm = (x: string) => x.toLowerCase().replace(/[\s_]+/g, '-');
  for (const r of roster) {
    if (r.alias === t || r.alternates.includes(t) || r.native.toLowerCase() === t) return r;
  }
  for (const r of roster) {
    if (norm(r.name) === norm(t) || norm(`${r.vendor} ${r.name}`) === norm(t)) return r;
  }
  const bare = t.includes('/') ? t.slice(t.indexOf('/') + 1) : t;
  const hits = roster.filter((r) => r.native.toLowerCase().endsWith(`/${bare}`) || norm(r.name).includes(norm(bare)));
  return hits.length === 1 ? hits[0]! : null;
}
