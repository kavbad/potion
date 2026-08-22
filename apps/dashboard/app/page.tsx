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
import Link from 'next/link';
import { ApiUnreachable, apiFetch, isSessionExpired, sessionCookieHeader } from '@/lib/api';
import { recoverSession } from '@/lib/recover';
import { Landing } from '@/components/landing';
import { SiteShell } from '@/components/site-header';
import { CopyBlock } from '@/components/copy-block';
import { RoutingProof } from '@/components/routing-proof';
import { ServingKeys } from '@/components/serving-keys';
import type { ConnectionResponse } from '@/lib/types';

export const dynamic = 'force-dynamic';

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
        <Landing />
      </SiteShell>
    );
  }

  let conn: ConnectionResponse | null = null;
  let unreachable = false;
  try {
    conn = await apiFetch<ConnectionResponse>('/api/connection');
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
      if (alreadyCleared) return <SiteShell><Landing /></SiteShell>;
      await recoverSession();
    }
    else throw e;
  }

  if (unreachable || !conn) {
    return (
      <div className="max-w-3xl">
        <h1 className="text-2xl font-semibold tracking-tight">Connect &amp; auto-route</h1>
        <div className="mt-6 rounded-lg border border-line bg-panel p-6 text-sm text-soft">
          The Potion API is not reachable. Start <code className="font-mono">apps/server</code>{' '}
          (default port 3000) and reload.
        </div>
      </div>
    );
  }

  const { autoRouting, serving } = conn;
  const readyAll = autoRouting.ready === autoRouting.total;

  return (
    <div className="max-w-3xl space-y-12">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Connect &amp; auto-route</h1>
        <p className="mt-2 text-sm leading-relaxed text-soft">
          Point any OpenAI-compatible client at the endpoint below. Potion reads each request,
          works out what kind of task it is, and serves it from the model — or combination of
          models — measured best for that task under your policy. No provider keys required.
        </p>
      </div>

      {/* 1 + 3 — where, and under what rule */}
      <section className="space-y-5">
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm font-medium text-ink">1 · Point your traffic here</h2>
          {!conn.baseUrlConfigured && (
            <span className="text-xs text-faint">
              derived from this request — set POTION_PUBLIC_URL behind a proxy
            </span>
          )}
        </div>
        <CopyBlock label="Base URL" text={`${conn.baseUrl}/v1`} />
        {conn.snippets ? (
          <>
            <CopyBlock label="curl" text={conn.snippets.curl} />
            <CopyBlock label="Node.js (openai SDK)" text={conn.snippets.openaiNode} />
          </>
        ) : (
          // No policy bound = this org has not set anything up yet, which is
          // exactly the from-scratch case /build exists for. Sending them to
          // the raw policy picker asks them to choose a quality floor before
          // anyone has told them what their workload is.
          <p className="text-sm text-soft">
            Nothing set up yet.{' '}
            <Link href="/build" className="text-accent underline">
              Tell Potion what you&apos;re building
            </Link>{' '}
            and it will pick a starting policy from measured evidence — or{' '}
            <Link href="/policy" className="text-accent underline">
              choose one yourself
            </Link>{' '}
            if you already know what you want.
          </p>
        )}

        {conn.policy && (
          <div className="rounded-lg border border-line bg-paper px-6 py-4">
            <div className="text-xs uppercase tracking-wide text-faint">Your policy</div>
            <p className="mt-1 text-sm text-ink">{conn.policy.description}</p>
            <p className="mt-2 text-xs text-faint">
              <span className="font-mono">{conn.policy.name}</span> · applies to every request on
              your serving keys ·{' '}
              <Link href="/policy" className="text-accent underline">
                change it
              </Link>
            </p>
          </div>
        )}
      </section>

      {/* 2 — with what key */}
      <section className="space-y-5">
        <h2 className="text-sm font-medium text-ink">2 · Your serving key</h2>
        <ServingKeys initial={conn.servingKeys} />
      </section>

      {/* 4 — is it doing anything */}
      <section className="space-y-5">
        <h2 className="text-sm font-medium text-ink">3 · Proof it is routing</h2>
        <RoutingProof />
      </section>

      {/* the standing state: what the switch can route today, and who pays */}
      <section className="space-y-4">
        <h2 className="text-sm font-medium text-ink">What Potion can route today</h2>
        <div className="rounded-xl border border-line bg-panel px-6 py-5">
          <p className="text-sm text-soft">
            <span className="font-medium text-ink">
              {autoRouting.ready} of {autoRouting.total}
            </span>{' '}
            workload types have measured routing on this deployment
            {readyAll ? '.' : ' — the rest ride the default strategy until they are measured.'}
          </p>
          <ul className="mt-4 grid grid-cols-1 gap-x-6 gap-y-1 sm:grid-cols-2">
            {autoRouting.clusters.map((c) => (
              <li key={c.clusterId} className="flex items-center justify-between text-xs">
                <span className={c.ready ? 'text-soft' : 'text-faint'}>{c.name}</span>
                <span
                  className={
                    c.ready
                      ? c.provenance === 'live'
                        ? 'text-emerald-700'
                        : 'text-amber-700'
                      : 'text-faint'
                  }
                >
                  {c.ready ? `${c.pointCount} measured · ${c.provenance}` : 'not measured'}
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-4 border-t border-line pt-3 text-xs leading-relaxed text-faint">
            Only measured points are routable. A model Potion knows about but has not evaluated for
            your kind of work is never selected automatically — that is the whole difference
            between a catalog and a frontier.
          </p>
        </div>

        <div className="rounded-xl border border-line bg-panel px-6 py-5">
          <div className="text-xs uppercase tracking-wide text-faint">Who serves your traffic</div>
          <p className="mt-1 text-sm text-soft">
            Potion, across{' '}
            <span className="font-medium text-ink">{serving.platformProviders.length}</span>{' '}
            providers. You never connect a provider account — that is what lets Potion choose
            across the whole catalogue instead of whichever one account you brought.
          </p>
          {serving.providerMode === 'mock' && (
            <p className="mt-3 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              This deployment is running on built-in MOCK providers — responses are simulated and
              costs are modelled, not billed. Set a provider API key to serve real traffic.
            </p>
          )}
        </div>
      </section>
    </div>
  );
}
