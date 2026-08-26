// The repo prices.json is IMMUTABLE under tests — the regression pin for the
// recurring contamination (2026-08-22 → bb11491, third recurrence
// 2026-08-25).
//
// THE MECHANISM IT PINS. The pre-S5 research:scan handler wrote its merged
// price table to ctx.pricesPath (writeFileSync, c2264a7^:handlers.ts:1257).
// S5 moved the write to database rows — in SOURCE. But apps/server resolves
// @potion/workers through its package exports, i.e. packages/workers/DIST:
// a stale build resurrects the old byte-writer wholesale. And the server
// never passed its resolved pricesPath to runWorker, so the worker fell back
// to POTION_PRICES_PATH ?? repo default — one unprotected boot (a dev
// server, a future test that forgets the env var) plus one scan, and the
// committed table gains or-mock-nova-1/or-mock-apex-1 again.
//
// The fix this test locks in (context.ts + server.ts):
//   · under vitest, a prices path that resolves to the COMMITTED repo file
//     is replaced by a throwaway tmp copy at boot — no test process can
//     ever hold the repo file as its writable prices path;
//   · runWorker receives ctx.pricesPath explicitly, so the worker and the
//     context can never diverge again (the old runWorker honored the option
//     too — this protects even against a stale dist).
//
// This file deliberately boots the WORST CASE: no pricesPath option, no
// POTION_PRICES_PATH, then executes a real mock scan to completion.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';

const REPO_PRICES = fileURLToPath(new URL('../../../prices.json', import.meta.url));

let app: FastifyInstance;
let envBefore: string | undefined;
let repoBytesBefore: string;

beforeAll(async () => {
  envBefore = process.env.POTION_PRICES_PATH;
  delete process.env.POTION_PRICES_PATH; // the unprotected boot, on purpose
  repoBytesBefore = readFileSync(REPO_PRICES, 'utf8');
  app = await buildServer({ seed: false });
});

afterAll(async () => {
  if (envBefore !== undefined) process.env.POTION_PRICES_PATH = envBefore;
  await app.close();
});

describe('repo prices.json immutability under an unprotected boot', () => {
  it('the test boot never holds the repo file as its prices path', () => {
    expect(app.potion.pricesPath).not.toBe(REPO_PRICES);
    // …and the isolated copy is content-identical, so reads are unchanged.
    expect(readFileSync(app.potion.pricesPath, 'utf8')).toBe(repoBytesBefore);
  });

  it('a completed mock scan leaves the repo file byte-identical', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/research/scan',
      payload: { source: 'mock' },
    });
    expect(res.statusCode).toBe(202);
    const { jobId } = res.json() as { jobId: string };
    const deadline = Date.now() + 120_000;
    for (;;) {
      const job = await app.inject({ method: 'GET', url: `/api/jobs/${jobId}` });
      const body = job.json() as { state: string; error?: string };
      if (body.state === 'completed') break;
      expect(body.state, body.error).not.toBe('failed');
      if (Date.now() > deadline) throw new Error('scan job did not settle in 120s');
      await new Promise((r) => setTimeout(r, 250));
    }
    expect(readFileSync(REPO_PRICES, 'utf8')).toBe(repoBytesBefore);
  }, 150_000);
});
