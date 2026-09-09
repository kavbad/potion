// LIVE proof that `vote` and `agree` now compare the ANSWER, not the prose.
//
// Before the fix, three models reasoning step by step never produced identical
// text, so every vote bucket held one ballot and the winner was always the
// first branch — paid for three times. This runs the real program interpreter
// against live providers on real GSM8K questions and reports how often a
// majority actually forms, plus what the vote scores against each branch alone.
//
//   KEY_RISK_ACCEPTED=<date> GSM8K_TEST_JSONL=/path/to/gsm8k/test.jsonl \
//     npx tsx scripts/vote-live-check.ts [nItems]
//
// GSM8K's test split is not vendored here; point GSM8K_TEST_JSONL at the
// upstream file (openai/grade-school-math, grade_school_math/data/test.jsonl).
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
for (const k of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GOOGLE_API_KEY']) delete process.env[k];
if (!process.env.KEY_RISK_ACCEPTED) throw new Error('live spend: set KEY_RISK_ACCEPTED=<date>');

const N = Number(process.argv[2] ?? 24);
const { loadPrices, createProviders } = await import('@potion/providers');
const { createResolver } = await import('@potion/strategies');
const { execute } = await import('@potion/strategies');
const { consensusKey } = await import('@potion/core');

const prices = loadPrices(`${REPO}/prices.json`).table;
const providers = createProviders({ prices, apiKeys: { openrouter: process.env.OPENROUTER_API_KEY! } });
const ctx = { providers, prices, resolve: createResolver(providers, prices), seed: 1, captureConfidence: true } as never;

const BRANCHES = ['or-solar-pro4', 'or-ling-3.0-flash', 'or-deepseek-v4-flash-0731'];
const SYSTEM = 'You are a careful math solver. Solve the problem step by step, then on the last line write exactly: Final answer: <number>  (digits only, no units, no commas).';
const DATA = process.env.GSM8K_TEST_JSONL!;
const rows = readFileSync(DATA, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as { question: string; answer: string });
const gold = (a: string): number => Number(a.split('####').pop()!.trim().replace(/,/g, ''));
const picked = rows.slice(0, N);

const vote = { type: 'program' as const, name: 'vote-3-cheap', body: { op: 'vote' as const, of: BRANCHES.map((m) => ({ op: 'call' as const, model: m })) } };
const landed = (t: string): number | null => {
  const m = [...t.matchAll(/final\s+answer\s*[:=]?\s*(-?[\d,]+(?:\.\d+)?)/gi)];
  return m.length ? Number(m[m.length - 1]![1]!.replace(/,/g, '')) : null;
};

let majorities = 0, oldMajorities = 0, voteRight = 0, cost = 0, outvoted = 0, outvotedByPair = 0;
const topBucket = (keys: string[]): number => {
  const c = new Map<string, number>();
  for (const k of keys) c.set(k, (c.get(k) ?? 0) + 1);
  return Math.max(...c.values());
};
const branchRight: Record<string, number> = Object.fromEntries(BRANCHES.map((b) => [b, 0]));
console.log(`live vote check: ${picked.length} GSM8K questions x ${BRANCHES.length} branches\n`);
for (const [i, it] of picked.entries()) {
  const messages = [{ role: 'system' as const, content: SYSTEM }, { role: 'user' as const, content: it.question }];
  const r = await execute(vote, messages, ctx);
  cost += r.usage.costUsd;
  // r.trace carries one StageTrace per branch call
  const top = topBucket(r.trace.map((t) => consensusKey(t.text)));
  // The OLD rule, on these very same replies: whole normalized text.
  const oldTop = topBucket(r.trace.map((t) => t.text.trim().toLowerCase().replace(/\s+/g, ' ').replace(/[.!?,;:]+$/g, '')));
  if (top >= 2) majorities += 1;
  if (oldTop >= 2) oldMajorities += 1;
  const g = gold(it.answer);
  if (landed(r.text) === g) voteRight += 1;
  for (const t of r.trace) if (landed(t.text) === g) branchRight[t.model] = (branchRight[t.model] ?? 0) + 1;
  // WHY a vote loses to its best member: the two weaker voters agree on a
  // wrong answer and outvote the one that had it right.
  const best = r.trace.find((t) => t.model === BRANCHES[0]);
  if (landed(r.text) !== g && best !== undefined && landed(best.text) === g) {
    outvoted += 1;
    const others = r.trace.filter((t) => t.model !== BRANCHES[0]).map((t) => landed(t.text));
    if (others.length === 2 && others[0] === others[1]) outvotedByPair += 1;
  }
  process.stdout.write(`${i + 1}/${picked.length}\r`);
}
console.log('\n');
console.log(`majority formed, ANSWER-keyed (now)   : ${majorities}/${picked.length}`);
console.log(`majority formed, TEXT-keyed  (before) : ${oldMajorities}/${picked.length}`);
console.log(`vote correct       : ${voteRight}/${picked.length} (${((voteRight / picked.length) * 100).toFixed(1)}%)`);
for (const b of BRANCHES) console.log(`  branch ${b.padEnd(28)} ${branchRight[b]}/${picked.length}`);
console.log(`\nbest branch (${BRANCHES[0]}) was right but the vote was wrong: ${outvoted}`);
console.log(`  of those, the two weaker voters agreed on the same wrong answer: ${outvotedByPair}`);
console.log(`\nspend $${cost.toFixed(5)}`);
