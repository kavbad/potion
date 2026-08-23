import { Nav } from '@/components/nav';
import { Mark } from '@/components/mark';

/** The signed-in frame, in the lab style: paper, a hairline rail, the product nav. Chosen per page by ChromeSwitch. */
export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen bg-[#f4f2ec]">
      <aside className="w-60 shrink-0 border-r border-[#d9d5cb] px-6 py-8">
        <a href="/" className="mb-10 flex items-center gap-2">
          <Mark className="h-5 w-5 text-accent" />
          <span className="text-lg font-semibold tracking-tight text-ink">Potion</span>
        </a>
        <Nav />
      </aside>
      <main className="min-w-0 flex-1 px-10 py-10 lg:px-14">{children}</main>
    </div>
  );
}
