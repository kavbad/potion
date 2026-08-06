// Live-provider smoke test (SPEC §10): for each provider with an API key in
// the environment, run ONE 20-token "Say OK" completion against the cheapest
// prices.json alias of that provider and print text + tokens + cost + latency.
// Providers without keys are skipped; with NO keys at all this prints a
// dry-run summary and exits 0. Refuses to run (exit 1) when the projected
// total spend exceeds $1. NEVER runs against the mock provider.
//
//   ANTHROPIC_API_KEY / OPENAI_API_KEY / GOOGLE_API_KEY / OPENROUTER_API_KEY
//
//   pnpm smoke:live
//
// M1b single-key path: when only OPENROUTER_API_KEY is present, this runs
// exactly one 20-max-token "Say OK" completion on `or-gpt-mini` (the cheapest
// openrouter alias in prices.json: $0.40/$1.60 per 1M in/out) via the real
// OpenRouter endpoint, and reports the actual cost computed from the
// response `usage` × our price entry, plus the remaining budget under the cap.
import { fileURLToPath } from 'node:url';
import type { PriceEntry, ProviderId } from '@potion/core';
import { costOf, createProviders, loadPrices } from '@potion/providers';

const PRICES_PATH = fileURLToPath(new URL('../prices.json', import.meta.url));
const SPEND_CAP_USD = 1.0;
const MAX_TOKENS = 20;

const ENV_VARS: Record<Exclude<ProviderId, 'mock'>, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GOOGLE_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
};

/** Cheapest alias for a provider by blended (input+output) list price. */
function cheapestAlias(entries: PriceEntry[], provider: ProviderId): PriceEntry | undefined {
  return entries
    .filter((e) => e.provider === provider)
    .sort((a, b) => a.inputPer1M + a.outputPer1M - (b.inputPer1M + b.outputPer1M))[0];
}

/**
 * M1b region fallback: OpenAI/Anthropic/Google upstreams can return
 * "This model is not available in your region" (HTTP 403) depending on the
 * caller's egress region — observed live 2026-08-04 for ALL six mission
 * models (or-gpt-mini, or-gemini-flash, or-haiku, or-gpt-full,
 * or-gemini-pro, or-sonnet/or-judge). `or-deepseek` (SiliconFlow upstream)
 * is the documented last-resort alias that keeps the single-key live path
 * provable from such regions; it is tried ONLY after the mission aliases.
 */
const REGION_FALLBACK_ALIAS: Partial<Record<Exclude<ProviderId, 'mock'>, string>> = {
  openrouter: 'or-deepseek',
};

/** Max candidate aliases tried per provider in one run (first success wins). */
const MAX_CANDIDATES_PER_PROVIDER = 3;

/**
 * Candidate aliases for a provider, cheapest first, with the region-fallback
 * alias (if any) pinned LAST regardless of price so the mission aliases are
 * always attempted first. At most MAX_CANDIDATES_PER_PROVIDER entries, with
 * the fallback always included when defined.
 */
function candidateAliases(entries: PriceEntry[], provider: Exclude<ProviderId, 'mock'>): PriceEntry[] {
  const fallback = REGION_FALLBACK_ALIAS[provider];
  const sorted = entries
    .filter((e) => e.provider === provider && e.alias !== fallback)
    .sort((a, b) => a.inputPer1M + a.outputPer1M - (b.inputPer1M + b.outputPer1M));
  const fb = entries.find((e) => e.provider === provider && e.alias === fallback);
  const primary = sorted.slice(0, fb ? MAX_CANDIDATES_PER_PROVIDER - 1 : MAX_CANDIDATES_PER_PROVIDER);
  return fb ? [...primary, fb] : primary;
}

/** Conservative pre-flight projection: ~40 input tokens + full 20 output tokens. */
function projectedCostUsd(entry: PriceEntry): number {
  return (40 * entry.inputPer1M + MAX_TOKENS * entry.outputPer1M) / 1_000_000;
}

interface Plan {
  provider: Exclude<ProviderId, 'mock'>;
  /** Cheapest-first candidates (region-fallback pinned last); first success wins. */
  candidates: PriceEntry[];
}

/** Conservative pre-flight projection: worst case = ONE call on the priciest candidate tried. */
function projectedPlanCostUsd(plan: Plan): number {
  return Math.max(...plan.candidates.map(projectedCostUsd));
}

async function main(): Promise<void> {
  const { table: prices, stale } = loadPrices(PRICES_PATH);
  console.log('── Potion: live provider smoke ─────────────────────────────────');
  console.log(`prices        : v${prices.version} (${prices.entries.length} aliases)${stale ? ' [STALE — list prices may have drifted]' : ''}`);

  const apiKeys: Partial<Record<ProviderId, string>> = {};
  const plans: Plan[] = [];
  const skipped: string[] = [];

  for (const [provider, envVar] of Object.entries(ENV_VARS) as Array<
    [Exclude<ProviderId, 'mock'>, string]
  >) {
    const key = process.env[envVar];
    if (!key) {
      skipped.push(`${provider.padEnd(10)} (no ${envVar} — skipped)`);
      continue;
    }
    const candidates = candidateAliases(prices.entries, provider);
    if (candidates.length === 0) {
      skipped.push(`${provider.padEnd(10)} (key present but no prices.json alias — skipped)`);
      continue;
    }
    apiKeys[provider] = key;
    plans.push({ provider, candidates });
  }

  // ── dry-run when no keys exist (exit 0) ────────────────────────────────
  if (plans.length === 0) {
    console.log('mode          : DRY-RUN (no provider API keys in env — nothing will be called)');
    console.log('would run     : one 20-token "Say OK" completion per provider with a key,');
    console.log('                using that provider\'s cheapest prices.json alias:');
    for (const provider of Object.keys(ENV_VARS) as Array<Exclude<ProviderId, 'mock'>>) {
      const entry = cheapestAlias(prices.entries, provider);
      const line = entry
        ? `${entry.alias} (${entry.model}, $${entry.inputPer1M}/$${entry.outputPer1M} per 1M in/out, ~$${projectedCostUsd(entry).toFixed(6)}/call)`
        : '(no prices.json alias — would be skipped)';
      console.log(`  ${ENV_VARS[provider].padEnd(18)} → ${line}`);
    }
    for (const s of skipped) console.log(`skipped       : ${s}`);
    console.log(`spend cap     : $${SPEND_CAP_USD.toFixed(2)} (projected $0.000000 — dry run)`);
    console.log('result        : OK (dry-run, exit 0)');
    return;
  }

  // ── spend-cap refusal (checked BEFORE any network call) ────────────────
  const projectedTotal = plans.reduce((s, p) => s + projectedPlanCostUsd(p), 0);
  console.log(`providers     : ${plans.map((p) => `${p.provider}→${p.candidates.map((c) => c.alias).join('|')}`).join(', ')}`);
  for (const s of skipped) console.log(`skipped       : ${s}`);
  console.log(`projected     : $${projectedTotal.toFixed(6)} (cap $${SPEND_CAP_USD.toFixed(2)})`);
  if (projectedTotal > SPEND_CAP_USD) {
    console.error(
      `REFUSING to continue: projected spend $${projectedTotal.toFixed(6)} exceeds the $${SPEND_CAP_USD.toFixed(2)} cap.`,
    );
    process.exit(1);
  }

  // ── run one tiny completion per keyed provider (fallback chain: first success wins) ──
  const providers = createProviders({ prices, apiKeys });
  let totalSpend = 0;
  let failures = 0;
  for (const { provider, candidates } of plans) {
    let done = false;
    for (const entry of candidates) {
      const t0 = Date.now();
      try {
        const res = await providers[provider].complete({
          model: entry.alias,
          messages: [{ role: 'user', content: 'Say OK' }],
          params: { maxTokens: MAX_TOKENS },
        });
        const cost = costOf(res, entry);
        totalSpend += cost;
        console.log(
          `${provider.padEnd(10)} ✓ "${res.text.trim().slice(0, 60)}" | ` +
            `tokens ${res.usage.inputTokens}in/${res.usage.outputTokens}out | ` +
            `$${cost.toFixed(6)} | ${res.latencyMs}ms (wall ${Date.now() - t0}ms) | ` +
            `model ${res.modelVersion} | alias ${entry.alias}`,
        );
        done = true;
        break;
      } catch (err) {
        console.log(
          `${provider.padEnd(10)} ✗ ${entry.alias}: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`,
        );
      }
    }
    if (!done) failures++;
  }

  console.log(`total spend   : $${totalSpend.toFixed(6)} (projected $${projectedTotal.toFixed(6)}, cap $${SPEND_CAP_USD.toFixed(2)})`);
  console.log(`budget left   : $${(SPEND_CAP_USD - totalSpend).toFixed(6)} of the $${SPEND_CAP_USD.toFixed(2)} script cap`);
  if (totalSpend > SPEND_CAP_USD) {
    console.error(`spend $${totalSpend.toFixed(6)} exceeded the $${SPEND_CAP_USD.toFixed(2)} cap`);
    process.exit(1);
  }
  console.log(failures > 0 ? `result        : ${failures}/${plans.length} provider(s) failed` : 'result        : OK');
  if (failures > 0) process.exit(1);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err : String(err));
  process.exit(1);
});
