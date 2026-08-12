// Step 4 E2E: a run's steps land as EVAL ITEMS through the EXISTING
// step-synthesis path with ZERO converter changes. Extends Step 3's
// span-ingestion leg: enriched spans go through the REAL ingest route
// (redaction and idempotency apply), then the REAL traces:cluster worker
// handler runs, and the derived -replays-v2 suite must contain step items
// whose context matches the recorded run.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { sha256 } from '@potion/core';
import {
  createDb,
  createLabRun,
  createOrg,
  derivedSuiteItems,
  insertApiKey,
  listLabSteps,
  migrate,
  type DbHandle,
} from '@potion/db';
import { eq } from 'drizzle-orm';
import { harnessSpecHash, type HarnessSpec } from '@potion/lab-spec';
import { buildServer } from '@potion/server/server';
import { orgHashOf, toolSignatureSlug, tracesClusterHandler, type JobContext } from '@potion/workers';
import { runLeg, type LabTool } from './loop.js';
import { ServingClient } from './serving-client.js';
import { spansForSteps } from './spans.js';
import type { ServingResult } from './serving-client.js';

const ORG = 'org_lab_synth';
const RAW_KEY = 'pk_lab_synth_key_0001';
const REPO_PRICES = fileURLToPath(new URL('../../../prices.json', import.meta.url));

let h: DbHandle;
let app: FastifyInstance;
let client: ServingClient;
let suitesV2Dir: string;

// The deterministic word-hash embedder from workers' own traces tests —
// duplicated here because test fixtures are not importable across packages;
// same divergence note applies (real embeddings cluster differently).
function wordHash(word: string): number {
  let hsh = 0;
  for (let i = 0; i < word.length; i++) hsh = (Math.imul(hsh, 31) + word.charCodeAt(i)) | 0;
  return Math.abs(hsh);
}
const fakeEmbedder = {
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => {
      const v = new Array<number>(384).fill(0);
      for (const w of t.toLowerCase().split(/[^a-z0-9]+/)) {
        if (w.length > 0) v[wordHash(w) % 384]! += 1;
      }
      const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
      return v.map((x) => x / norm);
    });
  },
};

beforeAll(async () => {
  h = await createDb();
  await migrate(h.db);
  await createOrg(h.db, { id: ORG, name: 'Lab Synthesis Org' });
  await insertApiKey(h.db, {
    id: 'key-lab-synth', keyHash: sha256(RAW_KEY), name: 'synth',
    orgId: ORG, rateRps: 1000, dailyCap: 100_000,
  });
  suitesV2Dir = mkdtempSync(path.join(tmpdir(), 'lab-suites-v2-'));
  app = await buildServer({ db: h, seed: false });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  if (addr === null || typeof addr === 'string') throw new Error('no address');
  client = new ServingClient({ baseUrl: `http://127.0.0.1:${addr.port}`, apiKey: RAW_KEY });
}, 120_000);

afterAll(async () => {
  await app.close();
  await h.close();
  rmSync(suitesV2Dir, { recursive: true, force: true });
});

function ctx(): JobContext {
  return { db: h.db, dbHandle: h, pricesPath: REPO_PRICES, suitesV2Dir, embedder: fakeEmbedder };
}

describe('steps → eval items, zero converter changes', () => {
  it('a tool-bearing run synthesizes into -replays-v2 step items via the real ingest + worker path', async () => {
    // A content-rich scripted run (the scripted client drives tool calls the
    // mock provider cannot; the INGEST and SYNTHESIS paths are fully real).
    const spec: HarnessSpec = {
      specVersion: 1,
      name: 'synthesis harness',
      brain: { policy: { type: 'min_cost', qualityFloor: 0 } },
      mission: {
        kind: 'task',
        goal: 'Refactor the billing retry loop for invoices',
        doneDefinition: 'A refactoring summary exists',
      },
      superpowers: [],
      memory: { enabled: false },
      rules: [],
      fuel: { maxUsdPerRun: 1, hardStop: true },
      checkIns: [],
    };
    const hash = harnessSpecHash(spec);
    const searchTool: LabTool = {
      name: 'search', description: 'search the codebase', parameters: { type: 'object' },
      external: false,
      run: async () => ({ files: ['billing/retry.ts'] }),
    };
    const scriptedResults: ServingResult[] = [
      {
        kind: 'ok', completionId: 'chatcmpl-synth0001', text: '', toolCalls: [
          { id: 't1', type: 'function', function: { name: 'search', arguments: '{"q":"billing retry"}' } },
        ],
        finishReason: 'tool_calls',
        usage: { promptTokens: 20, completionTokens: 5, totalTokens: 25 },
        frontierTrace: 'cluster=code-gen;strategy=synth;frontier=v1;policy=min_cost;fallback=0;provenance=mock',
      },
      {
        kind: 'ok', completionId: 'chatcmpl-synth0002',
        text: 'Refactored the billing retry loop to use exponential backoff with invoice idempotency keys.',
        toolCalls: [], finishReason: 'stop',
        usage: { promptTokens: 40, completionTokens: 20, totalTokens: 60 },
        frontierTrace: 'cluster=code-gen;strategy=synth;frontier=v1;policy=min_cost;fallback=0;provenance=mock',
      },
    ];
    const q = [...scriptedResults];
    const scripted = {
      complete: async () => q.shift()!,
      emitSpans: async () => true,
    } as unknown as ServingClient;

    const runId = 'run-synth-1';
    await createLabRun(h.db, { id: runId, orgId: ORG, harnessHash: hash, harnessName: spec.name, spec });
    const outcome = await runLeg({
      db: h.db, client: scripted, runId, orgId: ORG, spec, harnessHash: hash, tools: [searchTool],
    });
    expect(outcome.status).toBe('completed');

    // ---- REAL ingest: the enriched spans go through POST /v1/traces ----
    const steps = await listLabSteps(h.db, runId, ORG);
    const spans = spansForSteps(runId, steps);
    // The enrichment is what makes synthesis possible: prompt + completion on
    // llm.call spans, args/result on the tool span.
    const llm = spans.filter((s) => s.name === 'llm.call');
    expect(llm.length).toBe(2);
    expect((llm[0]!.attributes as Record<string, unknown>)['gen_ai.prompt']).toBe('Begin the mission.');
    expect((llm[1]!.attributes as Record<string, unknown>)['gen_ai.completion']).toContain('exponential backoff');
    expect(spans.some((s) => (s.name as string) === 'tool.search')).toBe(true);
    expect(await client.emitSpans(spans)).toBe(true);
    // Idempotency: re-emission is safe (the Step 3 property, still true with
    // content aboard).
    expect(await client.emitSpans(spans)).toBe(true);

    // ---- REAL synthesis: the traces:cluster worker, untouched ----
    const result = await tracesClusterHandler({}, ctx());
    expect(result.sessionsSeen).toBeGreaterThanOrEqual(1);
    expect(result.clustersCreated).toBeGreaterThanOrEqual(1);

    // The step-level suite exists and carries OUR step as an eval item whose
    // context is the recorded run's context and whose reference is the
    // recorded completion.
    const clusterId = `agent-${orgHashOf(ORG)}-${toolSignatureSlug(['search'])}`;
    const suiteId = `${clusterId}-replays-v2`;
    const items = await h.db
      .select()
      .from(derivedSuiteItems)
      .where(eq(derivedSuiteItems.suiteId, suiteId));
    expect(items.length, `no step items in ${suiteId}`).toBeGreaterThanOrEqual(1);
    const item = items[0]!;
    const promptText = JSON.stringify(item.prompt);
    expect(promptText).toContain('Begin the mission.');
    expect(promptText).toContain('search'); // the tool hop is in the context
    expect(item.reference).toContain('exponential backoff');
  }, 120_000);
});
