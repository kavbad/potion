import { headers } from 'next/headers';
import { AppShell } from '@/components/app-shell';
import { sessionCookieHeader } from '@/lib/api';

/** Routes that are signed-out surfaces by nature, whatever cookie is present. */
function isSignedOutSurface(path: string): boolean {
  // /home is the landing page at a stable URL — public regardless of session,
  // so it must never wear the app sidebar even for a signed-in operator
  // reviewing it. Same for the docs, the research publication and sign-in.
  return (
    path.startsWith('/login') || path.startsWith('/home') || path.startsWith('/hero-lab') ||
    path.startsWith('/research') || path.startsWith('/docs')
  );
}

/**
 * Chrome chooser. A template (unlike a layout) is re-rendered on every
 * navigation, so the decision always matches the page being shown.
 */
export default async function Template({ children }: { children: React.ReactNode }) {
  const path = (await headers()).get('x-potion-path') ?? '';
  // Cookie PRESENCE, the same test middleware.ts makes — presence is not
  // validity; a stale session redirects to /login, which never wears the
  // sidebar.
  const signedIn = (await sessionCookieHeader()) !== undefined && !isSignedOutSurface(path);
  return signedIn ? <AppShell>{children}</AppShell> : <>{children}</>;
}
