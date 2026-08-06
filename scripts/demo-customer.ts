// scripts/demo-customer.ts — the customer-shaped demo (BUILD PROMPT §8 DoD).
//
// ONE continuous run, zero network, zero external services (embedded PGlite
// Postgres, in-process queue, deterministic mock provider):
//
//   1. BOOT      — API server on a fresh PGlite; demo data auto-seeds
//                  (demo key, 3 policies, REAL code-gen + extraction
//                  frontiers computed by the harness + pareto engine).
//   2. WORKLOAD  — upload apps/dashboard/samples/workload.jsonl, print the
//                  cluster breakdown.
//   3. FRONTIERS — per-cluster frontier table (strategy, quality, $/1K, p95).
//   4. POLICY    — create max_quality with a $2.00/1K ceiling, bound to a
//                  fresh API key; show the operating point it selects.
//   5. CHAT      — 3 requests (code-gen, extraction, general chat) through
//                  /v1/chat/completions; print x-frontier-trace + first line.
//   6. NEW MODEL — a mock new-model release moves the frontier: runRecompute
//                  (@potion/pareto) evals the planned shortlist, saves
//                  frontier v2, prints the buyer-readable diff narrative, and
//                  a re-sent request proves serving picks up v2 immediately.
//
// Run: pnpm demo:customer
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { Policy, StrategyConfig } from '@potion/core';
import { describeStrategy, loadCurrentFrontier, mergePriceEntry, runRecompute } from '@potion/pareto';
import { createMockProvider } from '@potion/providers';
import { createQueue } from '@potion/queue';
import { buildServer } from '@potion/server/server';
import { DEFAULT_PRICES_PATH } from '@potion/server/context';
import { createResolver } from '@potion/strategies';

const WORKLOAD_PATH = fileURLToPath(
  new URL('../apps/dashboard/samples/workload.jsonl', import.meta.url),
);

const CUSTOMER_POLICY: Policy = { type: 'max_quality', costCeilingPer1K: 2.0 };

// ---------- tiny formatting helpers ----------

const RULE = '─'.repeat(76);

function section(n: number, title: string): void {
  console.log(`\n┌${RULE}┐`);
  console.log(`│ ${n} · ${title}`);
  console.log(`└${RULE}┘`);
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

function bar(count: number, max: number): string {
  return '█'.repeat(Math.max(1, Math.round((count / max) * 24)));
}

// ---------- HTTP response shapes (server: apps/server/src/routes) ----------

interface WorkloadResponse {
  total: number;
  breakdown: Record<string, number>;
  avgConfidence: number;
}

interface FrontierPointDto {
  strategyHash: string;
  strategyConfig: StrategyConfig;
  quality: number;
  costPer1K: number;
  latencyP95: number;
  dominated: boolean;
}

interface FrontierResponse {
  frontier: {
    clusterId: string;
    version: number;
    pricesVersion: string;
    points: FrontierPointDto[];
  };
  operatingPoint: {
    strategyConfig: StrategyConfig;
    quality: number;
    costPer1K: number;
    latencyP95: number;
    fallback: 0 | 1;
  } | null;
}

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`${init?.method ?? 'GET'} ${url} → ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

function printFrontierTable(points: FrontierPointDto[]): void {
  console.log(pad('    strategy', 52) + pad('quality', 9) + pad('$/1K', 10) + 'p95 ms');
  console.log('    ' + '-'.repeat(80));
  for (const p of [...points].sort((a, b) => a.costPer1K - b.costPer1K)) {
    console.log(
      pad(`    ${describeStrategy(p.strategyConfig)}`, 52) +
        pad(p.quality.toFixed(3), 9) +
        pad(`$${p.costPer1K.toFixed(3)}`, 10) +
        String(Math.round(p.latencyP95)),
    );
  }
}

async function chat(
  base: string,
  apiKey: string,
  label: string,
  prompt: string,
): Promise<string> {
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model: 'potion-auto', messages: [{ role: 'user', content: prompt }] }),
  });
  const trace = res.headers.get('x-frontier-trace') ?? '(missing!)';
  if (!res.ok) {
    throw new Error(`chat '${label}' → ${res.status}: ${await res.text()} (trace: ${trace})`);
  }
  const body = (await res.json()) as { choices: Array<{ message: { content: string } }> };
  const firstLine = body.choices[0]?.message.content.split('\n')[0] ?? '';
  console.log(`  ─ ${label}`);
  console.log(`    prompt : ${prompt.length > 68 ? prompt.slice(0, 65) + '…' : prompt}`);
  console.log(`    trace  : ${trace}`);
  console.log(`    reply  : ${firstLine}`);
  return trace;
}

// ---------- the demo ----------

async function main(): Promise<void> {
  console.log('═'.repeat(78));
  console.log('  POTION — customer demo · one continuous run · zero services, zero keys');
  console.log('  (embedded PGlite Postgres · in-process queue · deterministic mock provider)');
  console.log('═'.repeat(78));

  // ---- 1 · boot ----
  section(1, 'BOOT — API server, fresh embedded Postgres, demo data auto-seeds');
  const t0 = Date.now();
  const app = await buildServer({ log: (msg) => console.log(`    [boot] ${msg}`) });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  if (address === null || typeof address === 'string') throw new Error('no listen address');
  const base = `http://127.0.0.1:${address.port}`;
  const health = await getJson<{
    ok: boolean;
    seeded: boolean;
    embedder: string;
    providerMode: string;
    pricesVersion: string;
  }>(`${base}/healthz`);
  console.log(`    listening : ${base}  (boot + seed in ${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  console.log(
    `    healthz   : ok=${health.ok} seeded=${health.seeded} embedder=${health.embedder} ` +
      `provider=${health.providerMode} prices=v${health.pricesVersion}`,
  );

  // ---- 2 · workload upload → cluster breakdown ----
  section(2, 'WORKLOAD — upload sample workload, cluster breakdown');
  const jsonl = await readFile(WORKLOAD_PATH, 'utf8');
  const workload = await getJson<WorkloadResponse>(`${base}/api/workloads`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-ndjson' },
    body: jsonl,
  });
  console.log(`    ${workload.total} prompts · avg assignment confidence ${workload.avgConfidence}`);
  const entries = Object.entries(workload.breakdown).sort((a, b) => b[1] - a[1]);
  const max = entries[0]![1];
  for (const [clusterId, count] of entries) {
    console.log(`      ${pad(clusterId, 16)} ${pad(bar(count, max), 26)} ${count}`);
  }

  // ---- 3 · per-cluster frontier tables ----
  section(3, 'FRONTIERS — current Pareto frontier per cluster (non-dominated set)');
  const listed = await getJson<{ clusters: Array<{ clusterId: string }> }>(`${base}/api/frontiers`);
  const frontierByCluster = new Map<string, FrontierResponse>();
  for (const { clusterId } of listed.clusters) {
    const fr = await getJson<FrontierResponse>(`${base}/api/frontiers/${clusterId}`);
    frontierByCluster.set(clusterId, fr);
    console.log(
      `\n    cluster '${clusterId}' — frontier v${fr.frontier.version} (prices v${fr.frontier.pricesVersion})`,
    );
    printFrontierTable(fr.frontier.points);
  }

  // ---- 4 · policy: max_quality, $2.00/1K ceiling → fresh API key ----
  section(4, 'POLICY — max_quality with a $2.00/1K cost ceiling');
  const created = await getJson<{
    policy: { id: string; name: string; config: Policy };
    apiKey?: string;
  }>(`${base}/api/policies`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      policy: CUSTOMER_POLICY,
      name: 'customer-max-quality-2usd',
      createKey: true,
    }),
  });
  if (!created.apiKey) throw new Error('server did not return an api key');
  const apiKey = created.apiKey;
  console.log(`    policy '${created.policy.name}' (${created.policy.id}): ${JSON.stringify(CUSTOMER_POLICY)}`);
  console.log(`    fresh api key: ${apiKey.slice(0, 10)}… (raw key is returned exactly once)`);
  for (const clusterId of frontierByCluster.keys()) {
    const fr = await getJson<FrontierResponse>(`${base}/api/frontiers/${clusterId}`, {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    const op = fr.operatingPoint;
    if (op) {
      console.log(
        `    operating point on ${pad(clusterId, 12)}: ${describeStrategy(op.strategyConfig)} — ` +
          `quality ${op.quality.toFixed(3)} at $${op.costPer1K.toFixed(3)}/1K, p95 ${Math.round(op.latencyP95)}ms`,
      );
    }
  }

  // ---- 5 · three chat requests with trace headers ----
  section(5, 'CHAT — 3 requests through POST /v1/chat/completions (trace header per reply)');
  await chat(
    base,
    apiKey,
    'code-gen',
    'Write a Python function that checks whether a string is a palindrome, with unit tests.',
  );
  await chat(
    base,
    apiKey,
    'extraction',
    "Extract the invoice number, total amount, and due date from this email: 'Hi, invoice INV-2041 for $1,250.00 is due March 15. Thanks, Dana.'",
  );
  await chat(
    base,
    apiKey,
    'general chat (no frontier yet → documented fallback)',
    'What is a polite way to ask a coworker to reply to messages faster?',
  );

  // ---- 6 · new-model release → the frontier moves ----
  section(6, 'NEW MODEL RELEASE — the frontier moves automatically (@potion/pareto recompute)');
  const newModel = {
    alias: 'mock-new-x',
    provider: 'mock' as const,
    model: 'mock-mid', // mock corpus mapping: mid-class quality profile…
    inputPer1M: 0.3, // …priced BELOW the mid tier (sonnet-class $3/$15 per 1M)
    outputPer1M: 1.2,
  };
  console.log(`    price-table entry: ${JSON.stringify(newModel)}`);
  const before = await loadCurrentFrontier(app.potion.db.db, 'code-gen');
  const queue = createQueue('memory');
  const result = await runRecompute({
    db: app.potion.db,
    queue,
    newModel,
    clusterIds: ['code-gen'],
    pricesPath: DEFAULT_PRICES_PATH,
    budgetCapUsd: 1,
  });
  await queue.close();
  console.log(`    recompute shortlist (${result.plan.length} strategies, queue jobs ${result.evalJobIds.length}+1):`);
  for (const s of result.plan) console.log(`      · ${describeStrategy(s)}`);
  const spend = result.evalSummaries.reduce((sum, s) => sum + s.spendUsd, 0);
  const v2 = result.frontiers[0]!;
  console.log(
    `    eval spend $${spend.toFixed(4)} (mock-priced) · code-gen frontier v${before?.version ?? 0} → v${v2.version}`,
  );
  console.log(`\n    NEW FRONTIER v${v2.version} (code-gen):`);
  printFrontierTable(
    v2.points.map((p) => ({
      strategyHash: p.strategyHash,
      strategyConfig: p.strategyConfig,
      quality: p.quality,
      costPer1K: p.costPer1K,
      latencyP95: p.latencyP95,
      dominated: false,
    })),
  );
  const diff = result.diffs[0]!;
  console.log(`\n    DIFF v${diff.fromVersion} → v${diff.toVersion}`);
  console.log(`      appeared    : ${diff.appeared.map((p) => describeStrategy(p.strategyConfig)).join('; ') || '—'}`);
  console.log(`      vanished    : ${diff.vanished.map((p) => describeStrategy(p.strategyConfig)).join('; ') || '—'}`);
  console.log(
    `      dominated-by: ${
      diff.dominatedBy
        .map(({ point, dominatedBy }) =>
          `${describeStrategy(point.strategyConfig)} ← ${describeStrategy(dominatedBy.strategyConfig)}`,
        )
        .join('; ') || '—'
    }`,
  );
  console.log('\n    NARRATIVE (buyer-readable):');
  for (const line of diff.narrative) console.log(`      • ${line}`);

  // A production deploy ships the new model by bumping prices.json and
  // restarting (the price table is versioned and loaded at boot). Simulate
  // that reload here: merged price table + resolver, same mock world.
  const mergedPrices = mergePriceEntry(app.potion.prices, newModel);
  const mergedMock = createMockProvider(mergedPrices);
  app.potion.prices = mergedPrices;
  app.potion.providers = {
    anthropic: mergedMock,
    openai: mergedMock,
    google: mergedMock,
    openrouter: mergedMock,
    mock: mergedMock,
  };
  app.potion.resolve = createResolver(app.potion.providers, mergedPrices);
  console.log(
    `\n    price table reloaded (production: bump prices.json + restart) — now v${mergedPrices.version}`,
  );
  console.log('    serving picks up the new frontier immediately — re-sending the code-gen request:');
  const traceAfter = await chat(
    base,
    apiKey,
    'code-gen (after recompute)',
    'Write a Python function that checks whether a string is a palindrome, with unit tests.',
  );
  if (!traceAfter.includes(`frontier=v${v2.version}`)) {
    throw new Error(`expected serving on frontier v${v2.version}, got: ${traceAfter}`);
  }

  await app.close();
  console.log('\n' + '═'.repeat(78));
  console.log('  DEMO COMPLETE — workload in → clustered → frontier → policy → traced answers');
  console.log('  → frontier moved on new-model release. Live spend this run: $0.00 (mock-only).');
  console.log('═'.repeat(78));
}

await main();
