// Trace repo tests (M5, ROADMAP #36, SPEC §14) — PGlite, zero services.
// Covers: idempotent ingest on (org,trace,span), session-window reads,
// waterfall order, retention purge (delete N days) + redaction (0 = metadata
// only), clustering read model (first message + tool sequence), loop
// detection thresholds, migration 0015 idempotency, orgs.trace_retention_days
// default.
import { describe, expect, it } from 'vitest';
import {
  createDb,
  deleteSpansOlderThan,
  detectLoopSignals,
  getOrgTraceRetentionDays,
  insertTraceSpans,
  listOrgIdsWithSpans,
  listOrgTraceSpans,
  listSpansForTrace,
  createOrg,
  listTracesForClustering,
  migrate,
  redactSpanAttrs,
  setOrgTraceRetentionDays,
  type DbHandle,
  type NewTraceSpan,
} from './index.js';
import { orgs } from './schema.js';

async function migratedDb(orgId = 'org_traces'): Promise<DbHandle> {
  const handle = await createDb(); // PGlite: zero services
  await migrate(handle.db);
  await handle.db.insert(orgs).values({ id: orgId, name: 'Traces Org' });
  return handle;
}

function span(over: Partial<NewTraceSpan> = {}): NewTraceSpan {
  return {
    orgId: 'org_traces',
    traceId: 'tr_a',
    spanId: 'sp_1',
    name: 'agent.root',
    model: 'mock-cheap',
    usage: { input_tokens: 100, output_tokens: 50 },
    costUsd: 0.001,
    attrs: { 'gen_ai.prompt': 'Summarize the outage postmortem' },
    ts: new Date('2026-08-06T10:00:00Z'),
    ...over,
  };
}

describe('trace_spans repo (M5 #36)', () => {
  it('ingest is idempotent on (org, trace, span): re-posts count as duplicates', async () => {
    const h = await migratedDb();
    const batch = [span(), span({ spanId: 'sp_2', name: 'tool.search' })];
    const first = await insertTraceSpans(h.db, batch);
    expect(first).toEqual({ accepted: 2, duplicates: 0 });
    const second = await insertTraceSpans(h.db, batch);
    expect(second).toEqual({ accepted: 0, duplicates: 2 });
    // Overlapping batch: one new span + one repeat.
    const third = await insertTraceSpans(h.db, [batch[0]!, span({ spanId: 'sp_3' })]);
    expect(third).toEqual({ accepted: 1, duplicates: 1 });
    const all = await listOrgTraceSpans(h.db, 'org_traces');
    expect(all).toHaveLength(3);
  });

  it('window filter + waterfall order (ts, then spanId)', async () => {
    const h = await migratedDb();
    await insertTraceSpans(h.db, [
      span({ spanId: 'sp_b', ts: new Date('2026-08-06T10:02:00Z') }),
      span({ spanId: 'sp_a', ts: new Date('2026-08-06T10:01:00Z') }),
      span({ spanId: 'sp_c', ts: new Date('2026-08-05T09:00:00Z') }),
    ]);
    const waterfall = await listSpansForTrace(h.db, 'org_traces', 'tr_a');
    expect(waterfall.map((s) => s.spanId)).toEqual(['sp_c', 'sp_a', 'sp_b']);
    const window = await listOrgTraceSpans(h.db, 'org_traces', {
      from: new Date('2026-08-06T00:00:00Z'),
    });
    expect(window.map((s) => s.spanId).sort()).toEqual(['sp_a', 'sp_b']);
  });

  it('retention: purge deletes spans older than the cutoff', async () => {
    const h = await migratedDb();
    await insertTraceSpans(h.db, [
      span({ spanId: 'sp_old', ts: new Date('2026-07-01T00:00:00Z') }),
      span({ spanId: 'sp_new', ts: new Date('2026-08-05T00:00:00Z') }),
    ]);
    const deleted = await deleteSpansOlderThan(h.db, 'org_traces', new Date('2026-08-01T00:00:00Z'));
    expect(deleted).toBe(1);
    const remaining = await listOrgTraceSpans(h.db, 'org_traces');
    expect(remaining.map((s) => s.spanId)).toEqual(['sp_new']);
  });

  it('retention=0 (metadata only): attrs redacted, metadata kept, idempotent', async () => {
    const h = await migratedDb();
    await insertTraceSpans(h.db, [span()]);
    const redacted = await redactSpanAttrs(h.db, 'org_traces');
    expect(redacted).toBe(1);
    const rows = await listOrgTraceSpans(h.db, 'org_traces');
    expect(rows[0]!.attrs).toEqual({});
    // Metadata survives: model, usage, cost, ts, name.
    expect(rows[0]!.model).toBe('mock-cheap');
    expect(rows[0]!.usage).toEqual({ input_tokens: 100, output_tokens: 50 });
    expect(rows[0]!.costUsd).toBe(0.001);
    expect(rows[0]!.name).toBe('agent.root');
    // Second pass redacts nothing (attrs already empty).
    expect(await redactSpanAttrs(h.db, 'org_traces')).toBe(0);
  });

  it('orgs.trace_retention_days defaults to 30 and updates round-trip', async () => {
    const h = await migratedDb();
    expect(await getOrgTraceRetentionDays(h.db, 'org_traces')).toBe(30);
    expect(await getOrgTraceRetentionDays(h.db, 'org_missing')).toBeNull();
    expect(await setOrgTraceRetentionDays(h.db, 'org_traces', 0)).toBe(true);
    expect(await getOrgTraceRetentionDays(h.db, 'org_traces')).toBe(0);
    expect(await setOrgTraceRetentionDays(h.db, 'org_missing', 7)).toBe(false);
  });

  it('listOrgIdsWithSpans fans the purge job out per org', async () => {
    const h = await migratedDb('org_a');
    await h.db.insert(orgs).values({ id: 'org_b', name: 'B' });
    await insertTraceSpans(h.db, [span({ orgId: 'org_a' }), span({ orgId: 'org_b', traceId: 'tr_b' })]);
    const ids = await listOrgIdsWithSpans(h.db);
    expect(ids.sort()).toEqual(['org_a', 'org_b']);
  });

  it('clustering read model: first message + ordered tool sequence per trace', async () => {
    const h = await migratedDb();
    await insertTraceSpans(h.db, [
      span({ spanId: 'sp_1', name: 'agent.root', ts: new Date('2026-08-06T10:00:00Z') }),
      span({
        spanId: 'sp_2',
        name: 'tool.search',
        attrs: { 'gen_ai.operation.name': 'execute_tool' },
        ts: new Date('2026-08-06T10:01:00Z'),
      }),
      span({
        spanId: 'sp_3',
        name: 'tool.write',
        attrs: { 'gen_ai.operation.name': 'execute_tool' },
        ts: new Date('2026-08-06T10:02:00Z'),
      }),
      span({
        spanId: 'sp_4',
        traceId: 'tr_b',
        name: 'agent.root',
        attrs: { 'gen_ai.prompt': 'Retry the failed invoices' },
        ts: new Date('2026-08-06T11:00:00Z'),
      }),
    ]);
    const sources = await listTracesForClustering(h.db);
    expect(sources).toHaveLength(2);
    // G1.4: multi-turn collect + last-completion-wins + tool transcript.
    await insertTraceSpans(h.db, [
      span({ traceId: 'tr_g14', spanId: 'g14_1', attrs: { 'gen_ai.prompt': 'first turn' }, ts: new Date('2026-08-06T12:00:00Z') }),
      span({ traceId: 'tr_g14', spanId: 'g14_2', attrs: { 'gen_ai.completion': 'draft answer' }, ts: new Date('2026-08-06T12:01:00Z') }),
      span({
        traceId: 'tr_g14',
        spanId: 'g14_3',
        name: 'tool.lookup',
        attrs: { 'gen_ai.operation.name': 'execute_tool', 'tool.args': 'q=x', 'tool.result': 'hit' },
        ts: new Date('2026-08-06T12:02:00Z'),
      }),
      span({ traceId: 'tr_g14', spanId: 'g14_4', attrs: { 'gen_ai.prompt': 'second turn' }, ts: new Date('2026-08-06T12:03:00Z') }),
      span({ traceId: 'tr_g14', spanId: 'g14_5', attrs: { 'gen_ai.completion': 'final answer' }, ts: new Date('2026-08-06T12:04:00Z') }),
    ]);
    const g14 = (await listTracesForClustering(h.db)).find((s0) => s0.traceId === 'tr_g14')!;
    expect(g14.turns).toEqual(['first turn', 'second turn']);
    expect(g14.firstMessage).toBe('first turn');
    expect(g14.referenceAnswer).toBe('final answer'); // last wins
    expect(g14.toolTranscript).toEqual([{ name: 'lookup', args: 'q=x', result: 'hit' }]);
    // G1.2: identical trace ids in TWO orgs never merge — (org, trace) key.
    await createOrg(h.db, { id: 'org_g12', name: 'G12' });
    await insertTraceSpans(h.db, [
      span({ orgId: 'org_g12', spanId: 'sp_x1', attrs: { 'gen_ai.prompt': 'other tenant same trace id' } }),
    ]);
    const keyed = await listTracesForClustering(h.db);
    expect(keyed.filter((s0) => s0.traceId === 'tr_a')).toHaveLength(2);
    // org predicate applies IN SQL
    const scoped = await listTracesForClustering(h.db, { orgId: 'org_g12' });
    expect(scoped).toHaveLength(1);
    expect(scoped[0]!.orgId).toBe('org_g12');
    const a = sources.find((s) => s.traceId === 'tr_a')!;
    expect(a.firstMessage).toBe('Summarize the outage postmortem');
    expect(a.toolSequence).toEqual(['search', 'write']);
    expect(a.spanCount).toBe(3);
    expect(a.totalCostUsd).toBeCloseTo(0.003, 9);
    const b = sources.find((s) => s.traceId === 'tr_b')!;
    expect(b.toolSequence).toEqual([]);
    expect(b.firstMessage).toBe('Retry the failed invoices');
  });

  it('loop detection: ≥3 identical tool signatures flag; differing args do not', async () => {
    const mk = (q: string) => ({
      name: 'tool.search',
      attrs: { 'gen_ai.operation.name': 'execute_tool', query: q },
    });
    const loops = detectLoopSignals([mk('x'), mk('x'), mk('x'), mk('y')]);
    expect(loops).toHaveLength(1);
    expect(loops[0]!.count).toBe(3);
    expect(loops[0]!.signature).toContain('tool.search');
    // 2 repeats is below threshold; non-tool spans never participate.
    expect(
      detectLoopSignals([
        mk('x'),
        mk('x'),
        { name: 'agent.think', attrs: { note: 'x' } },
        { name: 'agent.think', attrs: { note: 'x' } },
        { name: 'agent.think', attrs: { note: 'x' } },
      ]),
    ).toEqual([]);
    // Attr key order is irrelevant (canonical stringify).
    expect(
      detectLoopSignals([
        { name: 'tool.a', attrs: { 'gen_ai.operation.name': 'execute_tool', p: 1, q: 2 } },
        { name: 'tool.a', attrs: { q: 2, 'gen_ai.operation.name': 'execute_tool', p: 1 } },
        { name: 'tool.a', attrs: { 'gen_ai.operation.name': 'execute_tool', p: 1, q: 2 } },
      ]),
    ).toHaveLength(1);
  });

  it('migration 0015_traces is idempotent', async () => {
    const h = await createDb();
    await expect(migrate(h.db)).resolves.toContain('0015_traces.sql');
    await expect(migrate(h.db)).resolves.toContain('0015_traces.sql');
  });

  it('step view (post-capstone item 2): llm.call spans pair completion with the context that call saw', async () => {
    const h = await migratedDb('org_steps');
    // Converter-v2 layout: root prompt → llm.call s1 (+its tool call) →
    // llm.call s2 (final) → terminal chat span.
    await insertTraceSpans(h.db, [
      span({ orgId: 'org_steps', traceId: 'tr_s', spanId: 'tr_s_root', attrs: { 'gen_ai.prompt': 'Fix the flaky test' }, ts: new Date('2026-08-10T10:00:00Z') }),
      span({
        orgId: 'org_steps', traceId: 'tr_s', spanId: 'tr_s_s1', name: 'llm.call', model: 'claude-opus-5',
        usage: { input_tokens: 1200, output_tokens: 80 },
        attrs: { 'gen_ai.operation.name': 'llm_call', 'gen_ai.completion': 'Looking at the test file.', 'potion.step_index': 1 },
        ts: new Date('2026-08-10T10:00:05Z'),
      }),
      span({
        orgId: 'org_steps', traceId: 'tr_s', spanId: 'tr_s_t1', name: 'tool.Read',
        attrs: { 'gen_ai.operation.name': 'execute_tool', 'tool.args': 'flaky.test.ts', 'tool.result': 'race in beforeEach' },
        ts: new Date('2026-08-10T10:00:05Z'),
      }),
      span({
        orgId: 'org_steps', traceId: 'tr_s', spanId: 'tr_s_s2', name: 'llm.call', model: 'claude-opus-5',
        usage: { input_tokens: 2000, output_tokens: 200 },
        attrs: { 'gen_ai.operation.name': 'llm_call', 'gen_ai.completion': 'The race is in beforeEach; awaiting the handle fixes it.', 'potion.step_index': 2 },
        ts: new Date('2026-08-10T10:00:20Z'),
      }),
      span({
        orgId: 'org_steps', traceId: 'tr_s', spanId: 'tr_s_chat', name: 'chat',
        attrs: { 'gen_ai.completion': 'The race is in beforeEach; awaiting the handle fixes it.' },
        ts: new Date('2026-08-10T10:00:20Z'),
      }),
    ]);
    const src = (await listTracesForClustering(h.db, { orgId: 'org_steps' }))[0]!;
    // Pre-v2 semantics untouched: turns, session reference, tool transcript.
    expect(src.turns).toEqual(['Fix the flaky test']);
    expect(src.referenceAnswer).toContain('awaiting the handle');
    expect(src.toolSequence).toEqual(['Read']);
    // The step view: pairing preserved, per-call usage, context folds forward.
    expect(src.steps).toHaveLength(2);
    const [s1, s2] = src.steps;
    expect(s1!.stepIndex).toBe(1);
    expect(s1!.completion).toBe('Looking at the test file.');
    expect(s1!.usage).toEqual({ inputTokens: 1200, outputTokens: 80 });
    expect(s1!.contextBefore).toEqual([{ kind: 'user', text: 'Fix the flaky test' }]);
    expect(s2!.stepIndex).toBe(2);
    // Step 2 saw: the user turn, step 1's own completion, and the tool call
    // step 1 dispatched — exactly the context that call saw.
    expect(s2!.contextBefore).toEqual([
      { kind: 'user', text: 'Fix the flaky test' },
      { kind: 'assistant', text: 'Looking at the test file.' },
      { kind: 'tool', name: 'Read', args: 'flaky.test.ts', result: 'race in beforeEach' },
    ]);
    await h.close();
  });

  it('step view: pre-v2 traces (no llm.call spans) yield steps: [] — session-item fallback, no flag day', async () => {
    const h = await migratedDb('org_nosteps');
    await insertTraceSpans(h.db, [
      span({ orgId: 'org_nosteps', traceId: 'tr_old', spanId: 'o_root', attrs: { 'gen_ai.prompt': 'legacy session' } }),
      span({ orgId: 'org_nosteps', traceId: 'tr_old', spanId: 'o_chat', name: 'chat', attrs: { 'gen_ai.completion': 'legacy answer' }, ts: new Date('2026-08-06T10:01:00Z') }),
    ]);
    const src = (await listTracesForClustering(h.db, { orgId: 'org_nosteps' }))[0]!;
    expect(src.steps).toEqual([]);
    expect(src.referenceAnswer).toBe('legacy answer');
    await h.close();
  });
});
