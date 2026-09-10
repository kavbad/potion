// /compiler — the current name for what /router has always pointed at: the
// signed-in home, where the org's compiled plan lives. Both redirect; the
// old path is kept for bookmarks (see app/router/page.tsx).
import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

export default function CompilerRedirect() {
  redirect('/');
}
