// / — CONNECT & AUTO-ROUTE. The front door (SERVING-ROADMAP S1).
//
// What used to be here was "Connect keys" — bring your own provider keys —
// which made BYOK read as the price of entry. It never was: an org with no
// keys of its own has always been served from Potion's platform keys, across
// every provider at once. The old framing both understated the product and
// capped it, since a customer's own key can only reach the models that
// customer's account can reach.
//
// BYOK is not offered (operator decision, 2026-08-17). Potion serves every
// request from its own provider keys — which is also the thing that lets it
// route across the whole catalogue rather than the one account a customer
// happened to bring.
//
// So this page answers the four questions someone actually has, in order:
//   1. Where do I point traffic?          → endpoint + snippets
//   2. With what key?                     → issue/list, honest about the hash
//   3. Under what rule?                   → the bound policy, in a sentence
//   4. Is it actually doing anything?     → the routing proof table
//
// (3) and (4) are the ones that were unanswerable before. A policy was raw
// JSON shown once during setup, and whether the auto-switch had done any work
// was knowable only by catching a response header live.
import { ApiUnreachable, apiFetch, isSessionExpired, sessionCookieHeader } from '@/lib/api';
import { recoverSession } from '@/lib/recover';
import { Landing } from '@/components/landing';
import { SiteShell } from '@/components/site-header';
import { RouterHome } from '@/components/router-home';
import type { ConnectionResponse, RoutingActivityResponse } from '@/lib/types';
import type { Metadata } from 'next';

export const dynamic = 'force-dynamic';

/** '/' IS THE CANONICAL LANDING (operator, 2026-09-05). This route is
 *  session-aware — signed out it is the landing, signed in it is Connect —
 *  but a crawler is always signed out, so what Google indexes here is the
 *  landing, and this is the URL people link to. /home renders the same page
 *  for session-proof sharing and points its canonical here. Without this the
 *  two competed and Google chose between them. */
export const metadata: Metadata = {
  alternates: { canonical: '/' },
};

/** The end of a session is SAID, never a silent teleport (2026-08-28: the
 * operator's session was cleared mid-flow and the landing rendered with no
 * explanation — "it signed me out" should never be a mystery). */
function SessionEndedNote() {
  return (
    <div className="border-b border-[#d9d5cb] bg-[#fbfaf7] px-4 py-2.5 text-center text-[13.5px] text-soft" data-testid="session-ended">
      Your session ended, so you were signed out — nothing was lost.{' '}
      <a href="/login" className="font-medium text-accent underline">Sign in again →</a>
    </div>
  );
}

export default async function ConnectPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const alreadyCleared = (await searchParams).cleared === '1';
  // '/' is the only route that serves two different pages. Signed out it is
  // the landing page (middleware.ts opens this path, and ONLY this path, by
  // exact match); signed in it is the connect surface below. The landing page
  // makes no API calls, so nothing here can leak to an anonymous visitor even
  // if this check were wrong — /api/connection 401s without a session.
  if ((await sessionCookieHeader()) === undefined) {
    return (
      <SiteShell>
        {alreadyCleared ? <SessionEndedNote /> : null}
        <Landing />
      </SiteShell>
    );
  }

  let conn: ConnectionResponse | null = null;
  let activity: RoutingActivityResponse | null = null;
  let unreachable = false;
  try {
    // ONE retry before believing a 401 (2026-08-28 incident: a fresh,
    // working session was cleared by a single racy 401 on this read —
    // mid-onboarding, the operator was silently dumped on the landing page.
    // A transient rejection must not cost the visitor their session; only a
    // 401 that REPEATS is treated as a dead cookie).
    try {
      conn = await apiFetch<ConnectionResponse>('/api/connection');
    } catch (first) {
      if (!isSessionExpired(first)) throw first;
      await new Promise((r) => setTimeout(r, 300));
      conn = await apiFetch<ConnectionResponse>('/api/connection');
    }
    activity = await apiFetch<RoutingActivityResponse>('/api/routing-activity?limit=8').catch(() => null);
  } catch (e) {
    if (e instanceof ApiUnreachable) unreachable = true;
    // A cookie the API no longer honours — expired, revoked, or from a reset
    // database. middleware.ts checks PRESENCE only (deliberately: the API is
    // the authority), so a stale cookie gets this far and used to crash the
    // front door with a 401 instead of offering a way back in. Send it to be
    // cleared and come straight back, so the dead cookie is gone instead of
    // poisoning every later navigation.
    //
    // '/' is the one route that can answer this without needing the visitor
    // signed in again: signed out it IS the landing page, so once the cookie
    // is gone there is something to render. That is why the `cleared` guard
    // renders here instead of redirecting on to /login the way
    // recoverSession does for every other page.
    else if (isSessionExpired(e)) {
      if (alreadyCleared) return <SiteShell><SessionEndedNote /><Landing /></SiteShell>;
      await recoverSession();
    }
    else throw e;
  }

  if (unreachable || !conn) {
    return (
      <div className="max-w-3xl">
        <h1 className="text-2xl font-medium tracking-tight">Potion</h1>
        <div className="mt-6 border border-[#d9d5cb] p-6 text-sm text-soft">
          The Potion API is not reachable. Start <code className="font-mono">apps/server</code>{' '}
          (default port 3000) and reload.
        </div>
      </div>
    );
  }

  return <RouterHome conn={conn} initialActivity={activity} />;
}
