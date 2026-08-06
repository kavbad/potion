// Proxy helper for route handlers: forward the request to apps/server and
// relay status + JSON verbatim. Keeps the browser same-origin (no CORS, no
// leaking POTION_API_URL) while the dashboard stays a thin shell. The
// caller's session cookie is forwarded (M2 #14: /api/* requires session auth).
import { NextResponse } from 'next/server';
import { apiUrl, sessionCookieHeader } from './api';

export async function proxyJson(
  path: string,
  init: { method: string; body?: unknown },
): Promise<NextResponse> {
  const url = `${apiUrl()}${path}`;
  const cookie = await sessionCookieHeader();
  let res: Response;
  try {
    res = await fetch(url, {
      method: init.method,
      cache: 'no-store',
      headers: {
        ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(cookie ? { cookie } : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
  } catch {
    return NextResponse.json(
      {
        error: {
          message: `Potion API unreachable at ${apiUrl()} — start apps/server first.`,
          type: 'api_unreachable',
        },
      },
      { status: 502 },
    );
  }
  const body: unknown = await res.json().catch(() => null);
  return NextResponse.json(body, { status: res.status });
}
