// /policy merged into /settings/controls (2026-08-24 surface review): one
// page for every lever. The redirect keeps old links and bookmarks working.
import { redirect } from 'next/navigation';

export default function PolicyPage() {
  redirect('/settings/controls');
}
