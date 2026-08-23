/**
 * The origin a browser should be sent back to. Behind the production proxy
 * `req.url` is the CONTAINER's address (localhost:3001) — redirecting there
 * sent a real sign-in to the partner's own machine (Phase D rehearsal,
 * 2026-08-21) and sign-out to localhost (operator, 2026-08-22). Prefer the
 * configured public URL, then the proxy's forwarded headers, then the
 * request itself (local dev). Every redirect in the dashboard goes through
 * this — never `new URL(path, req.url)`.
 */
export function publicOrigin(req: Request): string {
  const configured = process.env.POTION_APP_URL?.replace(/\/$/, '');
  if (configured) return configured;
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host');
  const proto = req.headers.get('x-forwarded-proto') ?? 'http';
  return host ? `${proto}://${host}` : new URL(req.url).origin;
}
