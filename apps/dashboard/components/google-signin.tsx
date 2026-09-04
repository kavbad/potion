// CONTINUE WITH GOOGLE (2026-09-04) — the button, on its own.
//
// It lives in its own file for two reasons. It is drawn conditionally on
// /login (only once the deployment has said it HAS a Google client), and a
// conditional control inside a large client component is exactly the kind
// of thing that renders wrong for months without anyone noticing; alone, it
// can be rendered and asserted directly. And it is a plain <a>, not a
// button that fetches: the whole point is a top-level navigation to Google,
// which is what a browser, a middle-click and a screen reader all already
// understand.
//
// The mark is Google's own four-colour G, drawn inline — so the button
// never waits on a third-party image, and no request reaches Google before
// the visitor has decided to go there.

/** Google's four-colour G. */
export function GoogleG({ className = 'h-[18px] w-[18px]' }: { className?: string }) {
  return (
    <svg viewBox="0 0 48 48" className={className} aria-hidden focusable="false">
      <path fill="#4285F4" d="M45.12 24.5c0-1.56-.14-3.06-.4-4.5H24v8.51h11.84c-.51 2.75-2.06 5.08-4.39 6.64v5.52h7.11c4.16-3.83 6.56-9.47 6.56-16.17z" />
      <path fill="#34A853" d="M24 46c5.94 0 10.92-1.97 14.56-5.33l-7.11-5.52c-1.97 1.32-4.49 2.1-7.45 2.1-5.73 0-10.58-3.87-12.31-9.07H4.34v5.7C7.96 41.07 15.4 46 24 46z" />
      <path fill="#FBBC05" d="M11.69 28.18C11.25 26.86 11 25.45 11 24s.25-2.86.69-4.18v-5.7H4.34C2.85 17.09 2 20.45 2 24s.85 6.91 2.34 9.88l7.35-5.7z" />
      <path fill="#EA4335" d="M24 10.75c3.23 0 6.13 1.11 8.41 3.29l6.31-6.31C34.91 4.18 29.93 2 24 2 15.4 2 7.96 6.93 4.34 14.12l7.35 5.7c1.73-5.2 6.58-9.07 12.31-9.07z" />
    </svg>
  );
}

/** Where the browser half of the flow starts (app/api/auth/google/start). */
export const GOOGLE_START_PATH = '/api/auth/google/start';

export function GoogleSignInButton() {
  return (
    <div className="space-y-5">
      <a
        href={GOOGLE_START_PATH}
        data-testid="google-signin"
        className="flex h-11 w-full items-center justify-center gap-3 rounded-md border border-[#dadce0] bg-white text-sm font-medium text-[#3c4043] transition-shadow hover:shadow-[0_1px_3px_rgba(60,64,67,0.24)] focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2"
      >
        <GoogleG />
        Continue with Google
      </a>
      <div className="flex items-center gap-3" aria-hidden>
        <span className="h-px flex-1 bg-[#e2ded4]" />
        <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-faint">or</span>
        <span className="h-px flex-1 bg-[#e2ded4]" />
      </div>
    </div>
  );
}
