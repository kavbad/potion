import { Nav } from '@/components/nav';
import { Mark } from '@/components/mark';

/** The signed-in frame: 240px rail with the product nav. Chosen per page by app/template.tsx. */
export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen">
      <aside className="w-60 shrink-0 border-r border-line bg-panel px-6 py-10">
        <a href="/" className="mb-10 block">
          <div className="flex items-center gap-2">
            <Mark className="h-5 w-5 text-accent" />
            <span className="text-xl font-semibold tracking-tight text-ink">Potion</span>
          </div>
          <div className="mt-1 text-xs leading-relaxed text-faint">
            Pay only for the quality you need.
          </div>
        </a>
        <Nav />
      </aside>
      <main className="flex-1 px-12 py-12">{children}</main>
    </div>
  );
}
