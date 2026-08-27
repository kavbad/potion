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
  const impl = (async (url: RequestInfo | URL, init?: RequestInit) => {
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
