#!/usr/bin/env node
// potion-check — send one prompt through Potion, print the answer and the receipt.
//
// Usage:  POTION_API_KEY=... potion-check "your prompt"
//         echo "your prompt" | POTION_API_KEY=... potion-check
//
// Exit codes: 0 receipt present · 1 usage/request error · 2 no x-frontier-trace header.
// Runs on Node >= 23.6 (native TypeScript type stripping); no build step.

import OpenAI from 'openai';

const BASE_URL = process.env.POTION_BASE_URL ?? 'https://api.withpotion.com/v1';
const HEADER = 'x-frontier-trace';
const FIELDS = ['cluster', 'strategy', 'frontier', 'policy', 'fallback', 'provenance'] as const;

async function readPrompt(): Promise<string> {
  const fromArgs = process.argv.slice(2).join(' ').trim();
  if (fromArgs) return fromArgs;
  if (process.stdin.isTTY) return '';
  let buf = '';
  for await (const chunk of process.stdin) buf += chunk;
  return buf.trim();
}

/** Parse `k=v;k=v` into a map. Unknown keys are kept so nothing on the wire is hidden. */
function parseTrace(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return out;
}

function printTable(trace: Record<string, string>): void {
  const keys = [...FIELDS, ...Object.keys(trace).filter((k) => !(FIELDS as readonly string[]).includes(k))];
  const width = Math.max(...keys.map((k) => k.length));
  console.log('receipt (x-frontier-trace):');
  for (const k of keys) console.log(`  ${k.padEnd(width)}  ${trace[k] ?? '(absent)'}`);
}

async function main(): Promise<number> {
  if (!process.env.POTION_API_KEY) {
    console.error('potion-check: POTION_API_KEY is not set');
    return 1;
  }
  const prompt = await readPrompt();
  if (!prompt) {
    console.error('usage: potion-check "<prompt>"   (or pipe the prompt on stdin)');
    return 1;
  }

  const ai = new OpenAI({ baseURL: BASE_URL, apiKey: process.env.POTION_API_KEY });
  const { data, response } = await ai.chat.completions
    .create({ model: 'potion-auto', messages: [{ role: 'user', content: prompt }] })
    .withResponse();

  const answer = data.choices[0]?.message?.content ?? '';
  console.log(`answer: ${answer.trim()}`);
  console.log();

  const raw = response.headers.get(HEADER);
  if (!raw) {
    console.error(`potion-check: response has no ${HEADER} header — this request did not go through Potion`);
    return 2;
  }
  printTable(parseTrace(raw));
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`potion-check: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  },
);
