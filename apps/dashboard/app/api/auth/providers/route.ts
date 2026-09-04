// GET /api/auth/providers — which sign-in doors this deployment has open.
//
// The login page asks before it draws. A "Continue with Google" button on a
// deployment with no Google client is a button that leads nowhere, and a
// dead sign-in control is worse than one less option. The answer is NOT
// duplicated into a NEXT_PUBLIC_* var here: the server gates its Google
// routes on the same config reader that answers this, so the button and the
// route it leads to can never disagree.
import { NextResponse } from 'next/server';
import { apiUrl } from '@/lib/api';

export const dynamic = 'force-dynamic';

export async function GET(): Promise<NextResponse> {
  // The floor of the sign-in contract, and the honest answer when the API
  // is unreachable: the email link always exists.
  const fallback = { providers: { magicLink: true, google: false, oidc: false } };
  try {
    const res = await fetch(`${apiUrl()}/auth/providers`, { cache: 'no-store' });
    if (!res.ok) return NextResponse.json(fallback);
    return NextResponse.json((await res.json()) as unknown);
  } catch {
    return NextResponse.json(fallback);
  }
}
