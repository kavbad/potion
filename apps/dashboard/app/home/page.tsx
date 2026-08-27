// /home — the landing page at a STABLE, always-public URL.
//
// '/' is session-aware by design: signed out it is the landing page, signed
// in it is Connect & auto-route, because someone who has already bought
// should not be shown the sales pitch at the root of their own dashboard.
//
// The cost of that is real, and it showed up the moment the landing page
// needed reviewing: a signed-in operator cannot see it, and a link sent to
// an investor renders differently depending on a cookie the sender cannot
// see. So the landing page also lives here, unconditionally. Same component,
// no session branch — what you send is what they get.
import type { Metadata } from 'next';
import { Landing } from '@/components/landing';
import { SiteShell } from '@/components/site-header';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Potion — your router, built from evidence',
};

export default function HomePage() {
  return (
    <SiteShell>
      <Landing />
    </SiteShell>
  );
}
