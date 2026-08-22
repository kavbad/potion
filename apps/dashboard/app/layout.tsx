// ROOT LAYOUT — chrome is chosen by session, because the product has two
// audiences and one of them has not signed in.
//
// This used to wrap EVERY route in the 240px operator sidebar, including the
// login page, where the nav deliberately renders nothing — so a signed-out
// visitor met an empty rail and a logo. Now the sidebar is the signed-in
// frame only; public pages (landing, docs, sign-in) bring their own header
// via components/site-header.tsx.
//
// Presence of the cookie is the only test made here, exactly as middleware.ts
// does it. It decides which chrome to draw and nothing else — the API server
// re-validates the session on every forwarded call, so a forged cookie buys a
// sidebar and no data.
import type { Metadata, Viewport } from 'next';
import { IBM_Plex_Mono, Inter } from 'next/font/google';
import './globals.css';
import { Nav } from '@/components/nav';
import { Mark } from '@/components/mark';
import { headers } from 'next/headers';
import { sessionCookieHeader } from '@/lib/api';

const sans = Inter({ subsets: ['latin'], variable: '--font-sans' });
const mono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500'],
  variable: '--font-mono',
});

/** Browser chrome tints to the paper — the glaze reaches the toolbar. */
export const viewport: Viewport = {
  themeColor: '#faf9f6',
};

export const metadata: Metadata = {
  metadataBase: new URL((process.env.POTION_APP_URL ?? 'https://app.withpotion.com').replace(/\/$/, '')),
  title: 'Potion — the right model for every request',
  description:
    'Potion reads each prompt, works out what kind of work it is, and serves it from the strategy measured best for that work under a policy you set. OpenAI-compatible.',
};

function AppShell({ children }: { children: React.ReactNode }) {
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

/** Routes that are signed-out surfaces by nature, whatever cookie is present. */
function isSignedOutSurface(path: string): boolean {
  // /home is the landing page at a stable URL — public regardless of session,
  // so it must never wear the app sidebar even for a signed-in operator
  // reviewing it.
  return path.startsWith('/login') || path.startsWith('/home') || path.startsWith('/hero-lab') || path.startsWith('/research');
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const path = (await headers()).get('x-potion-path') ?? '';
  // Cookie PRESENCE, the same test middleware.ts makes — but presence is not
  // validity. A cookie the API no longer honours (expired, revoked, database
  // reset) still looks signed-in here, which is why the path matters too: a
  // stale session redirects to /login, and /login wearing the operator
  // sidebar is the one place that mistake is visible. It never wears it.
  const signedIn = (await sessionCookieHeader()) !== undefined && !isSignedOutSurface(path);
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
      <body className="min-h-screen font-sans">
        {signedIn ? <AppShell>{children}</AppShell> : children}
      </body>
    </html>
  );
}
