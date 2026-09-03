// Publish gate client (F2) — the act asks decideAction like everything
// else, the approval binds to the exact draft, and an unreachable gate
// NEVER waves a publish through.
import { describe, expect, it } from 'vitest';
import { publishActionId, publishArgsHash, publishGateDecision, reportPublishOutcome } from './publisher.js';
import type { Draft } from './write.js';

const DRAFT: Draft = {
  title: 'Every frontier held this week.',
  summary: 's',
  plain: 'p',
  lede: 'l',
  frontierNote: 'f',
  auditionNote: 'a',
  mixingNote: 'm',
  takeaway: 't',
  faq: [
    { q: 'q1', a: 'a1' },
    { q: 'q2', a: 'a2' },
    { q: 'q3', a: 'a3' },
  ],
};

function fakeFetch(script: Array<{ status?: number; json?: unknown }>, calls: Array<{ url: string; body?: unknown }> = []): typeof fetch {
  let i = 0;
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const step = script[Math.min(i, script.length - 1)];
    i += 1;
    calls.push({ url: String(input), ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    const status = step?.status ?? 200;
    return { ok: status >= 200 && status < 300, status, json: async () => step?.json ?? {}, text: async () => JSON.stringify(step?.json ?? {}) } as Response;
  }) as typeof fetch;
}

const OPTS = { url: 'https://api.test', apiKey: 'pk_test', harnessHash: 'c'.repeat(64) };

describe('publish gate', () => {
  it('fingerprint is deterministic and content-sensitive', () => {
    const h1 = publishArgsHash('2026-W36', DRAFT);
    expect(h1).toBe(publishArgsHash('2026-W36', { ...DRAFT }));
    expect(h1).not.toBe(publishArgsHash('2026-W37', DRAFT));
    expect(h1).not.toBe(publishArgsHash('2026-W36', { ...DRAFT, title: 'Changed.' }));
    expect(publishActionId('2026-W36', h1)).toBe(`pub-2026-w36-${h1.slice(0, 8)}`);
  });

  it('allow flows through with the audit flag, and the outcome reports', async () => {
    const calls: Array<{ url: string; body?: unknown }> = [];
    const fetchImpl = fakeFetch(
      [
        { json: { runId: 'runx-1' } },
        { json: { decision: 'allow', audit: true } },
        { json: {} },
      ],
      calls,
    );
    const g = await publishGateDecision('2026-W36', DRAFT, { ...OPTS, fetchImpl });
    expect(g).toMatchObject({ decision: 'allow', audit: true, runId: 'runx-1' });
    await reportPublishOutcome(g, true, { ...OPTS, fetchImpl });
    expect(calls[0]!.url).toContain('/v1/lab/runtime/sessions');
    expect(calls[1]!.url).toContain('/v1/lab/runtime/pore');
    expect((calls[1]!.body as { toolName: string }).toolName).toBe('publish_frontier_notes');
    expect(calls[2]!.url).toContain('/v1/lab/runtime/outcome');
  });

  it('supervised holds with the question (born supervised)', async () => {
    const g = await publishGateDecision('2026-W36', DRAFT, {
      ...OPTS,
      fetchImpl: fakeFetch([{ json: { runId: 'runx-2' } }, { json: { decision: 'hold', question: 'The agent wants to run publish_frontier_notes — allow it?' } }]),
    });
    expect(g.decision).toBe('hold');
    expect(g.question).toMatch(/allow it\?/);
  });

  it("an operator's prior allow-once on this exact fingerprint decides without re-asking", async () => {
    const hash = publishArgsHash('2026-W36', DRAFT);
    const actionId = publishActionId('2026-W36', hash);
    const g = await publishGateDecision('2026-W36', DRAFT, {
      ...OPTS,
      session: 'ps_x',
      fetchImpl: fakeFetch([
        { json: { runId: 'runx-3' } },
        { json: { steps: [{ kind: 'model', excerpt: `approved [action ${actionId}]` }] } },
      ]),
    });
    expect(g).toMatchObject({ decision: 'allow', priorResolution: true, actionId });
  });

  it('a prior deny blocks, and a DIFFERENT fingerprint approval decides nothing', async () => {
    const otherApproval = `approved [action pub-2026-w36-ffffffff]`;
    const denied = await publishGateDecision('2026-W36', DRAFT, {
      ...OPTS,
      session: 'ps_x',
      fetchImpl: fakeFetch([
        { json: { runId: 'runx-4' } },
        { json: { steps: [{ kind: 'model', excerpt: `rejected by supervisor [action ${publishActionId('2026-W36', publishArgsHash('2026-W36', DRAFT))}]` }] } },
      ]),
    });
    expect(denied.decision).toBe('blocked');
    const unrelated = await publishGateDecision('2026-W36', DRAFT, {
      ...OPTS,
      session: 'ps_x',
      fetchImpl: fakeFetch([
        { json: { runId: 'runx-5' } },
        { json: { steps: [{ kind: 'model', excerpt: otherApproval }] } },
        { json: { decision: 'hold', question: 'allow?' } },
      ]),
    });
    expect(unrelated.decision).toBe('hold');
  });

  it('a resolution the caller read from the record decides without any steps-read', async () => {
    const approved = await publishGateDecision('2026-W36', DRAFT, {
      ...OPTS,
      priorResolution: 'approved',
      fetchImpl: fakeFetch([{ json: { runId: 'runx-7' } }]),
    });
    expect(approved).toMatchObject({ decision: 'allow', priorResolution: true, runId: 'runx-7' });
    const rejected = await publishGateDecision('2026-W36', DRAFT, {
      ...OPTS,
      priorResolution: 'rejected',
      fetchImpl: fakeFetch([{ json: { runId: 'runx-8' } }]),
    });
    expect(rejected.decision).toBe('blocked');
  });

  it('an unreachable gate NEVER waves a publish through', async () => {
    const down = await publishGateDecision('2026-W36', DRAFT, { ...OPTS, fetchImpl: fakeFetch([{ status: 503 }]) });
    expect(down.decision).toBe('hold');
    expect(down.error).toMatch(/gate session HTTP 503/);
    const poreDown = await publishGateDecision('2026-W36', DRAFT, {
      ...OPTS,
      fetchImpl: fakeFetch([{ json: { runId: 'runx-6' } }, { status: 500 }]),
    });
    expect(poreDown.decision).toBe('hold');
    expect(poreDown.error).toMatch(/pore HTTP 500/);
  });
});
