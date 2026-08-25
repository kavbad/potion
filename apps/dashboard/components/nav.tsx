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

/**
 * THE WHOLE JOB, and nothing else (operator, 2026-08-22): get the key, know
 * how to use it, see the value. Sixteen nav items were a control panel
 * handed to someone who wanted a key. Three remain; Docs is a link, not a
 * destination.
 */
const PRIMARY = [
  { href: '/', label: 'Home', hint: 'Your key, one line, a request, a receipt' },
  { href: '/try', label: 'Try a request', hint: 'Send anything; see what Potion chose and why' },
  { href: '/usage', label: 'Usage & savings', hint: 'What you spent, what you would have spent' },
  { href: '/settings/keys', label: 'Settings', hint: 'Keys, controls, frontier, billing, audit' },
  { href: '/settings/team', label: 'Team', hint: 'Members and invites' },
  { href: '/docs', label: 'Docs', hint: 'Quickstart and API reference' },
];

/** Instruments. Real, reachable, and deliberately out of the way.
 * (2026-08-24 surface review: /policy merged into Settings · Controls;
 * /frontiers — the measured evidence itself — was reachable from nowhere,
 * which was a discoverability bug, not restraint.) */
const ADVANCED = [
  { href: '/build', label: 'Help me choose a policy' },
  { href: '/frontiers', label: 'Frontiers (the evidence)' },
  { href: '/reports', label: 'Savings report' },
  { href: '/traces', label: 'Receipts (traces)' },
  { href: '/settings/audit', label: 'Audit trail' },
  { href: '/support', label: 'Support' },
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
      <div className="mb-6 border-b border-[#d9d5cb] pb-4">
        <div className="truncate text-[13px] text-ink">{me.user?.email ?? 'api key'}</div>
        <div className="mt-1 truncate font-mono text-[10px] uppercase tracking-[0.14em] text-faint">
          {me.org.name} · {me.role}
        </div>
      </div>

      {PRIMARY.map((item) => {
        const active = isActive(pathname, item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            title={item.hint}
            className={`-ml-3 border-l-2 px-3 py-1.5 text-[14px] transition-colors ${
              active ? 'border-ink text-ink' : 'border-transparent text-soft hover:text-ink'
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
