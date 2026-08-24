// R4 flake probe (2026-08-24): dv(x→gemini-flash) and dv(x→solar) contain
// after 0 cells with 'Provider returned error', while the same models serve
// fine as singles. The one wire difference is the verify call: an assistant
// message in history. Reproduce it per model, capture the real upstream
// error. Pennies of spend; KEY_RISK_ACCEPTED required all the same.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (existsSync(`${REPO}/.env`)) {
  for (const line of readFileSync(`${REPO}/.env`, 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2]!.replace(/^"|"$/g, '');
  }
}
if (!process.env.KEY_RISK_ACCEPTED) throw new Error('live spend: set KEY_RISK_ACCEPTED=<date>');
process.env.POTION_PRICES_PATH = process.env.POTION_PRICES_PATH ?? `${REPO}/prices.json`;

const { createProviders, loadPrices } = await import('@potion/providers');
const { table } = loadPrices(process.env.POTION_PRICES_PATH!);
const providers = createProviders({ prices: table, maxRetries: 0 });
const or = providers.openrouter;
if (!or) throw new Error('no openrouter provider');

const VERIFY = [
  { role: 'user' as const, content: 'Write a python function add(a, b) that returns their sum. Return only code.' },
  { role: 'assistant' as const, content: 'def add(a, b):\n    return a + b' },
  { role: 'user' as const, content: 'Verify the draft answer above for correctness and completeness. If anything is wrong or missing, correct it. Return only the final corrected answer.' },
];
const PLAIN = [VERIFY[0]!];
const LONG_DRAFT = Array.from({ length: 40 }, (_, i) =>
  `def helper_${i}(x, y):\n    """Compute variant ${i}."""\n    acc = 0\n    for k in range(x):\n        acc += (k * y + ${i}) % 7\n    return acc\n`,
).join('\n');
const VERIFY_LONG = [
  { role: 'user' as const, content: 'Write a python module of helper functions. Return only code.' },
  { role: 'assistant' as const, content: LONG_DRAFT },
  { role: 'user' as const, content: 'Verify the draft answer above for correctness and completeness. If anything is wrong or missing, correct it. Return only the final corrected answer.' },
];


for (const model of ['or-gemini-flash', 'or-solar-pro4', 'or-gpt-full']) {
  for (const [label, messages, params] of [
    ['plain', PLAIN, { maxTokens: 200 }],
    ['verify-wire', VERIFY, { maxTokens: 200 }],
    ['harness-shape (seed+logprobs+1600)', VERIFY, { maxTokens: 1600, seed: 1234567, logprobs: true }],
    ['harness-no-logprobs', VERIFY, { maxTokens: 1600, seed: 1234567 }],
    ['long-draft-verify (harness shape)', VERIFY_LONG, { maxTokens: 1600, seed: 1234567, logprobs: true }],
  ] as const) {
    try {
      const res = await or.complete({ model, messages: messages as never, params: params as never });
      console.log(`${model} ${label}: OK (${res.text.trim().slice(0, 40).replace(/\n/g, ' ')}…)`);
    } catch (e) {
      const err = e as Error & { cause?: unknown; status?: number; body?: unknown };
      console.log(`${model} ${label}: FAIL — ${err.message}`);
      if (err.status !== undefined) console.log(`   status: ${err.status}`);
      if (err.body !== undefined) console.log(`   body: ${JSON.stringify(err.body).slice(0, 400)}`);
      if (err.cause !== undefined) console.log(`   cause: ${JSON.stringify(err.cause).slice(0, 400)}`);
    }
  }
}

// Real-item repro: draft cgh-c01 with one model, verify with the other —
// the exact failing cell, reconstructed.
const { readFileSync: rf } = await import('node:fs');
const items = rf(`${REPO}/packages/harness/suites/v2/code-gen-hard-v1/items.jsonl`, 'utf8')
  .split('\n').filter(Boolean).map((l) => JSON.parse(l) as { id: string; prompt: Array<{ role: string; content: string }> });
items.sort((a, b) => a.id.localeCompare(b.id));
const item = items[0]!;
console.log(`\nreal-item repro on ${item.id}`);
for (const [draftModel, verifierModel] of [['or-solar-pro4', 'or-gemini-flash'], ['or-gemini-flash', 'or-solar-pro4']] as const) {
  try {
    const draft = await or.complete({ model: draftModel, messages: item.prompt as never, params: { maxTokens: 1600, seed: 42, logprobs: true } });
    console.log(`  draft ${draftModel}: OK (${draft.text.length} chars)`);
    const verifyMsgs = [
      ...item.prompt,
      { role: 'assistant', content: draft.text },
      { role: 'user', content: 'Verify the draft answer above for correctness and completeness. If anything is wrong or missing, correct it. Return only the final corrected answer.' },
    ];
    const v = await or.complete({ model: verifierModel, messages: verifyMsgs as never, params: { maxTokens: 1600, seed: 43, logprobs: true } });
    console.log(`  verify ${verifierModel}: OK (${v.text.length} chars)`);
  } catch (e) {
    const err = e as Error & { status?: number; body?: unknown };
    console.log(`  FAIL dv(${draftModel} → ${verifierModel}): ${err.message}`);
    if (err.status !== undefined) console.log(`    status ${err.status}`);
    if (err.body !== undefined) console.log(`    body ${JSON.stringify(err.body).slice(0, 500)}`);
  }
}

// Seed-range hypothesis: cgh-c01's derived FNV seed is 3333495493 (> 2^31).
console.log('\nseed-range probe (seed 3333495493 vs 42)');
for (const model of ['or-gemini-flash', 'or-solar-pro4', 'or-gpt-full']) {
  for (const seed of [3333495493, 42]) {
    try {
      const r = await or.complete({ model, messages: PLAIN as never, params: { maxTokens: 60, seed, logprobs: true } });
      console.log(`  ${model} seed=${seed}: OK (${r.text.trim().slice(0, 24).replace(/\n/g, ' ')}…)`);
    } catch (e) {
      console.log(`  ${model} seed=${seed}: FAIL — ${(e as Error).message}`);
    }
  }
}
