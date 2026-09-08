// code-review-hard-v1 format probe (2026-09-07).
//
// The 16 exact-scored items of code-review-hard-v1 ask a REASONING question
// ("which single line must change?") and score the whole answer against a bare
// gold ("3", or "NONE"). Unlike multi-step-reasoning the prompt does say
// "answer with that line's number and nothing else. Do not explain." — so the
// conflation may or may not bite. This probe measures it instead of guessing:
// every item, three models, scored BOTH ways.
//
//   strict    — what the suite scores today (whole-text exact, normalized).
//   lenient   — the substance: the last number in the answer, or NONE when the
//               answer says none/no defect/correct as written.
//
// A gap means the frontier is paying for format obedience. No gap means the
// instrument is honest and code-review needs no re-measurement. Pennies.
//
//   KEY_RISK_ACCEPTED=2026-09-07 npx tsx scripts/code-review-format-probe.ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (existsSync(`${REPO}/.env`)) {
  for (const line of readFileSync(`${REPO}/.env`, 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2]!.replace(/^"|"$/g, '');
  }
}
for (const k of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GOOGLE_API_KEY']) delete process.env[k];
if (!process.env.KEY_RISK_ACCEPTED) throw new Error('live spend: set KEY_RISK_ACCEPTED=<date>');
process.env.POTION_PRICES_PATH = process.env.POTION_PRICES_PATH ?? `${REPO}/prices.json`;

const { createProviders, loadPrices } = await import('@potion/providers');
const { loadSuiteV2 } = await import(`${REPO}/packages/harness/dist/ingest/suite-v2.js`);
const { normalizeText } = await import(`${REPO}/packages/harness/dist/scorers.js`);

const { table } = loadPrices(process.env.POTION_PRICES_PATH!);
const providers = createProviders({ prices: table, maxRetries: 2 });
const or = providers.openrouter;
if (!or) throw new Error('no openrouter provider');

type Item = { id: string; prompt: { role: 'user' | 'system' | 'assistant'; content: string }[]; reference: unknown; scoring: { kind: string } };
const items = (loadSuiteV2('code-review-hard-v1').items as Item[]).filter((i) => i.scoring.kind === 'exact');

/** The substance behind the formatting: NONE, else the last number named. */
function lenient(answer: string): string | null {
  const t = answer.replace(/[*`]/g, '').trim();
  if (/\b(none|no\s+defect|no\s+correctness\s+defect|correct\s+as\s+written)\b/i.test(t)) return 'NONE';
  const nums = t.match(/\d+/g);
  return nums?.at(-1) ?? null;
}

const MODELS = (process.env.PROBE_MODELS ?? 'or-ling-3.0-flash,or-gemini-flash,or-gpt-full').split(',');
const rows: Record<string, unknown>[] = [];
console.log(`code-review format probe: ${items.length} exact items × ${MODELS.length} models\n`);

for (const model of MODELS) {
  let strict = 0, len = 0, errs = 0;
  const disagree: string[] = [];
  for (const item of items) {
    const gold = String(item.reference);
    let text: string;
    try {
      const r = await or.complete({ model, messages: item.prompt, params: { seed: 7, maxTokens: 600 } });
      text = r.text;
    } catch (e) {
      errs++; rows.push({ model, id: item.id, gold, error: String((e as Error).message).slice(0, 120) });
      continue;
    }
    const s = normalizeText(gold) === normalizeText(text) ? 1 : 0;
    const l = (lenient(text) ?? '').toUpperCase() === gold.toUpperCase() ? 1 : 0;
    strict += s; len += l;
    if (s !== l) disagree.push(`${item.id} gold=${gold} answer=${JSON.stringify(text.slice(0, 90))}`);
    rows.push({ model, id: item.id, gold, strict: s, lenient: l, answer: text.slice(0, 400) });
  }
  const n = items.length - errs;
  console.log(`${model.padEnd(24)} strict ${(strict / n).toFixed(3)}   lenient ${(len / n).toFixed(3)}   gap ${((len - strict) / n).toFixed(3)}   errors ${errs}`);
  for (const d of disagree.slice(0, 6)) console.log(`    ${d}`);
  console.log('');
}
const ART = '/private/tmp/claude-501/-Users-kavonbadie-Downloads-potion/706d03b2-0722-4e36-b908-18e0e34887bf/scratchpad/msr-v2';
mkdirSync(ART, { recursive: true });
writeFileSync(`${ART}/code-review-probe.json`, JSON.stringify(rows, null, 1));
console.log(`artifact ${ART}/code-review-probe.json`);
