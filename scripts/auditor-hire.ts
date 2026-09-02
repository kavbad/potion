// F1 (docs/RESEARCH-FLEET.md R2/R5) — hire Auditor, the independent
// research verifier, through the SAME interview route a customer uses.
// Prints the harness hash to wire into the weekly script as
// AUDITOR_HARNESS.
//
//   POTION_LAB_URL=https://api.withpotion.com \
//   POTION_LAB_SESSION=ps_... npx tsx scripts/auditor-hire.ts
//
// Auditor is deliberately a SEPARATE mind from Delta (evaluation
// independence — researchers never verify their own conclusions). Its
// objective rewards finding defects: a fail verdict on a defective draft
// is a successful run.

const URL_ = process.env.POTION_LAB_URL ?? 'https://api.withpotion.com';
const SESSION = process.env.POTION_LAB_SESSION;
if (!SESSION) throw new Error('set POTION_LAB_SESSION (a member session in the research org)');

const answers = {
  goal: [
    "Verify this week's Frontier Notes draft against its fact sheet. Two files are attached: facts.json, the fact sheet — the ONLY source of truth — and draft.json, the draft under verification, written by another worker.",
    'Read both in your sandbox and recompute every checkable claim in the draft against facts.json: counts of clusters held, drifted and inconclusive; every quality figure with its margin; every observed mean; audition names, lanes and outcomes; mixing quality, cost bands and item counts; the weekly totals (canaries, items graded, listings screened, candidates measured, spend).',
    'Also verify semantics, not just digits: drift detection is ONE-SIDED (collapse only) — a drift verdict means the observed canary mean fell BELOW the stored interval; a cluster scoring above its interval still holds, so a draft defining held as "inside the interval" fails when any held cluster sits above. The routed pick does NOT change on drift — a draft claiming a reroute, a model swap or a move to a different model fails; a drift flag leads to a full re-measurement that may reconfirm the same pick, so a claim that a new pick is needed, required or being sought also fails; universal words (every, all, none) must match exact counts; causal explanations the fact sheet does not contain fail.',
    'Then write verdict.json in your working directory: one strict JSON object with exactly these keys —',
    "verdict ('pass' or 'fail'),",
    "checks (an array where every material claim in the draft appears as {claim: string, method: 'recomputed' | 'accepted-on-evidence' | 'not-recomputable', ok: boolean, note: string}),",
    'requiredChanges (each defect in plain words; empty when the verdict is pass).',
    'The verdict is fail if any check that matters to a reader has ok=false.',
    "Close by stating the verdict, the count of checks, and the exact words 'verdict.json is in the run files' in your final message.",
  ].join(' '),
  kind: 'task' as const,
  doneDefinition:
    'verdict.json is in the run files as one strict JSON object with keys verdict, checks and requiredChanges, every numeric claim in the draft covered by a check, and the final message states the verdict.',
  accounts: ['code'],
  worthUsd: 3,
  clusterChoice: 'agentic-tool-use',
  constraints: [
    'You are the independent verifier: never rewrite the draft, never soften a defect, and treat a plausible-but-unsupported claim as a failure. A fail verdict on a defective draft is a successful run.',
    "Recompute wherever the sandbox allows (method 'recomputed'); mark claims you can only compare textually as 'accepted-on-evidence'; mark claims the fact sheet cannot decide as 'not-recomputable' — never guess and never fill a gap with your own knowledge.",
    'The fact sheet is the only truth: a draft claim that is absent from facts.json and not derivable from it is a defect, even when plausible.',
    'Check the draft against itself too: a title, summary or FAQ that contradicts the body is a defect even when each half alone matches a fact.',
    'Write verdict.json BEFORE composing your final message — a run that ends without verdict.json in the run files is a failed run, whatever the final message says.',
  ],
  qualityBar:
    'every numeric claim in the draft covered by a check naming the matching fact; no defect softened; pass only when a careful reader would find zero factual faults',
  produces: 'verdict.json — the typed verification record',
  exampleResult:
    'verdict.json present in the run files; final message like: "FAIL — 34 checks: 31 recomputed ok, 2 failed (the held count in the title; an interval transposed between two clusters), 1 not-recomputable. Required changes listed."',
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
  console.log(`AUDITOR_HARNESS=${body.harnessHash}`);
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
