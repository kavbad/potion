// Playground chat (M4 #31) — SSE streaming proxy. Unlike proxyJson this
// must NOT buffer: the response body is piped straight through so token
// chunks reach the browser as they arrive. The session cookie is forwarded;
// x-frontier-trace travels back verbatim (the client badges provenance from
// the meta chunk, but the header is the proof).
import { apiUrl, sessionCookieHeader } from '@/lib/api';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const cookie = await sessionCookieHeader();
  const body = await req.text();
  let res: Response;
  try {
    res = await fetch(`${apiUrl()}/api/playground/chat`, {
      method: 'POST',
      cache: 'no-store',
      headers: {
        'content-type': 'application/json',
        ...(cookie ? { cookie } : {}),
      },
      body,
    });
  } catch {
    return Response.json(
      {
        error: {
          message: `Potion API unreachable at ${apiUrl()} — start apps/server first.`,
          type: 'api_unreachable',
        },
      },
      { status: 502 },
    );
  }
  const headers = new Headers({
    'content-type': res.headers.get('content-type') ?? 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
  });
  const trace = res.headers.get('x-frontier-trace');
  if (trace) headers.set('x-frontier-trace', trace);
  return new Response(res.body, { status: res.status, headers });
}
