'use client';

// THE APP SHELL NAV.
//
// It used to be a flat list of 13 links, every one of them visible to a
// brand-new signed-in user AND to a signed-out visitor on the login page.
// Most of those pages are operator instrumentation — frontiers, rubrics,
// traces, the leaderboard — and putting them beside the two pages a customer
// actually needs made the product read as a control panel for something they
// had not bought yet.
//
// Now: a short primary set that maps to what someone actually does (start →
// connect → tune → watch → integrate), and everything else folded behind one
// disclosure that stays shut until asked. Signed out, the nav renders nothing
// at all — a login page should not advertise nine tools you cannot open.
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

/** What a customer does, in the order they do it. */
const PRIMARY = [
  { href: '/build', label: 'Start here', hint: 'Describe what you are making' },
  { href: '/', label: 'Connect', hint: 'Endpoint, key, and proof it routed' },
  { href: '/policy', label: 'Policy', hint: 'What to optimise for' },
  { href: '/usage', label: 'Usage', hint: 'Spend and requests' },
  { href: '/settings/keys', label: 'API keys', hint: 'Tokens for your code and CI' },
  { href: '/docs', label: 'Docs', hint: 'Quickstart and API reference' },
];

/** Instrumentation. Real, and not what step one looks like. */
const ADVANCED = [
  { href: '/frontiers', label: 'Frontiers' },
  { href: '/workload', label: 'Your workload' },
  { href: '/reports', label: 'Savings' },
  { href: '/recipes', label: 'Recipe library' },
  { href: '/traces', label: 'Traces' },
  { href: '/playground', label: 'Playground' },
  { href: '/rubrics', label: 'Rubrics' },
  { href: '/leaderboard', label: 'Leaderboard' },
  { href: '/settings/provider-keys', label: 'Provider keys' },
  { href: '/settings/audit', label: 'Audit trail' },
];

interface MeResponse {
  user: { id: string; email: string; name: string } | null;
  org: { id: string; name: string };
  role: 'admin' | 'member' | 'viewer';
  kind: 'apiKey' | 'session';
}

function isActive(pathname: string, href: string): boolean {
  return href === '/' ? pathname === '/' : pathname.startsWith(href);
}

export function Nav() {
  const pathname = usePathname();
  const [me, setMe] = useState<MeResponse | null>(null);
  const [loaded, setLoaded] = useState(false);
  // Open the drawer automatically when the current page lives inside it, so a
  // deep link never lands somewhere the nav claims does not exist.
  const [openAdvanced, setOpenAdvanced] = useState(() =>
    ADVANCED.some((i) => pathname.startsWith(i.href)),
  );

  useEffect(() => {
    fetch('/api/auth/me', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((body: MeResponse | null) => setMe(body))
      .catch(() => setMe(null))
      .finally(() => setLoaded(true));
  }, []);

  // Signed out (or still checking): render nothing. The login page is a door,
  // not a dashboard.
  if (!loaded || !me) return null;

  return (
    <nav className="flex flex-col gap-1">
      <div className="mb-5 rounded-lg border border-line bg-paper px-3 py-3">
        <div className="truncate text-sm font-medium text-ink">{me.user?.email ?? 'api key'}</div>
        <div className="mt-0.5 flex items-center justify-between text-xs text-faint">
          <span className="truncate">{me.org.name}</span>
          <span className="ml-2 rounded bg-accent-soft px-1.5 py-0.5 font-medium text-accent">
            {me.role}
          </span>
        </div>
      </div>

      {PRIMARY.map((item) => {
        const active = isActive(pathname, item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            title={item.hint}
            className={`rounded-md px-3 py-2 text-sm transition-colors ${
              active
                ? 'bg-accent-soft font-medium text-accent'
                : 'text-soft hover:bg-paper hover:text-ink'
            }`}
          >
            {item.label}
          </Link>
        );
      })}

      <button
        type="button"
        onClick={() => setOpenAdvanced((v) => !v)}
        className="mt-6 flex items-center justify-between rounded-md px-3 py-2 text-xs uppercase tracking-wide text-faint transition-colors hover:text-soft"
        aria-expanded={openAdvanced}
      >
        <span>Advanced</span>
        <span aria-hidden className="text-[10px]">{openAdvanced ? '▾' : '▸'}</span>
      </button>
      {openAdvanced && (
        <div className="flex flex-col gap-1">
          {ADVANCED.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={`rounded-md px-3 py-1.5 text-sm transition-colors ${
                isActive(pathname, item.href)
                  ? 'bg-accent-soft font-medium text-accent'
                  : 'text-faint hover:bg-paper hover:text-soft'
              }`}
            >
              {item.label}
            </Link>
          ))}
        </div>
      )}

      <a
        href="/api/auth/logout"
        className="mt-8 rounded-md px-3 py-2 text-sm text-faint transition-colors hover:bg-paper hover:text-soft"
      >
        Sign out
      </a>
    </nav>
  );
}
