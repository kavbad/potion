// THE PUBLIC BASE URL — the one a customer actually points traffic at.
//
// Deriving it from the request (`${req.protocol}://${req.headers.host}`) is
// right only when the client talks to this process directly. Behind a
// terminating proxy — which is every real deployment — `protocol` is the
// INTERNAL hop's scheme and `host` is whatever the proxy forwarded, so the
// connection snippet we hand someone can be `http://` when the world sees
// `https://`, or an internal hostname nobody outside the network can resolve.
// A base_url that is subtly wrong is worse than one that is missing: it fails
// at the customer's first request, in their code, not in ours.
//
// So POTION_PUBLIC_URL, when set, WINS — it is the operator's explicit
// statement of where this deployment lives, and no header can override it.
// Unset (local dev), we fall back to the request-derived form, which is
// correct there precisely because there is no proxy.
//
// Deliberately NOT trusting X-Forwarded-*: a forwarded header is attacker-
// controlled unless the proxy is known to strip and re-set it, and this
// value is handed to customers as "point your production traffic here".
// An env var the operator sets once is the honest instrument.
import type { FastifyRequest } from 'fastify';

/** POTION_PUBLIC_URL with any trailing slash removed; null when unset/blank. */
export function configuredPublicUrl(): string | null {
  const raw = process.env.POTION_PUBLIC_URL;
  if (raw === undefined || raw.trim() === '') return null;
  return raw.trim().replace(/\/+$/, '');
}

/**
 * The base URL to advertise: POTION_PUBLIC_URL when configured, otherwise the
 * request's own origin. No path, no trailing slash — callers append `/v1/…`.
 */
export function publicBaseUrl(req: FastifyRequest): string {
  const configured = configuredPublicUrl();
  if (configured !== null) return configured;
  const proto = req.protocol || 'http';
  const host = req.headers.host ?? 'localhost:3000';
  return `${proto}://${host}`;
}
