// Typed provider errors (SPEC §2 / Phase 1). All live-transport failures
// surface as one of these so callers can branch on `instanceof`.
//
// M3 (SPEC §12.1, additive): every ProviderError now also carries a
// `kind` taxonomy tag + a derived `retryable` flag (and an optional
// `model`), so the resilience wrapper can classify uniformly.
// Messages must NEVER include request headers or key material.

import type { ProviderId } from '@potion/core';

/** Error taxonomy (SPEC §12.1). */
export type ProviderErrorKind =
  | 'rate_limit'
  | 'timeout'
  | 'server_5xx'
  | 'client_4xx'
  | 'network'
  | 'unknown';

/** Retryable kinds (SPEC §12.1): rate_limit | timeout | server_5xx | network. */
const RETRYABLE_KINDS: ReadonlySet<ProviderErrorKind> = new Set<ProviderErrorKind>([
  'rate_limit',
  'timeout',
  'server_5xx',
  'network',
]);

export function isRetryableKind(kind: ProviderErrorKind): boolean {
  return RETRYABLE_KINDS.has(kind);
}

/** Classify an HTTP status code: 429 → rate_limit, 5xx → server_5xx, other 4xx → client_4xx. */
export function kindFromHttpStatus(status: number): ProviderErrorKind {
  if (status === 429) return 'rate_limit';
  if (status >= 500 && status <= 599) return 'server_5xx';
  if (status >= 400 && status <= 499) return 'client_4xx';
  return 'unknown';
}

/** Node/fetch network-failure codes → 'network'. */
const NETWORK_ERROR_CODES: ReadonlySet<string> = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPROTO',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
]);

/**
 * Classify an arbitrary thrown value (fetch exception, DOMException, …) into
 * the taxonomy. ProviderError instances keep their own kind. AbortError /
 * TimeoutError → timeout; TypeError (what undici/fetch throws on connection
 * failures) and Node errno codes → network; anything else → unknown.
 */
export function classifyError(err: unknown): ProviderErrorKind {
  if (err instanceof ProviderError) return err.kind;
  if (err !== null && typeof err === 'object') {
    const name = (err as { name?: unknown }).name;
    if (name === 'AbortError' || name === 'TimeoutError') return 'timeout';
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string' && NETWORK_ERROR_CODES.has(code)) return 'network';
    if (err instanceof TypeError) return 'network'; // fetch network failure
  }
  return 'unknown';
}

export interface ProviderErrorOptions {
  status?: number;
  cause?: unknown;
  kind?: ProviderErrorKind;
  model?: string;
  /** True when the error is a circuit-breaker fast-reject (SPEC §12.1). */
  breakerOpen?: boolean;
}

export class ProviderError extends Error {
  readonly provider: ProviderId;
  readonly status?: number;
  readonly kind: ProviderErrorKind;
  readonly retryable: boolean;
  readonly model?: string;
  readonly breakerOpen?: boolean;

  constructor(provider: ProviderId, message: string, opts?: ProviderErrorOptions) {
    super(message, opts && 'cause' in opts ? { cause: opts.cause } : undefined);
    this.name = new.target.name;
    this.provider = provider;
    if (opts?.status !== undefined) this.status = opts.status;
    // Explicit kind wins; otherwise derive from the HTTP status (if any).
    this.kind = opts?.kind ?? (opts?.status !== undefined ? kindFromHttpStatus(opts.status) : 'unknown');
    this.retryable = isRetryableKind(this.kind);
    if (opts?.model !== undefined) this.model = opts.model;
    if (opts?.breakerOpen !== undefined) this.breakerOpen = opts.breakerOpen;
  }
}

/** HTTP 401/403 — bad or missing API key. Never retried. */
export class ProviderAuthError extends ProviderError {
  constructor(provider: ProviderId, message: string, opts?: ProviderErrorOptions) {
    super(provider, message, { ...opts, kind: opts?.kind ?? 'client_4xx' });
    this.name = new.target.name;
  }
}

/** HTTP 429 that persisted through all retries. */
export class ProviderRateLimitError extends ProviderError {
  readonly retryAttempts: number;

  constructor(
    provider: ProviderId,
    message: string,
    retryAttempts: number,
    opts?: ProviderErrorOptions,
  ) {
    super(provider, message, { ...opts, kind: opts?.kind ?? 'rate_limit' });
    this.name = new.target.name;
    this.retryAttempts = retryAttempts;
  }
}

/** Request exceeded the configured timeout (AbortController abort). */
export class ProviderTimeoutError extends ProviderError {
  readonly timeoutMs: number;

  constructor(provider: ProviderId, timeoutMs: number, opts?: ProviderErrorOptions) {
    super(provider, `provider '${provider}': request timed out after ${timeoutMs}ms`, {
      ...opts,
      kind: opts?.kind ?? 'timeout',
    });
    this.name = new.target.name;
    this.timeoutMs = timeoutMs;
  }
}
