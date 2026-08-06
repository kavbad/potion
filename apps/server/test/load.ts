// Gate-5 load test (SPEC §8): 50 RPS for 10s against a REAL seeded server on
// an ephemeral port (mock providers, zero network), measuring:
//
//   · platform overhead = client wall time − model time.
//     MODEL-TIME DERIVATION: the mock provider does NOT sleep — its
//     `latencyMs` is a synthetic profile number from latencyProfileMs(model)
//     (packages/providers/src/mock/mock.ts), so the actual in-process model
//     execution time is ~0 (measured below, p50 ≈ 0.05ms). Platform overhead
//     is therefore wall − ~0 = the full client wall time, which we report as
//     the CONSERVATIVE UPPER BOUND (any real model would only subtract more).
//   · cluster-assign time (<30ms target), measured through the SAME assigner
//     the server uses (cache-miss path = fresh embed + cosine over 10
//     centroids; cache-hit path = Map lookup).
//
// Implementation choice: hand-rolled open-loop fetch scheduler instead of
// autocannon — zero extra dependencies, exact 50 RPS pacing, and direct
// in-process access to the assigner for the <30ms measurement.
import { performance } from 'node:perf_hooks';
import { createMockProvider } from '@potion/providers';
import { buildServer } from '../src/server.js';
import { DEMO_API_KEY } from '../src/seed.js';

const RPS = 50;
const DURATION_S = 10;
const TOTAL = RPS * DURATION_S;
const OVERHEAD_P95_BUDGET_MS = 80;
const ASSIGN_BUDGET_MS = 30;

const PROMPTS = [
  'Write a python function that reverses a string',
  'Implement a SQL query to find duplicate emails',
  'Write a typescript function that debounces another function',
  'Fix the bug in this javascript sorting code',
  'Extract the invoice total and vendor as JSON',
  'Extract all email fields from this text into JSON',
  'Parse the log line and extract the status code as a field',
  'Write a bash one-liner that counts lines in all files',
  'Implement a react hook that tracks window size',
  'Extract the company entity names as JSON',
];

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)]!;
}

function stats(xs: number[]): { p50: number; p95: number; mean: number; max: number } {
  const sorted = [...xs].sort((a, b) => a - b);
  return {
    p50: Math.round(percentile(sorted, 50) * 100) / 100,
    p95: Math.round(percentile(sorted, 95) * 100) / 100,
    mean: Math.round((xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length)) * 100) / 100,
    max: Math.round((sorted[sorted.length - 1] ?? NaN) * 100) / 100,
  };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

console.log('─'.repeat(88));
console.log('Potion load test — 50 RPS × 10s, seeded server, mock providers, ephemeral port');
console.log('(hand-rolled open-loop fetch loop: no extra deps, exact pacing, in-process assign timing)');
console.log('─'.repeat(88));

const app = await buildServer({ seed: true, log: () => {} });
await app.listen({ port: 0, host: '127.0.0.1' });
const address = app.server.address();
const port = typeof address === 'object' && address !== null ? address.port : 0;
const url = `http://127.0.0.1:${port}/v1/chat/completions`;
console.log(`server ready on :${port} (seeded=${app.potion.seeded}, embedder=${app.potion.embedderKind})`);

// ---- 0. model-time derivation evidence: in-process mock execution ≈ 0 ----
const mock = createMockProvider(app.potion.prices);
const mockTimes: number[] = [];
for (let i = 0; i < 50; i++) {
  const s = performance.now();
  await mock.complete({
    model: 'gpt-mini-class',
    messages: [{ role: 'user', content: PROMPTS[i % PROMPTS.length]! }],
  });
  mockTimes.push(performance.now() - s);
}
const mockStats = stats(mockTimes);
console.log(
  `model time derivation: mock complete() performs no sleep (latencyMs is a synthetic profile); ` +
    `in-process execution p50=${mockStats.p50}ms p95=${mockStats.p95}ms → treated as ~0`,
);

// ---- 1. cluster-assign timing (the same assigner the pipeline uses) ----
const assigner = app.potion.assigner;
const assignCold: number[] = [];
for (let i = 0; i < 200; i++) {
  const prompt = `${PROMPTS[i % PROMPTS.length]} (variant ${i} — unique text defeats the cache)`;
  const s = performance.now();
  await assigner.assign(prompt);
  assignCold.push(performance.now() - s);
}
const assignHit: number[] = [];
for (let i = 0; i < 200; i++) {
  const s = performance.now();
  await assigner.assign(PROMPTS[0]!);
  assignHit.push(performance.now() - s);
}
const coldStats = stats(assignCold);
const hitStats = stats(assignHit);
console.log(
  `cluster assign: cold (embed+cosine) p50=${coldStats.p50}ms p95=${coldStats.p95}ms · ` +
    `cached p50=${hitStats.p50}ms p95=${hitStats.p95}ms (budget <${ASSIGN_BUDGET_MS}ms)`,
);

// ---- 2. 50 RPS for 10s, open loop ----
const wall: number[] = [];
const statuses = new Map<number, number>();
const errors: string[] = [];
const started = performance.now();
const inflight: Promise<void>[] = [];
for (let i = 0; i < TOTAL; i++) {
  const at = started + i * (1000 / RPS);
  const wait = at - performance.now();
  if (wait > 0) await sleep(wait);
  const prompt = PROMPTS[i % PROMPTS.length]!;
  inflight.push(
    (async () => {
      const s = performance.now();
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${DEMO_API_KEY}`,
            'content-type': 'application/json',
            connection: 'close',
          },
          body: JSON.stringify({
            model: 'potion-auto',
            messages: [{ role: 'user', content: prompt }],
          }),
        });
        await res.text();
        statuses.set(res.status, (statuses.get(res.status) ?? 0) + 1);
        wall.push(performance.now() - s);
      } catch (err) {
        errors.push((err as Error).message);
      }
    })(),
  );
}
await Promise.all(inflight);
const elapsedS = (performance.now() - started) / 1000;

const wallStats = stats(wall);
const rpsActual = Math.round((wall.length / elapsedS) * 10) / 10;
console.log('─'.repeat(88));
console.log(
  `requests: ${wall.length}/${TOTAL} ok=${statuses.get(200) ?? 0} ` +
    `statuses=${JSON.stringify(Object.fromEntries(statuses))} errors=${errors.length} · ` +
    `${rpsActual} RPS actual over ${elapsedS.toFixed(1)}s`,
);
console.log(
  `platform overhead (= client wall − model ~0, conservative upper bound): ` +
    `p50=${wallStats.p50}ms p95=${wallStats.p95}ms mean=${wallStats.mean}ms max=${wallStats.max}ms ` +
    `(budget p95 <${OVERHEAD_P95_BUDGET_MS}ms)`,
);
if (errors.length > 0) console.log(`first errors: ${errors.slice(0, 3).join(' | ')}`);

// ---- verdict ----
const failures: string[] = [];
if ((statuses.get(200) ?? 0) !== TOTAL) failures.push(`only ${statuses.get(200) ?? 0}/${TOTAL} returned 200`);
if (!(wallStats.p95 < OVERHEAD_P95_BUDGET_MS)) {
  failures.push(`platform overhead p95 ${wallStats.p95}ms >= ${OVERHEAD_P95_BUDGET_MS}ms`);
}
if (!(coldStats.p95 < ASSIGN_BUDGET_MS)) {
  failures.push(`cluster assign p95 ${coldStats.p95}ms >= ${ASSIGN_BUDGET_MS}ms`);
}
if (!(hitStats.p95 < ASSIGN_BUDGET_MS)) {
  failures.push(`cached assign p95 ${hitStats.p95}ms >= ${ASSIGN_BUDGET_MS}ms`);
}

console.log('─'.repeat(88));
if (failures.length === 0) {
  console.log(
    `LOAD TEST PASS: ${TOTAL} requests @ 50 RPS · overhead p95=${wallStats.p95}ms (<${OVERHEAD_P95_BUDGET_MS}ms) · ` +
      `assign p95=${coldStats.p95}ms (<${ASSIGN_BUDGET_MS}ms)`,
  );
} else {
  console.log(`LOAD TEST FAIL: ${failures.join(' · ')}`);
}

await app.close();
process.exit(failures.length === 0 ? 0 : 1);
