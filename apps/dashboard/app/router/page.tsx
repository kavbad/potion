// /router — merged into the home (signed-in redesign, 2026-08-27): the
// compiler IS the front page now. This route survives for old links, and
// stays spelled /router on purpose: renaming a URL people have bookmarked
// buys nothing. /compiler is the same redirect under the current name.
import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

export default function RouterRedirect() {
  redirect('/');
}
