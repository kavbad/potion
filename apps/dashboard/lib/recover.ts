// Session recovery for server components — the /api/auth/clear pattern, made
// the default instead of a thing each page remembers.
//
// middleware.ts checks cookie PRESENCE, not validity. That is the right split
// and is not what needs fixing: apps/server is the authority on a session,
// and re-validating on every navigation would put a network call in front of
// every page. The cost is that an expired, revoked, or reset-database cookie
// still looks signed-in to the dashboard — the page renders, calls the API,
// and takes a 401. Every page caught only ApiUnreachable, so that 401
// propagated and Next rendered a 500 on most of the authed surface.
//
// Repeating a try/catch in ~20 files is how the gap reached ~20 files to
// begin with: recovery that lives in the page is recovery the next page can
// forget, and it fails as a 500 rather than as anything anyone notices. So it
// lives in the fetch. Use fetchOrRecover instead of apiFetch for any read
// whose failure would take the page down, and a dead cookie becomes a
// redirect through /api/auth/clear rather than a crash.
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { apiFetch, isSessionExpired, sessionCookieHeader } from './api';

/**
 * Where the visitor was headed — so /api/auth/clear returns them there after
 * signing in rather than dumping them at the root.
 *
 * Both halves come from headers middleware.ts stamps on every request it
 * passes. A server component is given no other way to learn its own URL, and
 * middleware derives these from req.nextUrl and overwrites whatever the
 * client sent, so they cannot be forged. The startsWith guard is the same one
 * /api/auth/clear applies to `to`: a missing header would otherwise put an
 * empty string into a redirect, and a `//` prefix is protocol-relative.
 */
async function currentTarget(): Promise<{ to: string; alreadyCleared: boolean }> {
  const h = await headers();
  const raw = h.get('x-potion-path') ?? '/';
  const path = raw.startsWith('/') && !raw.startsWith('//') ? raw : '/';
  const params = new URLSearchParams(h.get('x-potion-search') ?? '');
  // `cleared` is the loop guard, not part of the destination. It must not be
  // carried back into `to`, or it would survive every round trip and the
  // guard would be permanently tripped for that visitor.
  const alreadyCleared = params.get('cleared') === '1';
  params.delete('cleared');
  const query = params.toString();
  return { to: query === '' ? path : `${path}?${query}`, alreadyCleared };
}

/**
 * Hand a dead session to /api/auth/clear and come back.
 *
 * Never returns — redirect() signals by throwing, which is also why no caller
 * may swallow it (see fetchOrRecover).
 */
export async function recoverSession(): Promise<never> {
  const { to, alreadyCleared } = await currentTarget();
  // Two dead ends that must not become a loop: nothing to clear, or clearing
  // already happened and the cookie is somehow still here. /login is the
  // honest terminus — an open route that makes no authed call, so it cannot
  // bounce back. (In practice the cookie does go, and middleware.ts sends the
  // next request to /login itself; this is the belt to that pair of braces.)
  if (alreadyCleared || (await sessionCookieHeader()) === undefined) redirect('/login');
  redirect(`/api/auth/clear?to=${encodeURIComponent(to)}`);
}

/**
 * apiFetch, plus the one failure a page cannot sensibly render: a session the
 * API no longer honours. Everything else — ApiUnreachable, a 403, a 500 —
 * propagates unchanged, so each page's existing handling still runs.
 *
 * STRICT reads only. A tolerant read (`.catch(() => null)`) must stay on
 * apiFetch: recovery works by throwing Next's redirect signal, and a
 * catch-all would swallow it and render a degraded page to someone who should
 * have been sent to sign in. For the same reason, a page whose catch block
 * does not rethrow needs `unstable_rethrow(e)` at the top of it.
 */
export async function fetchOrRecover<T>(path: string, init?: RequestInit): Promise<T> {
  try {
    return await apiFetch<T>(path, init);
  } catch (e) {
    if (isSessionExpired(e)) await recoverSession();
    throw e;
  }
}
