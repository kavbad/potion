// Server-side API client (SPEC §9: the dashboard talks to apps/server only).
// Used by server components and route handlers. The base URL comes from
// POTION_API_URL (default http://localhost:3000) — the Fastify server.

export function apiUrl(): string {
  return (process.env.POTION_API_URL ?? 'http://localhost:3000').replace(/\/$/, '');
}

/** The session cookie name — must match apps/server SESSION_COOKIE. */
export const SESSION_COOKIE = 'potion_session';

/** Cookie header carrying the caller's Potion session, read from the
 * incoming request (M2 #14: /api/* on the server requires session auth).
 * Undefined outside a request scope or when signed out. */
export async function sessionCookieHeader(): Promise<string | undefined> {
  try {
    const { cookies } = await import('next/headers');
    const store = await cookies();
    const value = store.get(SESSION_COOKIE)?.value;
    return value ? `${SESSION_COOKIE}=${value}` : undefined;
  } catch {
    return undefined; // no request scope (build time, tests)
  }
}

/** fetch() wrapper: never caches (seeded data must always be fresh), throws
 * ApiUnreachable when the Fastify server is down so pages can render a
 * friendly empty state instead of a 500. */
export class ApiUnreachable extends Error {
  constructor(url: string, cause?: unknown) {
    super(`Potion API unreachable at ${url} — is apps/server running?`);
    this.name = 'ApiUnreachable';
    this.cause = cause;
  }
}

/**
 * A non-2xx response from the API, carrying the status so callers can branch
 * on it. Previously every failure was a bare Error whose only distinguishing
 * feature was a message string — so the one case a page genuinely must treat
 * differently, a 401 from a cookie the server no longer honours, was
 * indistinguishable from a real fault and crashed the page instead.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(`API ${status}: ${message}`);
    this.name = 'ApiError';
  }
}

/**
 * A session the API will not honour — the case a page recovers from by
 * clearing the cookie and sending the visitor back through sign-in.
 *
 * 401 and ONLY 401. The two statuses look alike and mean opposite things
 * here: apps/server answers 401 when it could resolve no auth context at all
 * (auth.ts dashboardAuthHook — an expired, revoked, or reset-database
 * cookie), and 403 when it resolved the session fine and the caller's role or
 * api-key scope is simply below what the route wants (auth.ts requireRole).
 * Clearing the cookie on a 403 would sign out a perfectly valid session
 * because a member opened an admin-only page — so the recovery path must not
 * treat the two the same. Use isForbidden for that case; it is a message to
 * render, not a credential to throw away.
 */
export function isSessionExpired(e: unknown): boolean {
  return e instanceof ApiError && e.status === 401;
}

/** Signed in, but this role or api-key scope may not have it. Never a reason
 * to clear the cookie — see isSessionExpired. */
export function isForbidden(e: unknown): boolean {
  return e instanceof ApiError && e.status === 403;
}

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const url = `${apiUrl()}${path}`;
  const cookie = await sessionCookieHeader();
  let res: Response;
  try {
    res = await fetch(url, {
      cache: 'no-store',
      ...init,
      headers: { ...(cookie ? { cookie } : {}), ...(init?.headers ?? {}) },
    });
  } catch (cause) {
    throw new ApiUnreachable(url, cause);
  }
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const message =
      body && typeof body === 'object' && 'error' in body
        ? String((body as { error: { message?: string } }).error?.message ?? res.statusText)
        : res.statusText;
    throw new ApiError(res.status, message);
  }
  return body as T;
}
