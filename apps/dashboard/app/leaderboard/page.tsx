// /leaderboard — retired from the public site (2026-08-22). The old
// recipe leaderboard had nothing live-verified to show and, once it did,
// would have named models the landing page deliberately withholds. The
// API route stays for opted-in orgs; the page sends visitors to the product.
import { redirect } from 'next/navigation';
export const dynamic = 'force-dynamic';
export default function LeaderboardPage() {
  redirect('/home');
}
