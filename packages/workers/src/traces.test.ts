// Agent-workload worker tests (M5 #36, SPEC §14) — PGlite + tmp prices.json
// + tmp suites-v2 dir, deterministic fake embedder, zero network. Covers:
// redactTraceText, toolSignatureSlug, traces:cluster end-to-end (cluster row
// + exemplars + synthesized replay suite + eval run + first frontier),
// idempotent re-runs, incremental suite growth with version bump, and
// traces:purge retention semantics (0 = metadata-only redaction; N = delete).
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clusters,
  clusterExemplars,
  createDb,
  evalRuns,
  getOrgTraceRetentionDays,
  insertTraceSpans,
  listSpansForTrace,
  migrate,
  orgs,
  setOrgTraceRetentionDays,
  type DbHandle,
  type NewTraceSpan,
} from '@potion/db';
import { loadCurrentFrontier } from '@potion/pareto';
import { eq } from 'drizzle-orm';
import {
  orgHashOf,
  redactTraceText,
  toolSignatureSlug,
  tracesClusterHandler,
  tracesPurgeHandler,
  tracesRedactHandler,
  type JobContext,
} from './handlers.js';

const REPO_PRICES = fileURLToPath(new URL('../../../prices.json', import.meta.url));

let root: string;
let pricesPath: string;
let suitesV2Dir: string;
let db: DbHandle;

beforeEach(async () => {
  root = mkdtempSync(path.join(tmpdir(), 'potion-traces-'));
  pricesPath = path.join(root, 'prices.json');
  copyFileSync(REPO_PRICES, pricesPath);
  suitesV2Dir = path.join(root, 'suites-v2');
  db = await createDb();
  await migrate(db.db);
  await db.db
    .insert(orgs)
    .values([
      { id: 'org_a', name: 'Org A' },
      { id: 'org_b', name: 'Org B' },
    ])
    .onConflictDoNothing();
});

afterEach(async () => {
  await db.close();
  rmSync(root, { recursive: true, force: true });
});

/** Deterministic 384-dim bag-of-word-hashes embedder: texts sharing most
 * words → high cosine, disjoint vocab → low. (Char-bag fails here: English
 * char-frequency distributions cosine ~0.9 for ANY pair of sentences.) */
function wordHash(word: string): number {
  let h = 0;
  for (let i = 0; i < word.length; i++) h = (Math.imul(h, 31) + word.charCodeAt(i)) | 0;
  return Math.abs(h);
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

function ctx(): JobContext {
  return { db: db.db, dbHandle: db, pricesPath, suitesV2Dir, embedder: fakeEmbedder };
}

function span(over: Partial<NewTraceSpan>): NewTraceSpan {
  return {
    orgId: 'org_a',
    traceId: 'tr_1',
    spanId: 'sp_1',
    name: 'agent.root',
    model: 'mock-cheap',
    usage: { input_tokens: 10, output_tokens: 5 },
    costUsd: 0,
    attrs: {},
    ts: new Date('2026-08-06T10:00:00Z'),
    ...over,
  };
}

/** A two-span agent session: root (carries the prompt) + one tool call. */
async function seedSession(
  orgId: string,
  traceId: string,
  prompt: string,
  tool: string | null,
  ts = '2026-08-06T10:00:00Z',
): Promise<void> {
  const spans: NewTraceSpan[] = [
    span({ orgId, traceId, spanId: `${traceId}_root`, attrs: { 'gen_ai.prompt': prompt }, ts: new Date(ts) }),
  ];
  if (tool !== null) {
    spans.push(
      span({
        orgId,
        traceId,
        spanId: `${traceId}_tool`,
        name: `tool.${tool}`,
        attrs: { 'gen_ai.operation.name': 'execute_tool' },
        ts: new Date(new Date(ts).getTime() + 60_000),
      }),
    );
  }
  await insertTraceSpans(db.db, spans);
}

describe('M5 #36 helpers', () => {
  it('redactTraceText: emails, secrets, long digit runs — structure kept', () => {
    const out = redactTraceText('Mail maria@acme-corp.io about invoice 88341220 with sk-live-abcdefgh123');
    expect(out).not.toContain('maria@acme-corp.io');
    expect(out).not.toContain('88341220');
    expect(out).not.toContain('sk-live-abcdefgh123');
    expect(out).toContain('<email>');
    expect(out).toContain('<num>');
    expect(out).toContain('<secret>');
    expect(out.startsWith('Mail ')).toBe(true);
    expect(redactTraceText('x'.repeat(5000))).toHaveLength(2000);
  });

  it('toolSignatureSlug: chat bucket, deterministic, order-sensitive', () => {
    expect(toolSignatureSlug([])).toBe('chat');
    expect(toolSignatureSlug(['search', 'write'])).toBe(toolSignatureSlug(['search', 'write']));
    expect(toolSignatureSlug(['search', 'write'])).not.toBe(toolSignatureSlug(['write', 'search']));
    expect(toolSignatureSlug(['search'])).toMatch(/^[0-9a-f]{6}$/);
  });
});

describe('traces:cluster (M5 #36, SPEC §14.2)', () => {
  it('clusters sessions PER ORG by signature+embedding → cluster row, exemplars, suite, eval, frontier', async () => {
    // Two similar billing sessions + one outlier in org_a (same tool seq →
    // same org bucket, outlier splits on cosine); one chat session in
    // org_b. G1.2: orgs NEVER pool — org_b gets its own cluster id under
    // its own org hash, even in the nightly {} run.
    await seedSession('org_a', 'tr_b1', 'Refactor the billing retry loop for invoices', 'search');
    await seedSession('org_a', 'tr_b2', 'Refactor the billing retry loop for receipts', 'search');
    await seedSession('org_a', 'tr_o1', 'Write a haiku about the autumn sea', 'search');
    await seedSession('org_b', 'tr_c1', 'Summarize the outage postmortem for the board', null);

    const res = await tracesClusterHandler({}, ctx());
    expect(res.sessionsSeen).toBe(4);
    expect(res.clustersCreated).toBe(3);

    const searchSlug = toolSignatureSlug(['search']);
    const aHash = orgHashOf('org_a');
    const bHash = orgHashOf('org_b');
    const billingId = `agent-${aHash}-${searchSlug}`;
    const outlierId = `agent-${aHash}-${searchSlug}-2`;
    const chatId = `agent-${bHash}-chat`;

    // Cluster rows registered with deterministic ids.
    const rows = await db.db.select().from(clusters);
    const ids = rows.map((r) => r.id).sort();
    expect(ids).toEqual([billingId, chatId, outlierId].sort());
    const billing = rows.find((r) => r.id === billingId)!;
    expect(billing.name).toContain('search');
    expect(billing.exemplarCount).toBe(2);
    // G1.2: ownership column set per org.
    expect(billing.orgId).toBe('org_a');
    expect(rows.find((r) => r.id === chatId)!.orgId).toBe('org_b');

    // Exemplars carry REDACTED text + 384-dim embeddings.
    const ex = await db.db
      .select()
      .from(clusterExemplars)
      .where(eq(clusterExemplars.clusterId, billingId));
    expect(ex).toHaveLength(2);
    expect(ex[0]!.text).toContain('billing retry loop');

    // Synthesized replay suites (v2 layout) with llm-judge scoring.
    for (const suiteId of [`${billingId}-replays-v1`, `${chatId}-replays-v1`]) {
      const manifest = JSON.parse(
        readFileSync(path.join(suitesV2Dir, suiteId, 'manifest.json'), 'utf8'),
      ) as { version: string; clusterId: string; scoring: { allowed: string[] } };
      expect(manifest.version).toBe('1.0.0');
      expect(manifest.clusterId).toBe(suiteId.replace(/-replays-v1$/, ''));
      expect(manifest.scoring.allowed).toEqual(['llm-judge']);
      const items = readFileSync(path.join(suitesV2Dir, suiteId, 'items.jsonl'), 'utf8')
        .split('\n')
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l) as { id: string; clusterId: string; scoring: { kind: string } });
      expect(items.length).toBeGreaterThan(0);
      expect(items.every((it) => it.clusterId === manifest.clusterId)).toBe(true);
      expect(items.every((it) => it.scoring.kind === 'llm-judge')).toBe(true);
    }

    // Eval runs recorded; agent clusters have a first (mock) frontier.
    const runs = await db.db.select().from(evalRuns);
    expect(runs.length).toBe(3);
    const frontier = await loadCurrentFrontier(db.db, billingId);
    expect(frontier).not.toBeNull();
    expect(frontier!.version).toBe(1);
    expect(frontier!.points.length).toBeGreaterThan(0);

    // Outcome rows report the eval run per cluster.
    expect(res.clusters.every((c) => c.evalRunId !== null)).toBe(true);
  });

  it('re-runs are idempotent; new sessions append items and bump the suite version', async () => {
    await seedSession('org_a', 'tr_b1', 'Refactor the billing retry loop for invoices', 'search');
    const first = await tracesClusterHandler({}, ctx());
    expect(first.clustersCreated).toBe(1);
    const slug = `${orgHashOf('org_a')}-${toolSignatureSlug(['search'])}`;
    const suiteId = `agent-${slug}-replays-v1`;

    // Identical re-run: nothing new.
    const second = await tracesClusterHandler({}, ctx());
    expect(second.clustersCreated).toBe(0);
    expect(second.clustersUpdated).toBe(0);
    expect(second.clusters[0]!.itemsAdded).toBe(0);
    expect(second.clusters[0]!.evalRunId).toBeNull();
    let manifest = JSON.parse(
      readFileSync(path.join(suitesV2Dir, suiteId, 'manifest.json'), 'utf8'),
    ) as { version: string };
    expect(manifest.version).toBe('1.0.0');

    // A NEW session (same message family) extends the suite + bumps version.
    await seedSession('org_a', 'tr_b2', 'Refactor the billing retry loop for receipts', 'search');
    const third = await tracesClusterHandler({}, ctx());
    expect(third.clustersCreated).toBe(0);
    expect(third.clustersUpdated).toBe(1);
    expect(third.clusters[0]!.itemsAdded).toBe(1);
    expect(third.clusters[0]!.evalRunId).not.toBeNull();
    manifest = JSON.parse(
      readFileSync(path.join(suitesV2Dir, suiteId, 'manifest.json'), 'utf8'),
    ) as { version: string };
    expect(manifest.version).toBe('1.0.1');
    const items = readFileSync(path.join(suitesV2Dir, suiteId, 'items.jsonl'), 'utf8')
      .split('\n')
      .filter((l) => l.trim().length > 0);
    expect(items).toHaveLength(2);
    // Frontier recomputed (still v1 lineage from the same pipeline).
    const frontier = await loadCurrentFrontier(db.db, `agent-${slug}`);
    expect(frontier).not.toBeNull();
  });

  it('org restriction + window filter + payload redaction in synthesized items', async () => {
    await seedSession('org_a', 'tr_a1', 'Mail cfo@acme.io the 99887766 report', 'search');
    await seedSession('org_b', 'tr_b1', 'Summarize the outage postmortem', 'search');
    const res = await tracesClusterHandler({ orgId: 'org_a' }, ctx());
    expect(res.sessionsSeen).toBe(1);
    expect(res.clustersCreated).toBe(1);
    const suiteId = `agent-${orgHashOf('org_a')}-${toolSignatureSlug(['search'])}-replays-v1`;
    const itemsText = readFileSync(path.join(suitesV2Dir, suiteId, 'items.jsonl'), 'utf8');
    expect(itemsText).not.toContain('cfo@acme.io');
    expect(itemsText).not.toContain('99887766');
    expect(itemsText).toContain('<email>');
  });

  it('requires an embedder (clear error when absent)', async () => {
    await seedSession('org_a', 'tr_a1', 'Refactor the billing retry loop', 'search');
    const bare: JobContext = { db: db.db, dbHandle: db, pricesPath, suitesV2Dir };
    await expect(tracesClusterHandler({}, bare)).rejects.toThrow('embedder');
  });
});

describe('traces:redact backfill (G1.1)', () => {
  it('re-redacts raw-seeded rows in place; idempotent second run updates 0', async () => {
    await seedSession('org_a', 'tr_bf', 'Mail cfo@acme.io about account 99887766', 'search');
    const first = await tracesRedactHandler({ orgId: 'org_a' }, ctx());
    expect(first.scanned).toBeGreaterThanOrEqual(2); // root + tool span
    expect(first.updated).toBeGreaterThanOrEqual(1); // the PII-bearing root
    const spans = await listSpansForTrace(db.db, 'org_a', 'tr_bf');
    const root = spans.find((sp) => (sp.attrs as Record<string, unknown>)['gen_ai.prompt'] !== undefined)!;
    expect((root.attrs as Record<string, unknown>)['gen_ai.prompt']).toBe(
      'Mail <email> about account <num>',
    );
    const second = await tracesRedactHandler({ orgId: 'org_a' }, ctx());
    expect(second.updated).toBe(0);
  });
});

describe('traces:purge (M5 #36, SPEC §14.3)', () => {
  it('retention 0 redacts payloads (metadata only); N deletes old spans', async () => {
    // org_a: metadata-only. org_b: 30-day delete.
    await setOrgTraceRetentionDays(db.db, 'org_a', 0);
    await seedSession('org_a', 'tr_a1', 'Mail cfo@acme.io the report', 'search');
    await seedSession('org_b', 'tr_old', 'Ancient session', 'search', '2026-06-01T10:00:00Z');
    await seedSession('org_b', 'tr_new', 'Recent session', null);

    const res = await tracesPurgeHandler({}, ctx());
    expect(res.orgs).toBe(2);
    expect(res.redacted).toBe(2); // org_a root + tool span
    expect(res.deleted).toBe(2); // org_b ancient root + tool span

    // org_a: rows kept, attrs gone.
    const a = await listSpansForTrace(db.db, 'org_a', 'tr_a1');
    expect(a).toHaveLength(2);
    expect(a.every((s) => (s.attrs as Record<string, unknown>)['gen_ai.prompt'] === undefined)).toBe(
      true,
    );
    expect(a[0]!.model).toBe('mock-cheap'); // metadata survives
    // org_b: old trace gone, new kept.
    expect(await listSpansForTrace(db.db, 'org_b', 'tr_old')).toHaveLength(0);
    expect(await listSpansForTrace(db.db, 'org_b', 'tr_new')).toHaveLength(1);

    // Idempotent second pass.
    const again = await tracesPurgeHandler({}, ctx());
    expect(again.redacted).toBe(0);
    expect(again.deleted).toBe(0);
  });

  it('single-org restriction + retention default 30', async () => {
    expect(await getOrgTraceRetentionDays(db.db, 'org_a')).toBe(30);
    await seedSession('org_a', 'tr_a1', 'Refactor the billing retry loop', 'search');
    const res = await tracesPurgeHandler({ orgId: 'org_a' }, ctx());
    expect(res.orgs).toBe(1);
    expect(res.deleted).toBe(0); // fresh spans survive the 30-day window
  });
});
