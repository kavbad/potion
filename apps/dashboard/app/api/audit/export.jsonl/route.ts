// Audit export (M4 #34) — JSONL download passthrough. Streams the body
// (never buffers the 92-day window) and preserves Content-Disposition so
// the browser saves the file. Admin-only (enforced server-side).
import { apiUrl, sessionCookieHeader } from '@/lib/api';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const cookie = await sessionCookieHeader();
  const qs = new URL(req.url).search;
  let res: Response;
  try {
    res = await fetch(`${apiUrl()}/api/audit/export.jsonl${qs}`, {
      cache: 'no-store',
      headers: { ...(cookie ? { cookie } : {}) },
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
    'content-type': res.headers.get('content-type') ?? 'application/x-ndjson; charset=utf-8',
  });
  const cd = res.headers.get('content-disposition');
  if (cd) headers.set('content-disposition', cd);
  return new Response(res.body, { status: res.status, headers });
}
