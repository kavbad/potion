// L-G4 shim tests: the decision mapping IS the product statement. The named
// pins: no allow-always ever offered; unreachable gate fails closed to
// supervision (never to allow, never to a brick); resolutions post back.
import { describe, expect, it } from 'vitest';
import { argsHashOf } from './gate.js';
import {
  registerPotionGate,
  type OpenClawBeforeToolCallResult,
  type OpenClawHookCtx,
  type OpenClawPluginApi,
  type OpenClawToolEvent,
} from './plugin.js';

type BeforeHandler = (e: OpenClawToolEvent, c: OpenClawHookCtx) => Promise<OpenClawBeforeToolCallResult | void>;
type AfterHandler = (e: OpenClawToolEvent & { error?: unknown }, c: OpenClawHookCtx) => Promise<void>;

function fakeApi() {
  const handlers: { before?: BeforeHandler; after?: AfterHandler } = {};
  const api: OpenClawPluginApi = {
    on: (name: string, handler: unknown) => {
      if (name === 'before_tool_call') handlers.before = handler as BeforeHandler;
      if (name === 'after_tool_call') handlers.after = handler as AfterHandler;
    },
  } as OpenClawPluginApi;
  return { api, handlers };
}

/** A scripted gate server: responds per path, records every request. */
function fakeFetch(script: (path: string, body: Record<string, unknown>) => unknown) {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  const impl = (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    calls.push({ path, body });
    const out = script(path, body);
    if (out === null) return { ok: false, status: 500, json: async () => ({}) } as Response;
    return { ok: true, status: 200, json: async () => out } as Response;
  }) as typeof fetch;
  return { impl, calls };
}

const CONFIG = { apiUrl: 'https://api.test', apiKey: 'pk_test', harnessHash: 'ab'.repeat(32) };
const EVENT: OpenClawToolEvent = { toolName: 'email:send', params: { to: 'a@b.c', body: 'hi' } };

describe('registerPotionGate', () => {
  it('hold → requireApproval WITHOUT allow-always, and the resolution posts back', async () => {
    const { impl, calls } = fakeFetch((path) =>
      path.endsWith('/sessions') ? { runId: 'runx-1', state: 'running' }
      : path.endsWith('/pore') ? { decision: 'hold', question: 'Allow email:send?' }
      : { recorded: true },
    );
    const { api, handlers } = fakeApi();
    registerPotionGate(api, { ...CONFIG, fetchImpl: impl });
    const result = (await handlers.before!(EVENT, { sessionKey: 's1' })) as OpenClawBeforeToolCallResult;
    expect(result.requireApproval).toBeDefined();
    expect(result.requireApproval!.allowedDecisions).toEqual(['allow-once', 'deny']);
    expect(result.requireApproval!.allowedDecisions).not.toContain('allow-always');
    await result.requireApproval!.onResolution!('allow-once');
    const resolve = calls.find((c) => c.path.endsWith('/pore/resolve'))!;
    expect(resolve.body.resolution).toBe('allow-once');
    expect(resolve.body.argsHash).toBe(argsHashOf(EVENT.params));
  });

  it('allow → no block; the audit flag rides the outcome report', async () => {
    const { impl, calls } = fakeFetch((path) =>
      path.endsWith('/sessions') ? { runId: 'runx-1', state: 'running' }
      : path.endsWith('/pore') ? { decision: 'allow', audit: true }
      : { recorded: true },
    );
    const { api, handlers } = fakeApi();
    registerPotionGate(api, { ...CONFIG, fetchImpl: impl });
    const result = await handlers.before!(EVENT, { sessionKey: 's1' });
    expect(result).toBeUndefined(); // earned autonomy: no ceremony
    await handlers.after!({ ...EVENT }, { sessionKey: 's1' });
    const outcome = calls.find((c) => c.path.endsWith('/outcome'))!;
    expect(outcome.body.ok).toBe(true);
    expect(outcome.body.fromAudit).toBe(true);
  });

  it('blocked → terminal block with the reason', async () => {
    const { impl } = fakeFetch((path) =>
      path.endsWith('/sessions') ? { runId: 'runx-1', state: 'running' }
      : path.endsWith('/pore') ? { decision: 'blocked', reason: 'payments never graduate' }
      : { recorded: true },
    );
    const { api, handlers } = fakeApi();
    registerPotionGate(api, { ...CONFIG, fetchImpl: impl });
    const result = (await handlers.before!(EVENT, { sessionKey: 's1' })) as OpenClawBeforeToolCallResult;
    expect(result.block).toBe(true);
    expect(result.blockReason).toContain('payments never graduate');
  });

  it('unreachable gate fails closed to SUPERVISION: approval required, never silent allow', async () => {
    const { impl } = fakeFetch(() => null); // every call 500s
    const { api, handlers } = fakeApi();
    registerPotionGate(api, { ...CONFIG, fetchImpl: impl });
    const result = (await handlers.before!(EVENT, { sessionKey: 's1' })) as OpenClawBeforeToolCallResult;
    expect(result.block).toBeUndefined();
    expect(result.requireApproval).toBeDefined();
    expect(result.requireApproval!.description).toContain('unreachable');
    expect(result.requireApproval!.description).toContain('not count');
  });
});

describe('argsHashOf', () => {
  it('is key-order independent and value-sensitive', () => {
    expect(argsHashOf({ a: 1, b: 2 })).toBe(argsHashOf({ b: 2, a: 1 }));
    expect(argsHashOf({ a: 1 })).not.toBe(argsHashOf({ a: 2 }));
  });
});

// ── W0 (2026-08-31): the three seams, each with the test that would have
// caught it. Sessions isolate; hashes are cryptographic; audit identity is
// the per-call actionId, never toolName+argsHash.
describe('W0 — session isolation', () => {
  it('two sessions on one client register two runs, and each action reports to ITS OWN run', async () => {
    let sessionN = 0;
    const { impl, calls } = fakeFetch((path) =>
      path.endsWith('/sessions') ? { runId: `runx-${++sessionN}`, state: 'running' }
      : path.endsWith('/pore') ? { decision: 'allow', audit: false }
      : { recorded: true },
    );
    const { api, handlers } = fakeApi();
    registerPotionGate(api, { ...CONFIG, fetchImpl: impl });
    await handlers.before!(EVENT, { sessionKey: 'alpha' });
    await handlers.before!(EVENT, { sessionKey: 'beta' });
    expect(calls.filter((c) => c.path.endsWith('/sessions'))).toHaveLength(2);
    const pores = calls.filter((c) => c.path.endsWith('/pore'));
    expect(pores[0]!.body.runId).toBe('runx-1');
    expect(pores[1]!.body.runId).toBe('runx-2');
    await handlers.after!({ ...EVENT }, { sessionKey: 'beta' });
    const outcome = calls.find((c) => c.path.endsWith('/outcome'))!;
    expect(outcome.body.runId, 'beta outcome must land on beta run').toBe('runx-2');
  });
});

describe('W0 — cryptographic fingerprints', () => {
  it('argsHashOf is full sha256 over sorted-key JSON, insertion-order independent', async () => {
    const { createHash } = await import('node:crypto');
    const h = argsHashOf({ b: 2, a: 1 });
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).toBe(argsHashOf({ a: 1, b: 2 }));
    expect(h).toBe(createHash('sha256').update('{"a":1,"b":2}').digest('hex'));
  });
});

describe('W0 — audit identity is the per-call actionId', () => {
  it('two identical concurrent allowed actions keep their OWN audit flags (toolCallId correlation)', async () => {
    let poreN = 0;
    const { impl, calls } = fakeFetch((path) =>
      path.endsWith('/sessions') ? { runId: 'runx-1', state: 'running' }
      // First identical call is audited, the second is not — the old
      // toolName+argsHash keying collapsed these into one flag.
      : path.endsWith('/pore') ? { decision: 'allow', audit: ++poreN === 1 }
      : { recorded: true },
    );
    const { api, handlers } = fakeApi();
    registerPotionGate(api, { ...CONFIG, fetchImpl: impl });
    const ctx = { sessionKey: 's1' };
    await handlers.before!({ ...EVENT, toolCallId: 'c1' }, ctx);
    await handlers.before!({ ...EVENT, toolCallId: 'c2' }, ctx);
    // Outcomes arrive OUT OF ORDER — c2 first. Identity must hold anyway.
    await handlers.after!({ ...EVENT, toolCallId: 'c2' }, ctx);
    await handlers.after!({ ...EVENT, toolCallId: 'c1' }, ctx);
    const outcomes = calls.filter((c) => c.path.endsWith('/outcome'));
    expect(outcomes).toHaveLength(2);
    const pores = calls.filter((c) => c.path.endsWith('/pore'));
    const auditedActionId = pores[0]!.body.actionId;
    // c2 (second pore, unaudited) reported first, without fromAudit.
    expect(outcomes[0]!.body.fromAudit).toBeUndefined();
    expect(outcomes[1]!.body.fromAudit).toBe(true);
    expect(outcomes[1]!.body.actionId).toBe(auditedActionId);
    expect(pores[0]!.body.actionId).not.toBe(pores[1]!.body.actionId);
  });

  it('without toolCallId, FIFO per (session, tool, args) preserves order and never cross-attributes sessions', async () => {
    let poreN = 0;
    const { impl, calls } = fakeFetch((path) =>
      path.endsWith('/sessions') ? { runId: `runx-${path.length % 7}`, state: 'running' }
      : path.endsWith('/pore') ? { decision: 'allow', audit: poreN++ === 0 }
      : { recorded: true },
    );
    const { api, handlers } = fakeApi();
    registerPotionGate(api, { ...CONFIG, fetchImpl: impl });
    await handlers.before!(EVENT, { sessionKey: 's1' }); // audited
    await handlers.before!(EVENT, { sessionKey: 's2' }); // not audited
    // s2 finishes first — its outcome must NOT consume s1's audited entry.
    await handlers.after!({ ...EVENT }, { sessionKey: 's2' });
    await handlers.after!({ ...EVENT }, { sessionKey: 's1' });
    const outcomes = calls.filter((c) => c.path.endsWith('/outcome'));
    expect(outcomes[0]!.body.fromAudit, 's2 was not audited').toBeUndefined();
    expect(outcomes[1]!.body.fromAudit, 's1 was audited').toBe(true);
  });

  it('the resolve report carries the actionId of the held action', async () => {
    const { impl, calls } = fakeFetch((path) =>
      path.endsWith('/sessions') ? { runId: 'runx-1', state: 'running' }
      : path.endsWith('/pore') ? { decision: 'hold', question: 'Allow?' }
      : { recorded: true },
    );
    const { api, handlers } = fakeApi();
    registerPotionGate(api, { ...CONFIG, fetchImpl: impl });
    const result = (await handlers.before!(EVENT, { sessionKey: 's1' })) as OpenClawBeforeToolCallResult;
    await result.requireApproval!.onResolution!('deny');
    const pore = calls.find((c) => c.path.endsWith('/pore'))!;
    const resolve = calls.find((c) => c.path.endsWith('/pore/resolve'))!;
    expect(resolve.body.actionId).toBe(pore.body.actionId);
    expect(typeof resolve.body.actionId).toBe('string');
  });
});
