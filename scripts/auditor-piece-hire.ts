// Hire Auditor's DAILY PIECE verifier — the second worker on the daily lane.
//
//   POTION_LAB_URL=https://api.withpotion.com \
//   POTION_LAB_SESSION=ps_... npx tsx scripts/auditor-piece-hire.ts
//
// WHY A SECOND VERIFIER. The deterministic laws on the daily path catch what
// counting can catch: a figure outside the evidence, our own spend, a
// paragraph restating another. They cannot catch a SEMANTIC inversion, and
// one shipped — run-564edfaf said the cheaper model "carries most of the
// score" in one paragraph and "leaves most of the measured quality on the
// table" in the next. Both sentences are well formed, every figure is legal,
// and they mean opposite things. That is this worker's job.

const URL_ = process.env.POTION_LAB_URL ?? 'https://api.withpotion.com';
const SESSION = process.env.POTION_LAB_SESSION;
if (!SESSION) throw new Error('set POTION_LAB_SESSION (a member session in the research org)');

const answers = {
  goal: [
    "Verify today's Potion Research piece against its assignment. Two files are attached: assignment.json, which carries the headline claim and the measured evidence and is the ONLY source of truth, and piece.json, the published prose written by another worker.",
    'Read both in your sandbox. Recompute every figure the prose states against the evidence in assignment.json: each quality score, each price per thousand requests, the ratio between the prices, the quality gap, and the number of scored items. A figure that is not in the evidence, or that does not match it once rounded, is a defect.',
    'Then verify what arithmetic cannot. The piece publishes as three paragraphs — plain (the finding), lede (what it means), takeaway (what to do) — and they must agree with each other and with the evidence. Check DIRECTION on every comparison: which model is cheaper, which scores higher, which way the gap runs, and whether a phrase like "leaves quality on the table" or "carries most of the score" points the same way as the numbers. A sentence that reverses the finding is the defect this worker exists to catch.',
    'Check also that the recommendation follows from the evidence rather than contradicting it, that no paragraph asserts a cause the measurement does not establish, that a stated limit in one paragraph is not contradicted in another, and that the title and summary agree with the body.',
    'Then write verdict.json in your working directory: one strict JSON object with exactly these keys —',
    "verdict ('pass' or 'fail'),",
    "checks (an array where every material claim appears as {claim: string, method: 'recomputed' | 'accepted-on-evidence' | 'not-recomputable', ok: boolean, note: string}),",
    'requiredChanges (each defect in plain words; empty when the verdict is pass).',
    'The verdict is fail if any check that matters to a reader has ok=false.',
    "Close by stating the verdict, the count of checks, and the exact words 'verdict.json is in the run files' in your final message.",
  ].join(' '),
  kind: 'task' as const,
  doneDefinition:
    'verdict.json is in the run files as one strict JSON object with keys verdict, checks and requiredChanges, every figure the piece states covered by a check, and the final message states the verdict.',
  accounts: ['code'],
  worthUsd: 2,
  clusterChoice: 'agentic-tool-use',
  constraints: [
    'You are the independent verifier: never rewrite the piece, never soften a defect, and treat a plausible-but-unsupported claim as a failure. A fail verdict on a defective piece is a SUCCESSFUL run.',
    'The assignment is the only truth. A claim absent from assignment.json and not derivable from it is a defect even when it sounds right, and your own knowledge of these models is not evidence.',
    'DIRECTION IS THE POINT. Two sentences can each match the numbers and still contradict each other. Read the three paragraphs together and ask whether they tell one consistent story; if any two disagree about which model is better or cheaper, or about which way a gap runs, that is a fail.',
    "Recompute wherever the sandbox allows (method 'recomputed'); mark textual comparisons 'accepted-on-evidence'; mark what the evidence cannot decide 'not-recomputable'. Never guess and never fill a gap.",
    'Write verdict.json BEFORE composing your final message — a run that ends without verdict.json in the run files is a failed run, whatever the final message says.',
  ],
  qualityBar:
    'every figure covered by a check naming the matching evidence field; the three paragraphs read together for contradictions, not just line by line; no defect softened; pass only when a careful reader would find zero factual faults and zero reversals',
  produces: 'verdict.json — the typed verification record for the day’s piece',
  exampleResult:
    'verdict.json present in the run files; final message like: "Verdict: fail. 11 checks. The takeaway reverses the finding: it says the cheaper model leaves most of the quality on the table, while the evidence shows it retains all but 8.7 points. verdict.json is in the run files."',
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
  console.log(`POTION_RESEARCH_AUDITOR_DAILY_HARNESS=${body.harnessHash}`);
} else {
  console.error(`HTTP ${res.status}: ${JSON.stringify(body)}`);
  process.exitCode = 1;
}
