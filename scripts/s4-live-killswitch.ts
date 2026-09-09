// S4 LIVE LEG — prove the kill actually kills, on real pricing.
//
// WHY THIS NEEDS REAL MONEY AT ALL. Everything else about S4 is provable at
// $0 and IS proven at $0 (apps/server/test/spending-safety.test.ts, 21
// tests). The one thing a mock cannot establish is that the numbers the cap
// compares are REAL: mock spend is modelled, so a cap that trips on modelled
// cost proves the arithmetic, not the protection. This leg spends actual
// dollars through actual providers and watches the actual stop fire.
//
// WHY IT IS SAFE TO RUN. The thing under test is the spending limit, so the
// experiment is bounded by its own subject — but that is circular reasoning
// if the limit is broken, which is precisely what we are checking. So there
// are THREE independent bounds, and any one of them alone caps the damage:
//
//   1. POTION_PLATFORM_DAILY_CAP_USD — the mechanism under test.
//   2. POTION_PLATFORM_ORG_CAP_USD   — a second, differently-implemented
//      cap (per-org MTD, not per-day platform) that trips on the same spend.
//   3. HARD_REQUEST_CEILING below    — a plain loop counter in this script,
//      owned by neither mechanism. If both caps are broken, this still stops,
//      and it stops after a knowable maximum number of small completions.
//
// Plus `max_tokens: 32` on every request, so a single completion's cost is
// bounded regardless of what the model wants to say.
//
// Usage (the key is read from .env, never printed):
//   KEY_RISK_ACCEPTED=<YYYY-MM-DD> pnpm exec tsx scripts/s4-live-killswitch.ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
// @potion/server, not ../apps/server/src — the sibling scripts in this
// directory import the PACKAGE, and a program holding both pulls the server's
// `declare module 'fastify'` augmentation in TWICE with two different
// PotionContext types: one from src, one from dist. That was harmless while
// every member of PotionContext was structural, and became a hard error the
// moment one of them (assignCache) was a class with a private field, since a
// private member is nominal and src's copy is not dist's. Caught by CI's
// typecheck:scripts on its first ever run.
import { buildServer } from '@potion/server/server';

const REPO = fileURLToPath(new URL('.', import.meta.url));

/** Bound 3: this script's own ceiling, independent of anything it tests. */
const HARD_REQUEST_CEILING = 25;

/**
 * Bound 1 + 2: both caps, in dollars.
 *
 * CALIBRATED FROM A MEASUREMENT, not guessed. The first attempt used $0.02
 * and proved nothing: 25 live requests at `max_tokens: 32` on the cheapest
 * frontier point cost $0.000929 in total — about $0.000037 each — so the
 * script's own ceiling fired long before either cap did, and the run
 * correctly reported FAIL ("the kill switch did NOT kill") because it had NOT
 * been shown to kill.
 *
 * That was an experiment-design failure, not a product failure, and the
 * distinction matters: a cap set above what the experiment can spend is
 * untestable, and an untestable cap reported as passing is exactly the kind
 * of decorative proof this repo keeps deleting. $0.0002 sits ~5 requests in
 * at the measured rate, so the trip happens inside the ceiling with room to
 * spare — and the numbers being compared are still REAL metered live costs,
 * which is the only thing the mock could not establish.
 */
const CAP_USD = 0.0002;
const MAX_TOKENS = 32;

function loadEnvFile(): void {
  let txt: string;
  try {
    txt = readFileSync(`${REPO}../.env`, 'utf8');
  } catch {
    throw new Error('no .env found — this leg needs OPENROUTER_API_KEY');
  }
  for (const line of txt.split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.trim().replace(/^["']|["']$/g, '');
  }
}

function requireRiskAccepted(): string {
  const accepted = process.env.KEY_RISK_ACCEPTED;
  if (!accepted || !/^\d{4}-\d{2}-\d{2}$/.test(accepted)) {
    throw new Error(
      'REFUSING to spend: set KEY_RISK_ACCEPTED=YYYY-MM-DD to acknowledge this leg bills a real provider key',
    );
  }
  return accepted;
}

const accepted = requireRiskAccepted();
loadEnvFile();

// Only OpenRouter — one provider, one bill to reconcile against.
for (const k of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GOOGLE_API_KEY']) delete process.env[k];
if (!process.env.OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY absent from .env');

process.env.POTION_SELF_SERVE = '1';
process.env.POTION_MAGIC_LINK_IN_RESPONSE = '1';
process.env.POTION_DEV_AUTH = '0';
process.env.POTION_PLATFORM_DAILY_CAP_USD = String(CAP_USD);
process.env.POTION_PLATFORM_ORG_CAP_USD = String(CAP_USD);

console.log('── S4 live leg: does the kill switch actually kill? ──────────────');
console.log(`risk accepted   : ${accepted}`);
console.log(`provider        : openrouter only (others unset for this process)`);
console.log(`caps            : platform-daily $${CAP_USD} AND platform-org $${CAP_USD}`);
console.log(`script ceiling  : ${HARD_REQUEST_CEILING} requests, max_tokens=${MAX_TOKENS}`);

const app = await buildServer({ seed: false, platformBaseline: true, log: () => {} });
const mode = app.potion.providerMode;
console.log(`provider mode   : ${mode}`);
if (mode !== 'live') {
  await app.close();
  throw new Error(`REFUSING: provider mode is '${mode}', not 'live' — this leg would prove nothing`);
}

// A self-served org: no BYOK key, so Potion pays — the case S4 protects.
const signup = await app.inject({
  method: 'POST',
  url: '/auth/request-link',
  headers: { 'content-type': 'application/json' },
  payload: { email: 's4-live@killswitch.test' },
});
const token = new URL(signup.json().devLink as string).searchParams.get('token')!;
const verify = await app.inject({ method: 'GET', url: `/auth/verify?token=${encodeURIComponent(token)}` });
const cookie = String(verify.headers['set-cookie'] ?? '').split(';')[0]!;
const created = await app.inject({
  method: 'POST',
  url: '/api/policies',
  headers: { cookie, 'content-type': 'application/json' },
  payload: { policy: { type: 'min_cost', qualityFloor: 0.8 }, createKey: true },
});
const apiKey = created.json().apiKey as string;

const conn = (await app.inject({ method: 'GET', url: '/api/connection', headers: { cookie } })).json();
console.log(`org funding     : byok=${conn.serving.byok} (false ⇒ Potion pays ⇒ S4 applies)`);
console.log('');

let ok = 0;
let stopped: { at: number; body: string } | null = null;
let ceilingHit = false;

for (let i = 1; i <= HARD_REQUEST_CEILING; i++) {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    payload: {
      model: 'potion-auto',
      max_tokens: MAX_TOKENS,
      messages: [{ role: 'user', content: `Write a one-line Python function. Variant ${i}.` }],
    },
  });
  if (res.statusCode === 200) {
    ok += 1;
    // The 60s hard-stop cache would hide the trip inside this loop, so drop
    // it between requests: we are measuring the GATE, not the cache.
    const { clearBudgetHardStopCache } = await import('../apps/server/src/routes/budgets.js');
    clearBudgetHardStopCache();
    const trace = String(res.headers['x-frontier-trace']);
    console.log(`  #${String(i).padStart(2)} 200  ${trace}`);
    continue;
  }
  stopped = { at: i, body: String(res.body).slice(0, 400) };
  console.log(`  #${String(i).padStart(2)} ${res.statusCode}  STOPPED`);
  break;
}
if (!stopped) ceilingHit = true;

// What did it actually cost, from our own meter?
const activity = (
  await app.inject({ method: 'GET', url: '/api/routing-activity?limit=200', headers: { cookie } })
).json();
const spent = activity.requests
  .filter((r: { status: string }) => r.status === 'ok')
  .reduce((s: number, r: { costUsd: number | null }) => s + (r.costUsd ?? 0), 0);

console.log('');
console.log('── result ───────────────────────────────────────────────────────');
console.log(`served OK       : ${ok}`);
console.log(`stopped at req  : ${stopped ? stopped.at : 'NEVER (script ceiling hit)'}`);
console.log(`metered spend   : $${spent.toFixed(6)}`);
console.log(`LEDGER          : projected ≤ $${CAP_USD.toFixed(4)} + overshoot | actual $${spent.toFixed(6)}`);
if (stopped) {
  console.log('');
  console.log('refusal body:');
  console.log(stopped.body);
}

await app.close();

if (ceilingHit) {
  console.error('');
  console.error('FAIL: neither cap fired within the script ceiling — the kill switch did NOT kill.');
  process.exit(1);
}
console.log('');
console.log('PASS: the cap fired on live pricing and serving stopped.');
