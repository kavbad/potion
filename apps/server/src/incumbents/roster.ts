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
}

export function incumbentRoster(prices: PriceTable): RosterEntry[] {
  const out: RosterEntry[] = [];
  for (const e of prices.entries) {
    if (e.provider === 'mock' || /-class$/.test(e.alias) || WITHHELD.test(e.alias) || WITHHELD.test(e.model)) continue;
    const { name, vendor } = titleFromNative(e.model);
    out.push({ alias: e.alias, name, vendor, native: e.model });
  }
  return out.sort((a, b) => a.vendor.localeCompare(b.vendor) || a.name.localeCompare(b.name));
}
