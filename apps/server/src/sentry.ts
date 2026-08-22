// Sentry init (13a spec §1.6) — the one net-new monitoring wire.
//
// One init point covers everything: the worker is IN-PROCESS (server.ts
// calls runWorker directly), so instrumenting the server process instruments
// the queue consumer too. The contract the spec pins: **a no-op when
// SENTRY_DSN is unset**, so every existing environment — tests, local dev,
// the walkthroughs — is byte-for-byte unaffected, and the import itself is
// lazy so the SDK costs nothing where it is not configured.
let initialized = false;

export async function initSentry(dsn = process.env.SENTRY_DSN): Promise<boolean> {
  if (dsn === undefined || dsn.trim() === '') return false;
  if (initialized) return true;
  const Sentry = await import('@sentry/node');
  Sentry.init({
    dsn,
    // Errors are the product here; performance tracing stays off until
    // someone decides to pay for the volume (same posture as OTel: off
    // unless explicitly configured).
    tracesSampleRate: 0,
  });
  initialized = true;
  return true;
}

/** Test seam: reset the once-guard. */
export function resetSentryForTests(): void {
  initialized = false;
}
