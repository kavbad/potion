// Which calibration call dies? Reproduce the first item's calls one by one.
import { readFileSync } from 'node:fs';
process.env.POTION_PRICES_PATH = process.env.POTION_PRICES_PATH ?? '/app/prices.json';
const { createProviders, loadPrices } = await import('@potion/providers');
const { table } = loadPrices(process.env.POTION_PRICES_PATH);
const providers = createProviders({ prices: table, maxRetries: 0 });
const or = providers.openrouter!;
const item = JSON.parse(readFileSync('/app/packages/harness/suites/v2/classification-hard-v1/items.jsonl', 'utf8').split('\n').filter(Boolean)[0]!) as { prompt: Array<{role:string;content:string}> };
for (const model of ['or-gemini-3.7-flash', 'or-judge', 'or-gpt-mini', 'or-gemini-flash']) {
  try {
    const r = await or.complete({ model, messages: item.prompt as never, params: { maxTokens: 100 } });
    console.log(`${model}: OK (${r.text.trim().slice(0, 30).replace(/\n/g, ' ')})`);
  } catch (e) {
    console.log(`${model}: FAIL — ${(e as Error).message}`);
  }
}
