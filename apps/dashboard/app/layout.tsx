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
import { ChromeSwitch } from '@/components/chrome-switch';
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
  metadataBase: new URL((process.env.POTION_APP_URL ?? 'https://withpotion.com').replace(/\/$/, '')),
  title: 'Potion — The Compiler for Inference',
  description:
    'You set the quality bar. Potion measures every model on your actual work, then compiles the cheapest way to clear it — request by request, with a receipt on every answer. OpenAI-compatible.',
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Cookie PRESENCE only — the API re-validates every forwarded call. The
  // per-route chrome decision is made on the client by ChromeSwitch (see
  // its header for why it cannot be made here).
  const signedIn = (await sessionCookieHeader()) !== undefined;
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
      <body className="min-h-screen font-sans">
        <ChromeSwitch signedIn={signedIn}>{children}</ChromeSwitch>
      </body>
    </html>
  );
}
