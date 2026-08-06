/**
 * PotionError hierarchy (SPEC §13.2).
 *
 * The Potion gateway returns OpenAI-shaped errors:
 *
 * ```json
 * {"error": {"message": "...", "type": "...", "param": "...", "code": "..."}}
 * ```
 *
 * The SDK maps the platform's `code` values onto typed exceptions so
 * callers can catch precisely instead of string-matching:
 *
 * ```ts
 * try {
 *   await client.chat.completions.create({ ..., policy: 'does-not-exist' });
 * } catch (err) {
 *   if (err instanceof PolicyNotFoundError) { ... }
 * }
 * ```
 */

/** The OpenAI-shaped error envelope as carried on {@link PotionError.body}. */
export interface PotionErrorBody {
  error?: {
    message?: string;
    type?: string;
    param?: string | null;
    code?: string | null;
  };
}

export interface PotionErrorOptions {
  statusCode?: number | undefined;
  type?: string | undefined;
  code?: string | undefined;
  param?: string | undefined;
  body?: PotionErrorBody | undefined;
}

/** Base class for every error raised by the Potion SDK.
 *
 * Carries the OpenAI-shaped error fields verbatim: `message`, `type`,
 * `code`, `param` plus the HTTP `statusCode`. */
export class PotionError extends Error {
  readonly statusCode: number | undefined;
  readonly type: string | undefined;
  readonly code: string | undefined;
  readonly param: string | undefined;
  readonly body: PotionErrorBody | undefined;

  constructor(message: string, options: PotionErrorOptions = {}) {
    super(message);
    this.name = new.target.name;
    this.statusCode = options.statusCode;
    this.type = options.type;
    this.code = options.code;
    this.param = options.param;
    this.body = options.body;
  }
}

/** `code === 'policy_not_found'` — the X-Potion-Policy id/name does not
 * exist in the caller's org (HTTP 400, type invalid_request_error). */
export class PolicyNotFoundError extends PotionError {}

/** `code === 'budget_exceeded'` / `type === 'budget_exceeded'` — the org's
 * budget hard-stop refused the request (HTTP 429). */
export class BudgetExceededError extends PotionError {}

/** `code === 'rate_limit_exceeded'` — the key/org rate limit fired
 * (HTTP 429). */
export class RateLimitExceededError extends PotionError {}

type PotionErrorClass = new (message: string, options: PotionErrorOptions) => PotionError;

/** Platform error code → exception class. Lookup falls back to PotionError. */
export const ERROR_CODE_MAP: Readonly<Record<string, PotionErrorClass>> = {
  policy_not_found: PolicyNotFoundError,
  budget_exceeded: BudgetExceededError,
  rate_limit_exceeded: RateLimitExceededError,
};

/** Map an OpenAI-shaped error body onto the PotionError hierarchy. */
export function mapError(args: {
  statusCode?: number | undefined;
  body?: PotionErrorBody | null | undefined;
  fallbackMessage: string;
}): PotionError {
  const err = args.body?.error ?? {};
  const message = err.message ?? args.fallbackMessage;
  const code = err.code ?? undefined;
  // budget_exceeded may arrive as the TYPE rather than the code (SPEC §13.7).
  const lookup = code !== undefined && code in ERROR_CODE_MAP ? code : err.type;
  const Cls = (lookup !== undefined ? ERROR_CODE_MAP[lookup] : undefined) ?? PotionError;
  return new Cls(message, {
    statusCode: args.statusCode,
    type: err.type ?? undefined,
    code,
    param: err.param ?? undefined,
    body: args.body ?? undefined,
  });
}
