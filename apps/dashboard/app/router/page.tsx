// /router — merged into the home (signed-in redesign, 2026-08-27): the
// router IS the front page now. This route survives for old links.
import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

export default function RouterRedirect() {
  redirect('/');
}
