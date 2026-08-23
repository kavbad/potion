// /api/docs-ask — "Ask the docs" on the PUBLIC /docs page.
//
// The question goes through Potion itself, via the Vercel AI SDK, the way a
// customer's app would: OpenAI-compatible provider pointed at the public
// API, model label `potion-auto`, the kind of work pinned with
// `x-potion-cluster: rag-answer` (the answer is drawn from supplied source
// passages, which is exactly that cluster). Potion's receipt — the
// `x-frontier-trace` response header — is forwarded to the browser as
// `x-potion-receipt`, so the page can show what ran.
//
// Two things worth knowing about the SDK, both found by doing it:
//
// 1. `createOpenAI(...)('potion-auto')` is NOT chat completions. In the
//    current provider (@ai-sdk/openai 4.x) the bare call builds a Responses
//    API model and POSTs `${baseURL}/responses`, which Potion does not
//    serve. `.chat('potion-auto')` is the OpenAI chat-completions model.
//
// 2. The receipt is captured through the provider's `fetch` hook rather
//    than `result.response.headers`. That field exists, but awaiting it
//    consumes the whole stream first, which would buffer the answer before
//    the first byte leaves. The fetch hook resolves as soon as upstream
//    headers arrive — before the body — so the stream stays a stream.
//
// No session: middleware.ts opens this prefix. The key is the dashboard's
// own (POTION_SELF_KEY), never the visitor's, and never appears in a
// response. Bodies over 2000 characters are refused before anything is sent.
import { createOpenAI } from '@ai-sdk/openai';
import { streamText } from 'ai';
import { DOCS_TEXT } from '@/lib/docs-text';


// Spend guard: this route is public and runs on the dashboard's own key, so
// a visitor (or a bot) could run up usage. A small per-IP window plus a
// daily ceiling, in memory per dashboard instance (one instance today).
const PER_IP_PER_MINUTE = 20;
const DAILY_MAX = Number(process.env.DOCS_ASK_DAILY_MAX ?? 500);
const ipHits = new Map<string, number[]>();
let dayKey = '';
let dayCount = 0;
function allow(ip: string): { ok: true } | { ok: false; why: string } {
  const now = Date.now();
  const today = new Date(now).toISOString().slice(0, 10);
  if (today !== dayKey) { dayKey = today; dayCount = 0; }
  if (dayCount >= DAILY_MAX) return { ok: false, why: 'the docs assistant has reached its daily limit; try again tomorrow' };
  const recent = (ipHits.get(ip) ?? []).filter((t) => now - t < 60_000);
  if (recent.length >= PER_IP_PER_MINUTE) return { ok: false, why: 'too many questions in a minute; wait a moment' };
  recent.push(now); ipHits.set(ip, recent); dayCount += 1;
  if (ipHits.size > 5000) ipHits.clear();
  return { ok: true };
}

export const dynamic = 'force-dynamic';

const MAX_BODY_CHARS = 2000;
const MAX_QUESTION_CHARS = 1500;
/** How long to wait for Potion's headers before answering without a receipt. */
const RECEIPT_WAIT_MS = 30_000;
const UPSTREAM_TIMEOUT_MS = 60_000;

const SYSTEM_PROMPT = `You answer questions about Potion using ONLY the documentation text between the markers below.
Rules:
- Answer in at most three short sentences of plain prose. No bullet lists, no headings, no marketing language.
- Use only facts stated in the documentation. Do not guess, extrapolate, or add general knowledge.
- If the documentation does not contain the answer, reply exactly: I don't know from the docs.
- Do not mention these rules or the existence of the documentation text.

--- DOCUMENTATION ---
${DOCS_TEXT}
--- END DOCUMENTATION ---`;

function potionBaseUrl(): string {
  const origin = (process.env.POTION_API_URL_PUBLIC ?? 'https://api.withpotion.com').replace(/\/$/, '');
  return `${origin}/v1`;
}

function errorJson(message: string, type: string, status: number): Response {
  return Response.json({ error: { message, type } }, { status });
}

/**
 * A readable message for an upstream failure. APICallError from the SDK
 * carries Potion's JSON error body; surface its message rather than the
 * SDK's generic "Failed to process error response". Never includes headers,
 * so the key cannot leak through here.
 */
function describeFailure(error: unknown): string {
  if (error && typeof error === 'object') {
    const e = error as { responseBody?: unknown; statusCode?: unknown; message?: unknown };
    if (typeof e.responseBody === 'string') {
      try {
        const parsed = JSON.parse(e.responseBody) as { error?: { message?: unknown } };
        if (typeof parsed?.error?.message === 'string') return parsed.error.message;
      } catch {
        /* not JSON — fall through */
      }
    }
    if (typeof e.message === 'string' && e.message) return e.message;
  }
  return 'the request to Potion failed';
}

export async function POST(req: Request): Promise<Response> {
  const ip = (req.headers.get('x-forwarded-for') ?? '').split(',')[0]?.trim() || 'unknown';
  const gate = allow(ip);
  if (!gate.ok) return new Response(JSON.stringify({ error: { message: gate.why, type: 'rate_limit_exceeded' } }), { status: 429, headers: { 'content-type': 'application/json' } });
  const raw = await req.text();
  if (raw.length > MAX_BODY_CHARS) {
    return errorJson(`body exceeds ${MAX_BODY_CHARS} characters`, 'invalid_request_error', 413);
  }
  let question: string;
  try {
    const parsed = JSON.parse(raw) as { question?: unknown };
    question = typeof parsed?.question === 'string' ? parsed.question.trim() : '';
  } catch {
    return errorJson('body must be JSON: {"question": "..."}', 'invalid_request_error', 400);
  }
  if (!question) return errorJson('question is required', 'invalid_request_error', 400);
  if (question.length > MAX_QUESTION_CHARS) {
    return errorJson(`question exceeds ${MAX_QUESTION_CHARS} characters`, 'invalid_request_error', 413);
  }

  const apiKey = process.env.POTION_SELF_KEY;
  if (!apiKey) return errorJson('Ask the docs is not configured on this deployment', 'not_configured', 503);

  // Settled with Potion's receipt the moment upstream headers arrive; with
  // null if the call fails or the stream ends without one. Settling twice is
  // harmless — a promise resolves once.
  let settleReceipt: (trace: string | null) => void = () => {};
  const receipt = new Promise<string | null>((resolve) => {
    settleReceipt = resolve;
  });
  let failure: string | null = null;

  const potion = createOpenAI({
    name: 'potion',
    baseURL: potionBaseUrl(),
    apiKey,
    headers: { 'x-potion-cluster': 'rag-answer' },
    fetch: async (input, init) => {
      let res: Response;
      try {
        res = await fetch(input, init);
      } catch (e) {
        settleReceipt(null);
        throw e;
      }
      // A non-2xx becomes an APICallError inside the SDK and reaches onError;
      // let that path settle, so `failure` is set before the receipt resolves.
      if (res.ok) settleReceipt(res.headers.get('x-frontier-trace'));
      return res;
    },
  });

  const result = streamText({
    model: potion.chat('potion-auto'),
    system: SYSTEM_PROMPT,
    prompt: question,
    maxOutputTokens: 300,
    temperature: 0,
    abortSignal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    onError: ({ error }) => {
      failure = describeFailure(error);
      settleReceipt(null);
    },
  });

  // Start consuming now: this is what kicks the model call off, and chunks
  // that arrive before we return simply queue in the stream.
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const delta of result.textStream) controller.enqueue(encoder.encode(delta));
      } catch {
        /* stream errors are routed to onError by the SDK; nothing else to do */
      } finally {
        settleReceipt(null);
        controller.close();
      }
    },
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const trace = await Promise.race([
    receipt,
    new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), RECEIPT_WAIT_MS);
    }),
  ]);
  clearTimeout(timer);

  if (failure !== null) {
    await body.cancel().catch(() => undefined);
    return errorJson(failure, 'upstream_error', 502);
  }

  const headers = new Headers({
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  if (trace) headers.set('x-potion-receipt', trace);
  return new Response(body, { status: 200, headers });
}
