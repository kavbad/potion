'use client';
// P1-5: the signed-in shell on a phone. The sidebar disappears below md and
// this bar takes over — mark, wordmark, one Menu button, the same Nav in a
// drawer. Closes itself on navigation so a tapped link feels like a link.
import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { Mark } from '@/components/mark';
import { Nav } from '@/components/nav';

export function MobileBar() {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  useEffect(() => setOpen(false), [pathname]);

  return (
    <div className="sticky top-0 z-40 border-b border-[#d9d5cb] bg-[#f4f2ec]/95 backdrop-blur md:hidden">
      <div className="flex items-center justify-between px-4 py-3">
        <a href="/" className="flex items-center gap-2">
          <Mark className="h-5 w-5 text-accent" />
          <span className="text-lg font-semibold tracking-tight text-ink">Potion</span>
        </a>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label="Menu"
          className="border border-[#d9d5cb] px-3 py-1.5 text-[12px] font-medium text-soft hover:border-ink hover:text-ink"
        >
          {open ? 'Close' : 'Menu'}
        </button>
      </div>
      {open && (
        <div className="border-t border-[#d9d5cb] px-6 pb-6 pt-4">
          <Nav />
        </div>
      )}
    </div>
  );
}
