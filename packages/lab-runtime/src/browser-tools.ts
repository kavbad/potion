// X6 (2026-08-30) — the `browser` builtin superpower: a REAL browser hand,
// never a fetch tool dressed up as one. The service (deploy/browser) runs
// headless Chromium with a per-request SSRF guard and hard caps; THIS layer
// owns the permission law:
//   · browser_open / browser_read are READS — loading a page in a fresh,
//     cookie-less context and reading its text/controls is the web-fetch
//     class of observation (external: false);
//   · browser_act — click, type, select, press — is an EXTERNAL ACTION,
//     every time (external: true, fail-closed): "click submit on someone
//     else's site" gates at the pore until that kind of action earns
//     autonomy. No safe-click heuristics, no form/no-form guessing — an
//     act is an act.
// Page text is UNTRUSTED DATA (it rides tool results, never instructions)
// and passes the key-shape redactor before entering model context. The
// session is leg-scoped: opened lazily on first use, closed by the leg's
// close hook (runs are durable, connections are not — the Step 10 law).
import type { LabTool } from './loop.js';
import { redactKeyShapes } from './code-tools.js';

export interface BrowserToolDeps {
  browserUrl: string;
  /** Injected for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** X6 resume law: a leg-scoped session dies with its leg, but an APPROVED
   * act resumes in a NEW leg. The handler derives the last recorded page
   * (url + control labels) from the run's own steps; the first act after an
   * auto-restore is guarded — the target control's label must still match
   * what the human was shown, or the act refuses typed and the model must
   * re-read (the pore then re-asks on the fresh state). */
  restore?: { url: string; controls: Record<string, string> };
}

export const BROWSER_LIMITS = {
  CALL_TIMEOUT_MS: 45_000,
  MAX_TEXT_CHARS: 16_000, // what enters model context (the service clips higher)
} as const;

interface PageState {
  url?: string;
  title?: string;
  text?: string;
  truncated?: boolean;
  interactables?: Array<Record<string, unknown>>;
  error?: string;
}

function clipState(state: PageState): PageState {
  const text = state.text !== undefined ? redactKeyShapes(state.text) : undefined;
  return {
    ...state,
    ...(text !== undefined
      ? {
          text: text.length > BROWSER_LIMITS.MAX_TEXT_CHARS
            ? `${text.slice(0, BROWSER_LIMITS.MAX_TEXT_CHARS)}\n…[truncated for context]`
            : text,
        }
      : {}),
  };
}

export interface BrowserLegSetup {
  tools: LabTool[];
  /** Close the leg's browser session (idempotent, never throws). */
  close: () => Promise<void>;
}

export function buildBrowserLabTools(deps: BrowserToolDeps): BrowserLegSetup {
  const fetchFn = deps.fetchImpl ?? fetch;
  let sessionId: string | null = null;
  // True while the session was silently re-established from the record —
  // cleared by any explicit open/read (the model has then seen fresh state).
  let restoredPending = false;
  // The last page state the MODEL saw (clipped + redacted) — what the
  // pore's question can honestly name a control from (2026-08-31: an
  // approval that reads "ref p8" tells the human nothing).
  let lastSeen: PageState | null = null;
  const seen = (state: PageState): PageState => {
    if (state.error === undefined) lastSeen = state;
    return state;
  };

  const call = async (path: string, init?: RequestInit): Promise<PageState> => {
    try {
      const res = await fetchFn(`${deps.browserUrl}${path}`, {
        ...init,
        signal: AbortSignal.timeout(BROWSER_LIMITS.CALL_TIMEOUT_MS),
      });
      const body = (await res.json().catch(() => ({ error: `browser service returned ${res.status}` }))) as PageState;
      return body;
    } catch (e) {
      return { error: `browser service unreachable: ${e instanceof Error ? e.name : 'error'}` };
    }
  };

  const ensureSession = async (): Promise<string | { error: string }> => {
    if (sessionId !== null) return sessionId;
    const res = await call('/session', { method: 'POST' });
    const id = (res as { sessionId?: string }).sessionId;
    if (typeof id !== 'string') return { error: res.error ?? 'could not open a browser session' };
    sessionId = id;
    return id;
  };

  /** Re-establish the recorded page for a resumed leg. */
  const restoreSession = async (): Promise<string | { error: string }> => {
    if (sessionId !== null) return sessionId;
    if (deps.restore === undefined) return { error: 'no page is open — browser_open first' };
    const sid = await ensureSession();
    if (typeof sid !== 'string') return sid;
    const nav = await call(`/session/${sid}/goto`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: deps.restore.url }),
    });
    if (nav.error !== undefined) return { error: `could not restore the page after resume: ${nav.error}` };
    restoredPending = true;
    return sid;
  };

  const tools: LabTool[] = [
    {
      name: 'browser_open',
      description:
        'Open a URL in the run’s real browser session (JavaScript executes; a fresh, cookie-less context). ' +
        'Returns the page: url, title, readable text, and interactable controls with refs (p1, p2, …) for browser_act.',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: 'The http(s) URL to open.' } },
        required: ['url'],
      },
      external: false,
      run: async (input: unknown): Promise<unknown> => {
        const url = (input as { url?: unknown } | null)?.url;
        if (typeof url !== 'string' || url.trim() === '') return { error: 'url is required' };
        const sid = await ensureSession();
        if (typeof sid !== 'string') return sid;
        restoredPending = false; // an explicit open IS fresh state
        return seen(clipState(await call(`/session/${sid}/goto`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ url: url.trim() }),
        })));
      },
    },
    {
      name: 'browser_read',
      description: 'Re-read the current page state (after a page changed itself, or to refresh the control refs).',
      parameters: { type: 'object', properties: {} },
      external: false,
      run: async (): Promise<unknown> => {
        const sid = await restoreSession();
        if (typeof sid !== 'string') return sid;
        restoredPending = false; // the model sees fresh state now
        return seen(clipState(await call(`/session/${sid}/state`)));
      },
    },
    {
      name: 'browser_act',
      description:
        'Act on the open page: {ref, kind: click|type|select|press, text?}. ref is a p<N> id from the page state; ' +
        'type/select/press need text (the input text, the option label, or the key). ' +
        'Every act on a page is an external action — it asks the operator first until that kind of action earns autonomy. ' +
        'Returns the page state after the act.',
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: 'The control’s ref from the page state, e.g. "p3".' },
          kind: { type: 'string', enum: ['click', 'type', 'select', 'press'] },
          text: { type: 'string', description: 'For type: the text. For select: the option label. For press: the key (e.g. Enter).' },
        },
        required: ['ref', 'kind'],
      },
      // THE LAW: driving someone else's UI is acting on the world.
      external: true,
      describeAction: (input: unknown): string | null => {
        const i = (input ?? {}) as { ref?: unknown; kind?: unknown; text?: unknown };
        if (typeof i.ref !== 'string' || typeof i.kind !== 'string') return null;
        const control = (lastSeen?.interactables ?? []).find((c) => c.ref === i.ref) as { label?: unknown; tag?: unknown } | undefined;
        const label = typeof control?.label === 'string' && control.label.trim() !== '' ? control.label.trim().slice(0, 60) : null;
        // An unknown control gets the raw question — never invent a label.
        if (label === null) return null;
        const tag = typeof control?.tag === 'string' ? ` (${control.tag})` : '';
        const where = typeof lastSeen?.url === 'string' ? ` on ${lastSeen.url.slice(0, 80)}` : '';
        const verb =
          i.kind === 'click' ? 'click'
          : i.kind === 'type' ? `type ${typeof i.text === 'string' ? `'${i.text.slice(0, 40)}'` : 'text'} into`
          : i.kind === 'select' ? `select ${typeof i.text === 'string' ? `'${i.text.slice(0, 40)}'` : 'an option'} in`
          : `press ${typeof i.text === 'string' ? i.text.slice(0, 20) : 'a key'} in`;
        return `${verb} \u201c${label}\u201d${tag}${where}`;
      },
      run: async (input: unknown): Promise<unknown> => {
        const sid = await restoreSession();
        if (typeof sid !== 'string') return sid;
        const i = (input ?? {}) as { ref?: unknown; kind?: unknown; text?: unknown };
        if (typeof i.ref !== 'string' || typeof i.kind !== 'string') return { error: 'ref and kind are required' };
        if (restoredPending) {
          // THE RESUME GUARD: the approved click must land on the control
          // the human was shown. The page was silently re-established, so
          // verify the target's label against the recorded one; drift is a
          // typed refusal — the model re-reads, and the pore re-asks on
          // what the page ACTUALLY says now.
          const state = await call(`/session/${sid}/state`);
          const found = (state.interactables ?? []).find((c) => c.ref === i.ref) as { label?: string } | undefined;
          const expected = deps.restore?.controls[i.ref];
          // FAIL-CLOSED both ways (final-pass review, 2026-08-30): a ref the
          // recorded page never showed has no label to verify against — the
          // human could not have seen what they were approving. Refuse it
          // the same as drift; the model re-reads and the pore re-asks.
          if (expected === undefined) {
            return {
              error: `control ${i.ref} was not on the page the approval was given for — read the page and act on what it says now.`,
            };
          }
          if (found?.label !== expected) {
            return {
              error: `the page has changed since the approval — control ${i.ref} is ${found?.label !== undefined ? `now '${String(found.label).slice(0, 80)}'` : 'gone'}, was '${expected.slice(0, 80)}'. Read the page and act on what it says now.`,
            };
          }
          restoredPending = false;
        }
        return seen(clipState(await call(`/session/${sid}/act`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ref: i.ref, kind: i.kind, ...(typeof i.text === 'string' ? { text: i.text } : {}) }),
        })));
      },
    },
  ];

  return {
    tools,
    close: async () => {
      if (sessionId === null) return;
      const sid = sessionId;
      sessionId = null;
      await call(`/session/${sid}`, { method: 'DELETE' }).catch(() => {});
    },
  };
}
