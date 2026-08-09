// G2.8 CAPSTONE — one real workload through the whole loop (operator script).
//
//   MOCK dress rehearsal ($0 — the gate before any live leg):
//     PATH=... DATABASE_URL=pglite://<repo>/.pglite/g28-mock \
//       pnpm --filter @potion/workers exec tsx scripts/g28-capstone.ts \
//         --transcripts ~/.claude/projects/<project>/<session>/subagents
//
//   LIVE (each leg separately capped and separately ledgered):
//     set -a && source .env && set +a
//     PATH=... POTION_EVAL_PROVIDER=live POTION_RUBRIC_PROVIDER=live \
//       DATABASE_URL=pglite://<repo>/.pglite/g28-live \
//       pnpm --filter @potion/workers exec tsx scripts/g28-capstone.ts \
//         --transcripts <dir> --live --rubric-cap 2 --sweep-cap 8 --verify-cap 8
//
// The workload is real Claude Code session transcripts, converted to SPEC
// §14.1 spans by scripts/claude-code-to-traces.ts (which scrubs credentials
// before anything leaves the machine). Nothing here fabricates a tidy corpus:
// if the workload produces clusters too small to verify, that is the result.
//
// Every leg prints a `LEDGER` line with its own projected/actual, per the
// owner's rule that the capstone ledger doubles as a cost-anatomy exhibit for
// what a customer onboarding actually costs.
import { fileURLToPath } from 'node:url';
import { writeFileSync } from 'node:fs';
import {
  activeIncumbent,
  createDb,
  createOrg,
  designateIncumbent,
  evalResults,
  insertPolicy,
  insertTraceSpans,
  listDerivedSuites,
  loadDerivedSuite,
  migrate,
  upsertStrategyConfig,
  type NewTraceSpan,
  type PotionDb,
} from '@potion/db';
import { loadCurrentFrontier } from '@potion/pareto';
import { resolveEmbedder } from '@potion/cluster';
import { createMockProvider, createProviders, loadPrices } from '@potion/providers';
import { strategyHash } from '@potion/core';
import {
  frontierLiveSweepHandler,
  guaranteeSuiteVerifyHandler,
  orgHashOf,
  rubricGenerateHandler,
  toolSignatureSlug,
  tracesClusterHandler,
  type JobContext,
} from '../src/handlers.js';
import {
  convertFile,
  listTranscripts,
  findSecretsDeep,
  type TraceSpanPayload,
} from '../../../scripts/claude-code-to-traces.js';

const PRICES = fileURLToPath(new URL('../../../prices.json', import.meta.url));
const ORG = 'org_g28_capstone';

// A deterministic word-hash embedder: the live surface under test is
// answering + judging, not embeddings (the G1.7 precedent).
function wordHash(word: string): number {
  let h = 0;
  for (let i = 0; i < word.length; i++) h = (Math.imul(h, 31) + word.charCodeAt(i)) | 0;
  return Math.abs(h);
}
const toyEmbedder = {
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => {
      const v = new Array<number>(384).fill(0);
      for (const w of t.toLowerCase().split(/[^a-z0-9]+/)) if (w.length > 0) v[wordHash(w) % 384]! += 1;
      const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
      return v.map((x) => x / norm);
    });
  },
};

interface Args {
  transcripts: string;
  live: boolean;
  realEmbedder: boolean;
  /** Which legs to run this invocation (chunked-resume rule, G2.8). */
  only: Set<number>;
  rubricCap: number;
  sweepCap: number;
  verifyCap: number;
  out: string;
}

function parseArgs(argv: string[]): Args {
  const get = (f: string, d?: string): string | undefined => {
    const i = argv.indexOf(f);
    return i >= 0 ? argv[i + 1] : d;
  };
  const transcripts = get('--transcripts');
  if (transcripts === undefined) throw new Error('--transcripts <dir> is required');
  return {
    transcripts,
    live: argv.includes('--live'),
    realEmbedder: argv.includes('--real-embedder'),
    only: new Set(
      (get('--only') ?? '1,2,3,4,5,6').split(',').map((x) => Number(x.trim())).filter((n) => n >= 1 && n <= 6),
    ),
    rubricCap: Number(get('--rubric-cap', '2')),
    sweepCap: Number(get('--sweep-cap', '8')),
    verifyCap: Number(get('--verify-cap', '8')),
    out: get('--out', 'artifacts') ?? 'artifacts',
  };
}

/** One ledger line per leg — copied verbatim into tasks/todo.md. */
function ledger(leg: string, projected: number | null, actual: number, note = ''): void {
  const p = projected === null ? '—' : `$${projected.toFixed(4)}`;
  console.log(`LEDGER | ${leg} | projected ${p} | actual $${actual.toFixed(4)}${note ? ` | ${note}` : ''}`);
}

interface Findings {
  mode: 'mock' | 'live';
  sessions: number;
  spans: number;
  withReference: number;
  clusters: Array<{
    clusterId: string;
    sessions: number;
    toolSequence: string[];
    suiteId: string;
    suiteItems: number;
  }>;
  spend: Record<string, number>;
  rubric?: Record<string, unknown>;
  frontier?: Record<string, unknown>;
  verify?: Record<string, unknown>;
  notes: string[];
}

/** Resume path: reconstruct leg 2's shape from what is already stored, so a
 * later leg never re-embeds or re-synthesizes (and never re-charges). */
async function readExistingClusters(
  db: PotionDb,
): Promise<{ sessionsSeen: number; spendUsd: number; clusters: Array<{ clusterId: string; sessions: number; toolSequence: string[]; suiteId: string }> }> {
  const suites = await listDerivedSuites(db, ORG);
  const out = [];
  for (const s of suites) {
    const items = await loadDerivedSuite(db, s.suiteId);
    out.push({
      clusterId: s.clusterId,
      sessions: items.items.length,
      toolSequence: [],
      suiteId: s.suiteId,
    });
  }
  return { sessionsSeen: 0, spendUsd: 0, clusters: out };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const mode: 'mock' | 'live' = args.live ? 'live' : 'mock';
  if (args.live && process.env.POTION_EVAL_PROVIDER !== 'live') {
    throw new Error('--live requires POTION_EVAL_PROVIDER=live (the handlers refuse otherwise)');
  }

  const findings: Findings = {
    mode,
    sessions: 0,
    spans: 0,
    withReference: 0,
    clusters: [],
    spend: {},
    notes: [],
  };

  const handle = await createDb();
  const db: PotionDb = handle.db;
  await migrate(db);
  await createOrg(db, { id: ORG, name: 'G2.8 Capstone' });
  // G2.8 (owner requirement): the capstone's clustering runs on the REAL
  // embedder, because clustering quality is part of what a capstone measures —
  // a stand-in would report the test double's geometry as the customer's.
  // The REQUIRED pairing is POTION_CLUSTER_THRESHOLD=0.2: G0.5 measured the
  // real-embedder cliff (96% across 0.05–0.2, 6% at the mock-tuned 0.62), and
  // resolveAgentClusterThreshold now refuses the bad combination outright.
  let embedder = toyEmbedder;
  let embedderKind: 'mock' | 'live' = 'mock';
  if (args.realEmbedder) {
    const prices = loadPrices(PRICES);
    const providers = createProviders({ prices });
    const resolved = resolveEmbedder(
      { POTION_EMBEDDER: 'openai', OPENAI_API_KEY: process.env.OPENAI_API_KEY },
      { mock: createMockProvider(prices), openai: providers.openai },
    );
    if (resolved.mode !== 'openai') {
      throw new Error(`--real-embedder requested but resolved to '${resolved.mode}' — refusing to report a stand-in's clustering as the platform's`);
    }
    embedder = resolved.embedder as typeof toyEmbedder;
    embedderKind = 'live';
    console.log(`embedder: ${resolved.mode} ${resolved.model} ${resolved.dims}-dim`);
  }
  const ctx: JobContext = { db, dbHandle: handle, pricesPath: PRICES, embedder, embedderKind };

  // ---- LEG 1: convert + ingest ($0) --------------------------------------
  if (args.only.has(1)) {
  console.log(`\n=== LEG 1: convert + ingest (${mode}) ===`);
  const files = listTranscripts(args.transcripts);
  const conversions = files.map(convertFile);
  const allSpans: TraceSpanPayload[] = conversions.flatMap((c) => c.spans);

  // The converter already scrubs; verify again here because THIS is the last
  // point before the payload enters storage.
  const survivors = findSecretsDeep(allSpans);
  if (survivors.length > 0) {
    throw new Error(`REFUSING TO INGEST: credential shapes survived [${survivors.join(', ')}]`);
  }

  findings.sessions = conversions.length;
  findings.spans = allSpans.length;
  findings.withReference = conversions.filter((c) => c.hasReference).length;

  const rows: NewTraceSpan[] = allSpans.map((s) => ({
    orgId: ORG,
    traceId: s.trace_id,
    spanId: s.span_id,
    ...(s.parent_id !== undefined ? { parentId: s.parent_id } : {}),
    name: s.name,
    ...(s.model !== undefined ? { model: s.model } : {}),
    usage: { input_tokens: s.input_tokens ?? 0, output_tokens: s.output_tokens ?? 0 },
    costUsd: 0,
    attrs: s.attributes ?? {},
    ts: new Date(s.ts ?? Date.now()),
  }));
  for (let i = 0; i < rows.length; i += 500) await insertTraceSpans(db, rows.slice(i, i + 500));
  console.log(`ingested ${rows.length} spans from ${conversions.length} sessions`);
  ledger('leg1-ingest', 0, 0, 'no provider calls');
  }

  // ---- LEG 2: cluster + derived suites -----------------------------------
  console.log(`\n=== LEG 2: cluster + derived suites ===`);
  // Re-running clustering is idempotent and re-embeds; on a resume we read the
  // existing suites instead so leg 2 is not silently re-charged.
  const clusterRes = args.only.has(2)
    ? await tracesClusterHandler({ orgId: ORG, sinceDays: 3650 }, ctx)
    : await readExistingClusters(db);
  for (const c of clusterRes.clusters) {
    const suite = await loadDerivedSuite(db, c.suiteId);
    findings.clusters.push({
      clusterId: c.clusterId,
      sessions: c.sessions,
      toolSequence: c.toolSequence,
      suiteId: c.suiteId,
      suiteItems: suite.items.length,
    });
  }
  findings.clusters.sort((a, b) => b.suiteItems - a.suiteItems);
  console.log(`sessions seen: ${clusterRes.sessionsSeen}, clusters: ${clusterRes.clusters.length}`);
  for (const c of findings.clusters) {
    console.log(
      `  ${c.clusterId}  sessions=${String(c.sessions).padStart(3)}  items=${String(c.suiteItems).padStart(3)}  tools=${c.toolSequence.join('>') || 'chat'}`,
    );
  }
  ledger('leg2-cluster', 0, clusterRes.spendUsd, 'local embedder');

  // The biggest cluster carries the capstone. Report the rest honestly.
  const target = findings.clusters[0];
  if (target === undefined) throw new Error('no clusters formed — nothing to verify');
  const tooSmall = findings.clusters.filter((c) => c.suiteItems < 5);
  if (tooSmall.length > 0) {
    const note =
      `${tooSmall.length} of ${findings.clusters.length} clusters have <5 suite items — ` +
      `below SUITE_VERIFY_MIN_PAIRS, so they can never render a retention verdict ` +
      `(${tooSmall.map((c) => `${c.clusterId}:${c.suiteItems}`).join(', ')})`;
    findings.notes.push(note);
    console.log(`NOTE: ${note}`);
  }

  // ---- LEG 3: rubric + probe calibration ---------------------------------
  if (args.only.has(3)) {
  console.log(`\n=== LEG 3: rubric + probe calibration (cap $${args.rubricCap}) ===`);
  try {
    const rubric = await rubricGenerateHandler(
      { orgId: ORG, clusterId: target.clusterId, capUsd: args.live ? args.rubricCap : 0, seed: 20260808 },
      ctx,
    );
    findings.rubric = rubric as unknown as Record<string, unknown>;
    findings.spend.rubric = rubric.spendUsd;
    console.log(
      `rubric ${rubric.rubricId} (${rubric.providerMode}) via ${rubric.generatorModel}; ` +
        `calibration ${rubric.calibration ? `r=${rubric.calibration.pearsonVsTruth?.toFixed(3)} rho=${rubric.calibration.spearmanVsTruth?.toFixed(3)} n=${rubric.calibration.n} flagged=${rubric.calibration.flagged}` : `none (${rubric.uncalibratedReason ?? 'n/a'})`}`,
    );
    ledger('leg3-rubric+probe', null, rubric.spendUsd);
  } catch (e) {
    // A refusal is a result, not a crash — record and continue.
    findings.notes.push(`rubric leg refused: ${(e as Error).message}`);
    console.log(`rubric leg REFUSED: ${(e as Error).message}`);
    ledger('leg3-rubric+probe', null, 0, 'refused, no spend');
  }
  }

  // ---- LEG 4: frontier (mock nightly already ran; live sweep if --live) ---
  if (args.only.has(4)) {
  console.log(`\n=== LEG 4: frontier (cap $${args.sweepCap}) ===`);
  if (args.live) {
    const sweep = await frontierLiveSweepHandler(
      { orgId: ORG, clusterId: target.clusterId, capUsd: args.sweepCap },
      ctx,
    );
    findings.frontier = sweep as unknown as Record<string, unknown>;
    findings.spend.sweep = sweep.spendUsd;
    console.log(
      `live sweep: ${sweep.executed} executed / ${sweep.cacheHits} cached → frontier v${sweep.frontierVersion} with ${sweep.points} points`,
    );
    ledger('leg4-frontier-sweep', sweep.projectedSpendUsd, sweep.spendUsd);
  } else {
    const f = await loadCurrentFrontier(db, target.clusterId, ORG);
    findings.frontier = { version: f?.version ?? 0, points: f?.points.length ?? 0, providerMode: 'mock' };
    console.log(`mock frontier v${f?.version ?? 0} with ${f?.points.length ?? 0} points`);
    ledger('leg4-frontier-sweep', 0, 0, 'mock');
  }
  }

  // ---- LEG 5: incumbent + suite-verify -----------------------------------
  if (args.only.has(5)) {
  console.log(`\n=== LEG 5: incumbent + suite-verify (cap $${args.verifyCap}) ===`);
  const frontier = await loadCurrentFrontier(db, target.clusterId, ORG);
  const points = frontier?.points ?? [];
  if (points.length < 2) {
    const note = `frontier has ${points.length} point(s) — need 2 to designate an incumbent and verify a DIFFERENT serving strategy`;
    findings.notes.push(note);
    console.log(`NOTE: ${note}`);
  } else {
    const sorted = [...points].sort((a, b) => b.quality - a.quality);
    const incumbent = sorted[0]!;
    const serving = sorted[sorted.length - 1]!;
    for (const p of [incumbent, serving]) await upsertStrategyConfig(db, p.strategyHash, p.strategyConfig);
    await designateIncumbent(db, ORG, target.clusterId, incumbent.strategyHash);
    const active = await activeIncumbent(db, ORG, target.clusterId);
    console.log(`incumbent ${active?.strategyHash.slice(0, 8)} (q=${incumbent.quality.toFixed(3)})`);
    console.log(`serving   ${serving.strategyHash.slice(0, 8)} (q=${serving.quality.toFixed(3)})`);

    // A guarantee-carrying policy for the tuple the verify is keyed on.
    const policyId = 'pol-g28';
    await insertPolicy(db, {
      id: policyId,
      orgId: ORG,
      name: 'g28-capstone',
      config: {
        type: 'max_quality',
        costCeilingPer1K: 100,
        guarantee: { minQuality: 0.5, windowMin: 60, sampleRate: 1, action: 'alert' },
      },
    });
    const verify = await guaranteeSuiteVerifyHandler(
      {
        orgId: ORG,
        policyId,
        clusterId: target.clusterId,
        servingStrategyHash: serving.strategyHash,
        capUsd: args.live ? args.verifyCap : 0,
      },
      ctx,
    );
    findings.verify = verify as unknown as Record<string, unknown>;
    findings.spend.verify = (verify as { spendUsd?: number }).spendUsd ?? 0;
    const r = (verify as { retention?: { mean: number; ci95: [number, number]; pairs: number; excludedPairs: number; floor: number } }).retention;
    console.log(`outcome: ${(verify as { outcome: string }).outcome}`);
    if (r) {
      const halfWidth = (r.ci95[1] - r.ci95[0]) / 2;
      console.log(
        `retention mean=${r.mean.toFixed(4)} ci95=[${r.ci95[0].toFixed(4)}, ${r.ci95[1].toFixed(4)}] ` +
          `half-width=${halfWidth.toFixed(4)} pairs=${r.pairs} excluded=${r.excludedPairs} floor=${r.floor}`,
      );
      // THE parameter question the capstone exists to answer.
      const slack = 1 - r.floor;
      findings.notes.push(
        halfWidth > slack
          ? `RETENTION FLOOR UNENFORCEABLE AT THIS n: CI half-width ${halfWidth.toFixed(4)} exceeds the floor's slack ${slack.toFixed(4)} (1 − ${r.floor}) at ${r.pairs} pairs — the bound can never be crossed confidently`
          : `retention floor ${r.floor} IS enforceable at ${r.pairs} pairs (half-width ${halfWidth.toFixed(4)} < slack ${slack.toFixed(4)})`,
      );
      console.log(`FINDING: ${findings.notes[findings.notes.length - 1]}`);
    }
    ledger('leg5-suite-verify', null, findings.spend.verify);
  }
  }

  // ---- LEG 6: artifact ----------------------------------------------------
  const evalRows = await db.select().from(evalResults);
  findings.spend.total = Object.entries(findings.spend)
    .filter(([k]) => k !== 'total')
    .reduce((a, [, v]) => a + v, 0);
  findings.notes.push(`${evalRows.length} eval_results rows written`);

  const target2 = `${args.out}/g28-capstone-${mode}.json`;
  writeFileSync(target2, `${JSON.stringify(findings, null, 2)}\n`);
  console.log(`\n=== SUMMARY (${mode}) ===`);
  console.log(`artifact: ${target2}`);
  ledger('TOTAL', null, findings.spend.total);
  for (const n of findings.notes) console.log(`  · ${n}`);

  await handle.close();
}

main().catch((e: unknown) => {
  console.error(`\nCAPSTONE FAILED: ${(e as Error).message}\n${(e as Error).stack ?? ''}`);
  process.exit(1);
});

// Referenced so the strategyHash import is not dropped by the linter when the
// incumbent branch is skipped on a 1-point frontier.
void strategyHash;
void orgHashOf;
void toolSignatureSlug;
