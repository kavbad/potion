// X6 — the browser hand's laws at the tool layer (scripted service; the
// real Chromium service is proven live at deploy):
//   · reads are external:false, the act is external:true — THE law;
//   · the session opens lazily, is reused, and close() is idempotent;
//   · key-shaped content in page text is redacted before model context;
//   · an unreachable service degrades to a typed error, never a crash.
import { describe, expect, it } from 'vitest';
import { buildBrowserLabTools } from './browser-tools.js';

interface Call { path: string; method: string; body: unknown }

function scriptedService(pages: Record<string, unknown>): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  let sessions = 0;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const path = url.replace('http://browser.test', '');
    const body = init?.body !== undefined ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path, method: init?.method ?? 'GET', body });
    if (path === '/session' && init?.method === 'POST') {
      sessions += 1;
      return new Response(JSON.stringify({ sessionId: `bs-${sessions}` }), { status: 200 });
    }
    if (path.endsWith('/goto')) {
      const target = (body as { url: string }).url;
      return new Response(JSON.stringify(pages[target] ?? { error: 'navigation failed: nope' }), { status: 200 });
    }
    if (path.endsWith('/act')) {
      return new Response(JSON.stringify({ url: 'https://app.example/after', title: 'After', text: 'clicked', interactables: [] }), { status: 200 });
    }
    if (path.endsWith('/state')) {
      return new Response(JSON.stringify({ url: 'https://app.example/x', title: 'X', text: 'state', interactables: [] }), { status: 200 });
    }
    if (init?.method === 'DELETE') {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe('the law: reads free, acts gate', () => {
  it('browser_open/browser_read are external:false; browser_act is external:true', () => {
    const setup = buildBrowserLabTools({ browserUrl: 'http://browser.test' });
    const byName = new Map(setup.tools.map((t) => [t.name, t]));
    expect(byName.get('browser_open')!.external).toBe(false);
    expect(byName.get('browser_read')!.external).toBe(false);
    expect(byName.get('browser_act')!.external).toBe(true);
  });
});

describe('session lifecycle + plumbing', () => {
  it('opens lazily, reuses the session, acts against it, closes idempotently', async () => {
    const { fetchImpl, calls } = scriptedService({
      'https://app.example/board': { url: 'https://app.example/board', title: 'Board', text: 'Sprint 12', interactables: [{ ref: 'p1', tag: 'button', label: 'Add card' }] },
    });
    const setup = buildBrowserLabTools({ browserUrl: 'http://browser.test', fetchImpl });
    const byName = new Map(setup.tools.map((t) => [t.name, t]));

    const opened = (await byName.get('browser_open')!.run({ url: 'https://app.example/board' })) as { title: string; interactables: unknown[] };
    expect(opened.title).toBe('Board');
    expect(opened.interactables).toHaveLength(1);

    const acted = (await byName.get('browser_act')!.run({ ref: 'p1', kind: 'click' })) as { title: string };
    expect(acted.title).toBe('After');

    // ONE session for both calls.
    expect(calls.filter((c) => c.path === '/session' && c.method === 'POST')).toHaveLength(1);
    expect(calls.find((c) => c.path.endsWith('/act'))!.path).toContain('bs-1');

    await setup.close();
    await setup.close(); // idempotent
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(1);
  });

  it('acting or reading with no page open is a typed error', async () => {
    const setup = buildBrowserLabTools({ browserUrl: 'http://browser.test', fetchImpl: scriptedService({}).fetchImpl });
    const byName = new Map(setup.tools.map((t) => [t.name, t]));
    expect(((await byName.get('browser_act')!.run({ ref: 'p1', kind: 'click' })) as { error: string }).error).toContain('browser_open first');
    expect(((await byName.get('browser_read')!.run({})) as { error: string }).error).toContain('browser_open first');
  });

  it('an unreachable service degrades to a typed error, never a throw', async () => {
    const failing = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const setup = buildBrowserLabTools({ browserUrl: 'http://browser.test', fetchImpl: failing });
    const byName = new Map(setup.tools.map((t) => [t.name, t]));
    const res = (await byName.get('browser_open')!.run({ url: 'https://x.example' })) as { error: string };
    expect(res.error).toContain('browser service unreachable');
  });
});

describe('custody at the tool boundary', () => {
  it('key-shaped content in page text is redacted before model context', async () => {
    const { fetchImpl } = scriptedService({
      'https://leaky.example': {
        url: 'https://leaky.example', title: 'Leaky',
        text: 'config dump: sk-live_abcdefghijklmnop1234 and AKIAABCDEFGHIJKLMNOP end',
        interactables: [],
      },
    });
    const setup = buildBrowserLabTools({ browserUrl: 'http://browser.test', fetchImpl });
    const open = setup.tools.find((t) => t.name === 'browser_open')!;
    const res = (await open.run({ url: 'https://leaky.example' })) as { text: string };
    expect(res.text).not.toContain('AKIAABCDEFGHIJKLMNOP');
    expect(res.text).toContain('••redacted-key-shape••');
  });
});

describe('the resume guard (X6: approved acts survive leg boundaries honestly)', () => {
  function restoreService(stateLabel: string): typeof fetch {
    let sessions = 0;
    return (async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).replace('http://browser.test', '');
      if (path === '/session' && init?.method === 'POST') {
        sessions += 1;
        return new Response(JSON.stringify({ sessionId: `bs-${sessions}` }), { status: 200 });
      }
      if (path.endsWith('/goto')) {
        return new Response(JSON.stringify({ url: 'https://app.example/board', title: 'Board', text: 'x', interactables: [{ ref: 'p1', tag: 'button', label: stateLabel }] }), { status: 200 });
      }
      if (path.endsWith('/state')) {
        return new Response(JSON.stringify({ url: 'https://app.example/board', title: 'Board', text: 'x', interactables: [{ ref: 'p1', tag: 'button', label: stateLabel }] }), { status: 200 });
      }
      if (path.endsWith('/act')) {
        return new Response(JSON.stringify({ url: 'https://app.example/board', title: 'Board', text: 'acted', interactables: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;
  }

  it('an unchanged control lets the approved act through after auto-restore', async () => {
    const setup = buildBrowserLabTools({
      browserUrl: 'http://browser.test',
      fetchImpl: restoreService('Add card'),
      restore: { url: 'https://app.example/board', controls: { p1: 'Add card' } },
    });
    const act = setup.tools.find((t) => t.name === 'browser_act')!;
    const res = (await act.run({ ref: 'p1', kind: 'click' })) as { text?: string; error?: string };
    expect(res.error).toBeUndefined();
    expect(res.text).toBe('acted');
  });

  it('a DRIFTED control refuses typed — the human never approved this click', async () => {
    const setup = buildBrowserLabTools({
      browserUrl: 'http://browser.test',
      fetchImpl: restoreService('Delete board'),
      restore: { url: 'https://app.example/board', controls: { p1: 'Add card' } },
    });
    const act = setup.tools.find((t) => t.name === 'browser_act')!;
    const res = (await act.run({ ref: 'p1', kind: 'click' })) as { error: string };
    expect(res.error).toContain('the page has changed since the approval');
    expect(res.error).toContain('Delete board');
  });
});
