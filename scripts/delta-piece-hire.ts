// F8 — hire Delta's DAILY PIECE writer: the generation that turns an
// agenda assignment into the day's published research.
//
//   POTION_LAB_URL=https://api.withpotion.com \
//   POTION_LAB_SESSION=ps_... npx tsx scripts/delta-piece-hire.ts
//
// The assignment carries a headline, the question it answers, and the
// measured evidence — and NOTHING else. THE PIECE NUMBER LAW refuses any
// figure the prose states that is not in that evidence, so the mission
// says it plainly: use these numbers, reach no further.

const URL_ = process.env.POTION_LAB_URL ?? 'https://api.withpotion.com';
const SESSION = process.env.POTION_LAB_SESSION;
if (!SESSION) throw new Error('set POTION_LAB_SESSION (a member session in the research org)');

const answers = {
  goal: [
    "Write today's Potion Research piece from assignment.json, the file attached to this run.",
    'assignment.json carries the headline claim, the question a reader is asking, the kind of work it concerns, and the measured evidence behind it. Those numbers are the ONLY numbers you may state.',
    'Read it, then write piece.json in your working directory: one strict JSON object with exactly these keys — title (the finding as a plain sentence under 110 characters, magnitude first, ending with a full stop), summary (one paragraph under 280 characters that states what was measured), plain (3 to 5 short sentences a smart reader who has never read a machine-learning paper fully understands: what was compared, what the gap is, why it matters), lede (3 sentences carrying the key numbers with their sample size), frontierNote (2 to 3 sentences on what the measurement does and does not establish), auditionNote (an empty string), mixingNote (an empty string), takeaway (2 or 3 sentences: what an engineer paying per request should do differently, and when this would not apply), faq (an empty array).',
    'Close by stating the headline in your final message.',
  ].join(' '),
  kind: 'task' as const,
  doneDefinition:
    'piece.json is in the run files as one strict JSON object with those keys, every number in it taken from assignment.json, and the final message states the headline.',
  accounts: ['code'],
  worthUsd: 2,
  clusterChoice: 'agentic-tool-use',
  constraints: [
    'USE THE EVIDENCE, REACH NO FURTHER: every figure you write must come from assignment.json. Never introduce a number of your own, never compute a new ratio or percentage, and never estimate. A number the assignment does not contain is a fabrication.',
    'State the limits honestly: the result comes from one measured suite for one kind of work, it is not a verdict for every workload, and quality below the measured threshold may behave differently. Say so in plain words rather than hedging everything.',
    'Never name a model the assignment does not name, and never speculate about why a model behaves as it does — the measurement shows what, not why.',
    'House style: short declarative sentences around the finding, longer ones for qualification; numbers rather than adjectives; explain each technical term in plain words on first use; no em dashes, no headings, no bullet lists, no marketing language, and no superlatives the numbers do not support.',
  ],
  qualityBar:
    'a reader finishes it knowing exactly what was measured, what it cost, and what they should do about it; every number traceable to the assignment; the limits stated without weaseling',
  produces: 'piece.json — the day’s research piece as one strict JSON object in the run files',
  exampleResult:
    'piece.json present in the run files; final message like: "Wrote today\'s piece. Headline: the last 2.1 points of code generation quality cost 296 times more per request."',
  whenUnsure: 'press-on' as const,
};

const res = await fetch(`${URL_.replace(/\/$/, '')}/api/lab/harnesses`, {
  method: 'POST',
  headers: { cookie: `potion_session=${SESSION}`, 'content-type': 'application/json' },
  body: JSON.stringify({ answers }),
});
const body = (await res.json()) as { kind?: string; harnessHash?: string; name?: string; gaps?: unknown };
if (res.status === 201 && body.kind === 'complete') {
  console.log(`hired: ${body.name}`);
  console.log(`DELTA_DAILY_HARNESS=${body.harnessHash}`);
} else {
  console.error(`HTTP ${res.status}: ${JSON.stringify(body)}`);
  process.exitCode = 1;
}
