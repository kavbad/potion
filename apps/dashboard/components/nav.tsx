'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

const ITEMS = [
  { href: '/', label: 'Connect keys', step: '1' },
  { href: '/workload', label: 'Your workload', step: '2' },
  { href: '/frontiers', label: 'Frontiers', step: '3' },
  { href: '/playground', label: 'Playground', step: '›' },
  { href: '/policy', label: 'Set a policy', step: '4' },
  { href: '/usage', label: 'Usage & billing', step: '5' },
  { href: '/reports', label: 'Savings', step: '6' },
  { href: '/recipes', label: 'Recipe library', step: '7' },
  { href: '/traces', label: 'Traces', step: '8' },
  { href: '/rubrics', label: 'Rubrics', step: '›' },
  { href: '/leaderboard', label: 'Leaderboard', step: '›' },
  { href: '/settings/audit', label: 'Audit trail', step: '›' },
];

interface MeResponse {
  user: { id: string; email: string; name: string } | null;
  org: { id: string; name: string };
  role: 'admin' | 'member' | 'viewer';
  kind: 'apiKey' | 'session';
}

/** Current user/org + role (M2 #14), fetched from the session. Renders
 * nothing while loading or when signed out (the login page). */
function SessionBadge() {
  const [me, setMe] = useState<MeResponse | null>(null);
  useEffect(() => {
    fetch('/api/auth/me', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((body: MeResponse | null) => setMe(body))
      .catch(() => setMe(null));
  }, []);
  if (!me) return null;
  return (
    <div className="mb-4 rounded-lg border border-line bg-paper px-3 py-3">
      <div className="truncate text-sm font-medium text-ink">{me.user?.email ?? 'api key'}</div>
      <div className="mt-0.5 flex items-center justify-between text-xs text-faint">
        <span className="truncate">{me.org.name}</span>
        <span className="ml-2 rounded bg-accent-soft px-1.5 py-0.5 font-medium text-accent">
          {me.role}
        </span>
      </div>
    </div>
  );
}

export function Nav() {
  const pathname = usePathname();
  return (
    <nav className="flex flex-col gap-1">
      <SessionBadge />
      {ITEMS.map((item) => {
        const active =
          item.href === '/' ? pathname === '/' : pathname.startsWith(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            className={`rounded-md px-3 py-2 text-sm transition-colors ${
              active
                ? 'bg-accent-soft font-medium text-accent'
                : 'text-soft hover:bg-paper hover:text-ink'
            }`}
          >
            <span className="mr-2 text-xs text-faint">{item.step}</span>
            {item.label}
          </Link>
        );
      })}
      {/* M2 #14: sign out (revokes the session server-side, clears the cookie) */}
      <a
        href="/api/auth/logout"
        className="mt-6 rounded-md px-3 py-2 text-sm text-faint transition-colors hover:bg-paper hover:text-soft"
      >
        Sign out
      </a>
    </nav>
  );
}
