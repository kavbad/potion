// ROOT LAYOUT — fonts, metadata, the html/body skeleton. Chrome (the
// signed-in sidebar vs a bare public page) is chosen in app/template.tsx,
// because the product has two audiences and one of them has not signed in.
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

export default function RootLayout({ children }: { children: React.ReactNode }) {
  // The app-shell-or-bare decision lives in app/template.tsx, NOT here: a
  // layout persists across client-side navigations, so a decision made on a
  // public page (/research, /docs) would be frozen when the reader then
  // clicked into the app — or the reverse — and the page arrived wearing the
  // wrong chrome. A template re-renders on every navigation.
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
      <body className="min-h-screen font-sans">{children}</body>
    </html>
  );
}
