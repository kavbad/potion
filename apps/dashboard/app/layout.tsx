import type { Metadata } from 'next';
import { Inter, IBM_Plex_Mono } from 'next/font/google';
import './globals.css';
import { Nav } from '@/components/nav';
import { Mark } from '@/components/mark';

const sans = Inter({ subsets: ['latin'], variable: '--font-sans' });
const mono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500'],
  variable: '--font-mono',
});

export const metadata: Metadata = {
  title: 'Potion — pay only for the quality you need',
  description:
    'Potion routes every prompt to the cheapest strategy on the quality-cost frontier.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
      <body className="min-h-screen font-sans">
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
      </body>
    </html>
  );
}
