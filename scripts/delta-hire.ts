// F0 (docs/RESEARCH-FLEET.md R5) — hire Delta, the Frontier Notes writer,
// through the SAME interview route a customer uses (fleet R1: built ON
// Workers, never beside them). Prints the harness hash to wire into the
// weekly script as DELTA_HARNESS.
//
//   POTION_LAB_URL=https://api.withpotion.com \
//   POTION_LAB_SESSION=ps_... npx tsx scripts/delta-hire.ts
//
// Re-running is safe: an identical spec hashes identically and upserts.
// The goal carries NO input slots — the fact sheet arrives as a run
// attachment, announced by the runtime, so the slot law never parks a
// weekly run that has everything it needs.
//
// E1 note (docs/RESEARCH-WRITING.md): the exampleResult is structural on
// purpose — no numbers — so the style exemplar can never leak a figure
// into a published draft.

const URL_ = process.env.POTION_LAB_URL ?? 'https://api.withpotion.com';
const SESSION = process.env.POTION_LAB_SESSION;
if (!SESSION) throw new Error('set POTION_LAB_SESSION (a member session in the research org)');

const answers = {
  goal: [
    "Write this week's Frontier Notes issue from facts.json, the fact sheet attached to this run.",
    'The fact sheet is the ONLY source of facts: every number, name and verdict in the draft comes from it and nowhere else. Read it first.',
    'Then write the draft to a file named draft.json in your working directory: one strict JSON object with exactly these keys —',
    'title (a finding in plain words, under 110 characters, ends with a full stop),',
    'summary (one paragraph under 280 characters),',
    'plain (3 to 5 short sentences a non-technical reader fully understands: what was checked, what was found, why it matters),',
    'lede (3 sentences with the key numbers, each technical term explained in plain words in the same sentence),',
    'frontierNote (2 to 4 sentences about the weekly re-checks),',
    'auditionNote (1 to 3 sentences about newly released models tested),',
    'mixingNote (2 to 3 sentences on the combination findings),',
    'takeaway (2 or 3 sentences on what this means for someone paying for AI by the request),',
    'faq (exactly 3 question/answer objects, questions a buyer would type into a search engine, answered from this week\'s numbers).',
    'Work in this order: FIRST read numbers.clustersHeld, numbers.clustersMoved and the frontier table and write the body sections from them; write the title LAST, deriving its counts from numbers.clustersHeld and numbers.clustersMoved exactly.',
    'Close by stating the headline finding in your final message.',
  ].join(' '),
  kind: 'task' as const,
  doneDefinition:
    'draft.json is in the run files as one strict JSON object with all nine keys, every number in it traceable to facts.json, and the final message states the headline finding.',
  accounts: ['code'],
  worthUsd: 3,
  clusterChoice: 'agentic-tool-use',
  constraints: [
    "Never name a model the fact sheet calls 'name withheld', and never guess or describe which model it might be.",
    "Never describe how models are combined: no mechanism names, no component names, no thresholds, no order of calls — say 'a combination of measured models'. Where a mixing fact has vague=true, name only the family ('code work') and use the costBand words, never an exact ratio and never a specific kind of work.",
    "Use every number exactly as the fact sheet gives it, and give the margin of error with every quality figure, written like '0.979, give or take 0.020'.",
    'House style: short sentences, concrete nouns, one idea per sentence; explain each technical term in plain words on first use; no em dashes, no headings, no bullet lists, no superlatives the numbers do not support, no marketing. A quiet week is reported calmly as a quiet week — the absence of change is itself a finding.',
    "Count claims are sacred: the title and every sentence state held/moved counts exactly as numbers.clustersHeld and numbers.clustersMoved give them. Never write 'every', 'all' or 'none' about clusters, frontiers or routes unless the corresponding count is the full roster or exactly zero.",
    "Verdict semantics: 'ok' means the routed pick reproduced its stored quality inside the 95% interval (say it held); 'drift' means the observed canary mean fell OUTSIDE the stored interval — the routed pick did NOT change and nothing was rerouted, so never say a cluster 'moved to a different model'; 'inconclusive' means the canary could not decide.",
    'A held cluster’s observed mean may sit slightly below its stored quality and still hold — inside the interval is held, so never claim that held clusters scored at or above their stored quality.',
  ],
  qualityBar:
    'every number in the draft traceable to facts.json with its margin attached; a smart reader who has never read a machine-learning paper understands every sentence',
  produces: 'draft.json — the complete issue draft as one strict JSON object in the run files',
  exampleResult:
    "draft.json present in the run files; final message like: \"Drafted this week's Frontier Notes. Headline: every frontier held; one new model was measured and did not earn a route. Every number carries its margin, straight from the fact sheet.\"",
  whenUnsure: 'ask-first' as const,
};

const res = await fetch(`${URL_.replace(/\/$/, '')}/api/lab/harnesses`, {
  method: 'POST',
  headers: { cookie: `potion_session=${SESSION}`, 'content-type': 'application/json' },
  body: JSON.stringify({ answers }),
});
const body = (await res.json()) as { kind?: string; harnessHash?: string; name?: string; clusterId?: string; gaps?: unknown; reason?: string; detail?: string; error?: string; message?: string };
if (res.status === 201 && body.kind === 'complete') {
  console.log(`hired: ${body.name}`);
  console.log(`DELTA_HARNESS=${body.harnessHash}`);
  console.log(`cluster: ${body.clusterId}`);
} else if (body.kind === 'draft') {
  console.error('generator returned a draft with gaps (answer them and re-run):');
  console.error(JSON.stringify(body.gaps, null, 1));
  process.exitCode = 2;
} else if (body.kind === 'refused') {
  console.error(`refused: ${body.reason}${body.detail ? ` — ${body.detail}` : ''}`);
  process.exitCode = 2;
} else {
  console.error(`HTTP ${res.status}: ${JSON.stringify(body)}`);
  process.exitCode = 1;
}
