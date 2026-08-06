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
    throw new Error(`API ${res.status}: ${message}`);
  }
  return body as T;
}
