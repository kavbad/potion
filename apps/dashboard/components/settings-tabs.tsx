'use client';

// P1-7: settings became four pages; this row makes them one surface.
import Link from 'next/link';
import { usePathname } from 'next/navigation';

const TABS = [
  { href: '/settings/keys', label: 'Keys' },
  { href: '/settings/controls', label: 'Floor & cap' },
  { href: '/settings/frontier', label: 'Frontier' },
  { href: '/settings/billing', label: 'Billing' },
  { href: '/settings/team', label: 'Team' },
  { href: '/settings/audit', label: 'Audit' },
];

export function SettingsTabs() {
  const pathname = usePathname();
  return (
    <nav className="mb-8 flex gap-1 border-b border-[#d9d5cb]">
      {TABS.map((t) => {
        const active = pathname.startsWith(t.href);
        return (
          <Link
            key={t.href}
            href={t.href}
            className={`-mb-px border-b-2 px-3 py-2 text-[13px] transition-colors ${
              active ? 'border-ink font-medium text-ink' : 'border-transparent text-soft hover:text-ink'
            }`}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
