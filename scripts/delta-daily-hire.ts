// F6 — hire Delta's DAILY generation: the ledger's framing writer.
//
//   POTION_LAB_URL=https://api.withpotion.com \
//   POTION_LAB_SESSION=ps_... npx tsx scripts/delta-daily-hire.ts
//
// This is a SEPARATE generation from the weekly author on purpose. Handing
// the weekly worker a daily ledger produced exactly the failure the fleet
// exists to prevent: briefed on fact sheets, given something else, it
// parked and asked a human — and a daily lane that waits on a human stops
// publishing (found live 2026-09-04, run-c7507c2c).
//
// Its job is framing ONLY. Every number in the daily comes from the
// code-composed ledger; THE NUMBER LAW refuses any figure this worker
// invents, so its mission tells it plainly: restate, never compute.

const URL_ = process.env.POTION_LAB_URL ?? 'https://api.withpotion.com';
const SESSION = process.env.POTION_LAB_SESSION;
if (!SESSION) throw new Error('set POTION_LAB_SESSION (a member session in the research org)');

const answers = {
  goal: [
    "Write the plain-words framing for today's Frontier Notes daily ledger, from ledger.json — the file attached to this run.",
    'ledger.json is the day: how many measurement cycles ran, which newly listed models were measured, how many recipes reached a frontier, the registry size, the prices version, and the dollars spent. It is already true and already written; your job is to make a reader understand it.',
    'Read it, then write daily.json in your working directory: one strict JSON object with exactly these keys — title (a plain finding under 110 characters, ending with a full stop), summary (one paragraph under 280 characters), plain (3 to 5 short sentences a reader who has never read a machine-learning paper fully understands), lede (2 to 4 sentences carrying the day’s numbers), frontierNote (1 to 2 sentences on what held or changed), auditionNote (1 to 2 sentences on models measured today, or that none were), mixingNote (an empty string), takeaway (2 or 3 sentences on what today means for someone paying for AI by the request), faq (an empty array).',
    'Close by stating the headline in your final message.',
  ].join(' '),
  kind: 'task' as const,
  doneDefinition:
    'daily.json is in the run files as one strict JSON object with those keys, every number in it copied from ledger.json, and the final message states the headline.',
  accounts: ['code'],
  worthUsd: 1,
  clusterChoice: 'agentic-tool-use',
  constraints: [
    'RESTATE, NEVER COMPUTE: every figure you write must appear in ledger.json exactly as it appears there. Never add a number of your own, never total or average anything yourself, and never write a percentage or an "×" ratio — the daily reports counts and dollars only.',
    'A quiet day is the normal case and a real result. When nothing was measured, say so plainly and calmly: the instruments looked and found nothing worth measuring. Never inflate a quiet day, and never imply a finding the ledger does not contain.',
    'Never ask a question: everything you need is in ledger.json. If something seems missing, write the framing from what is there and say what is absent.',
    'House style: short sentences, concrete nouns, one idea per sentence; explain each technical term in plain words on first use; no em dashes, no headings, no bullet lists, no marketing, no superlatives.',
  ],
  qualityBar:
    'every number traceable to ledger.json; a smart reader who knows nothing about AI models understands every sentence; a quiet day reads as a calm true result rather than filler',
  produces: 'daily.json — the day’s framing as one strict JSON object in the run files',
  exampleResult:
    'daily.json present in the run files; final message like: "Framed today\'s ledger. Headline: one cycle measured, no frontier changed."',
  whenUnsure: 'press-on' as const,
};

const res = await fetch(`${URL_.replace(/\/$/, '')}/api/lab/harnesses`, {
  method: 'POST',
  headers: { cookie: `potion_session=${SESSION}`, 'content-type': 'application/json' },
  body: JSON.stringify({ answers }),
});
const body = (await res.json()) as { kind?: string; harnessHash?: string; name?: string; clusterId?: string; gaps?: unknown; reason?: string; detail?: string };
if (res.status === 201 && body.kind === 'complete') {
  console.log(`hired: ${body.name}`);
  console.log(`DELTA_DAILY_HARNESS=${body.harnessHash}`);
} else if (body.kind === 'draft') {
  console.error(`generator returned gaps: ${JSON.stringify(body.gaps)}`);
  process.exitCode = 2;
} else {
  console.error(`HTTP ${res.status}: ${JSON.stringify(body)}`);
  process.exitCode = 1;
}
