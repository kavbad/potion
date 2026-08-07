// PII redaction primitives (G1.1): the platform's ONE text-redaction pass,
// applied at TRACE INGEST (apps/server /v1/traces — raw prompts never at
// rest) and again on the clustering hop (packages/workers redactTraceText —
// defense-in-depth for repo-seeded/legacy rows).
//
// Contract: DETERMINISTIC and IDEMPOTENT — identical input always yields the
// identical output (loop-detection signatures and cluster exemplar dedup
// depend on it), and re-running on redacted text is a no-op (placeholders
// contain no digits/@/dots that could re-match). Placeholder vocabulary
// preserves the pre-G1.1 tokens (<email>, <secret>, <num> — pinned by
// worker suite-synthesis tests) and adds specific-before-generic tags.
//
// HONEST RESIDUAL RISK (documented, not hidden): this is a PATTERN pass.
// Free-text person names, street addresses, and narrative PII (medical /
// financial prose) are NOT detected — that is NER territory and explicitly
// out of scope here. Customer-visible surfaces built on trace-derived data
// (G1.5 rubric review) must treat redacted text as reduced-risk, not
// risk-free.

const JWT_RE = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const SECRET_RE = /\b(?:sk|pk|key|tok|bearer|api)[-_][\w-]{8,}\b/gi;
const EMAIL_RE = /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g;
const SSN_RE = /\b\d{3}-\d{2}-\d{4}\b/g;
const IBAN_RE = /\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b/g;
/** 13–19 digits with optional space/dash separators (validated by Luhn). */
const CARD_RE = /\b\d(?:[ -]?\d){12,18}\b/g;
/** Separator-tolerant phone shapes: +intl or (area) prefixes, ≥7 digits. */
const PHONE_RE = /(?:(?<=\s)|^)(?:\+\d{1,3}[ .-]?)?(?:\(\d{2,4}\)[ .-]?)?\d{2,4}[ .-]\d{2,4}(?:[ .-]\d{2,4}){0,2}\b/g;
const IPV4_RE = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const URL_CRED_RE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@]+:[^\s/@]+@/gi;
const NUM_RUN_RE = /\b\d{4,}\b/g;

/** Luhn checksum over the digits of a candidate card number. */
function luhnValid(candidate: string): boolean {
  const digits = candidate.replace(/\D/g, '');
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/**
 * Redact structured PII/credentials from free text. Order matters:
 * specific tags first, the generic ≥4-digit rule LAST so it can never
 * shadow a more precise tag.
 */
export function redactPii(text: string): string {
  return text
    .replace(JWT_RE, '<jwt>')
    .replace(URL_CRED_RE, '<url-cred>@')
    .replace(SECRET_RE, '<secret>')
    .replace(EMAIL_RE, '<email>')
    .replace(SSN_RE, '<ssn>')
    .replace(IBAN_RE, '<iban>')
    .replace(CARD_RE, (m) => (luhnValid(m) ? '<card>' : m))
    .replace(PHONE_RE, (m) => {
      const digits = m.replace(/\D/g, '').length;
      // Phone-plausible lengths only (7-12); longer digit groups fall through
      // to the generic <num> rule rather than masquerading as phones.
      return digits >= 7 && digits <= 12 ? '<phone>' : m;
    })
    .replace(IPV4_RE, '<ip>')
    .replace(NUM_RUN_RE, '<num>');
}

/**
 * Operational attr keys that must survive verbatim at ANY depth: model ids
 * carry ≥4-digit runs the generic rule would mangle, and control enums
 * (operation names, tool names) drive tool-signature detection.
 */
export const REDACT_KEY_ALLOWLIST: ReadonlySet<string> = new Set([
  'gen_ai.request.model',
  'gen_ai.operation.name',
  'gen_ai.system',
  'tool.name',
]);

/**
 * Redact every STRING LEAF of an attributes object (recursively through
 * plain objects and arrays). Numbers, booleans, and nulls pass through
 * untouched — operational values and canonical tool signatures depend on
 * their exact types. Keys are always preserved (metadata-only detection is
 * key-count-based). Allowlisted keys skip redaction entirely.
 */
export function redactAttrs(attrs: Record<string, unknown>): Record<string, unknown> {
  const walk = (value: unknown, key?: string): unknown => {
    if (typeof value === 'string') {
      if (key !== undefined && REDACT_KEY_ALLOWLIST.has(key)) return value;
      return redactPii(value);
    }
    if (Array.isArray(value)) return value.map((v) => walk(v));
    if (value !== null && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = REDACT_KEY_ALLOWLIST.has(k) ? v : walk(v, k);
      }
      return out;
    }
    return value;
  };
  return walk(attrs) as Record<string, unknown>;
}
