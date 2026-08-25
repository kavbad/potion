'use client';

// CHROME SWITCH — chooses the signed-in rail or a bare public page for the
// route being shown RIGHT NOW. It runs on the client and reads the pathname
// directly, because a server-side decision (root layout, or a template
// reading request headers) proved unreliable across client-side
// navigations: the chrome of the first page stuck to every page after it.
//
// `signedIn` is cookie presence, read once by the root layout. That is safe
// to freeze: signing in and out are full-page navigations, so the layout is
// re-read exactly when it changes.
import { usePathname } from 'next/navigation';
import { AppShell } from '@/components/app-shell';

/** Routes that are signed-out surfaces by nature, whatever cookie is present.
 * /terms, /privacy and /status render their own SiteShell — without this
 * entry a signed-in visitor got the app rail wrapped around the public
 * chrome (double chrome, found in the 2026-08-24 surface review). */
export function isSignedOutSurface(path: string): boolean {
  return (
    path.startsWith('/login') || path.startsWith('/home') ||
    path.startsWith('/research') || path.startsWith('/docs') || path.startsWith('/share/') ||
    path.startsWith('/terms') || path.startsWith('/privacy') || path.startsWith('/status')
  );
}

export function ChromeSwitch({ signedIn, children }: { signedIn: boolean; children: React.ReactNode }) {
  const path = usePathname() ?? '/';
  return signedIn && !isSignedOutSurface(path) ? <AppShell>{children}</AppShell> : <>{children}</>;
}
