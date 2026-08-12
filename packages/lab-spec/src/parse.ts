// parseHarnessSpec / parseHarnessSpecText — the one entry point, collecting
// ALL issues rather than first-failure (a spec author fixes one round, not
// twelve).
//
// Check order, and why:
//   text path:  oversize-total (raw length, BEFORE JSON.parse — running a
//               parser on a 100 MB input is the DoS, not the overflow)
//               → malformed-json → object path
//   object path: security scan (dangerous keys / depth / control chars /
//               secrets — typed codes, run before zod so a depth bomb is a
//               rejection rather than a validator crash)
//               → unsupported-spec-version (precise reason before shape noise)
//               → zod shape (unknown-field / oversize-field / too-many-items
//               surfaced distinctly from generic schema)
//               → hash-mismatch (only when the shape is valid — a hash claim
//               about an invalid document is meaningless)
//
// KNOWN LIMIT, recorded not hidden: duplicate JSON keys. JSON.parse keeps
// the last occurrence silently and exposes no hook to detect duplicates; a
// hand-rolled JSON parser to catch them would be more attack surface than
// the attack. Last-wins is deterministic and the canonical hash makes the
// surviving content unambiguous.
import { ZodIssueCode, type ZodIssue } from 'zod';
import { MAX_TOTAL_BYTES } from './limits.js';
import { HarnessSpecSchema } from './schema.js';
import { scanRawValue } from './security.js';
import { harnessSpecHash } from './hash.js';
import type { HarnessSpec, ParseSpecResult, SpecIssue } from './types.js';

function zodPath(path: Array<string | number>): string {
  let out = '';
  for (const seg of path) {
    out = typeof seg === 'number' ? `${out}[${seg}]` : out === '' ? String(seg) : `${out}.${seg}`;
  }
  return out;
}

function mapZodIssue(issue: ZodIssue): SpecIssue {
  const path = zodPath(issue.path);
  if (issue.code === ZodIssueCode.unrecognized_keys) {
    return {
      code: 'unknown-field',
      path,
      message: `unknown field(s): ${issue.keys.join(', ')} — unknown fields are rejected, not ignored (forward compatibility lives in specVersion)`,
    };
  }
  if (issue.code === ZodIssueCode.too_big) {
    if (issue.type === 'string') {
      return { code: 'oversize-field', path, message: issue.message };
    }
    if (issue.type === 'array') {
      return { code: 'too-many-items', path, message: issue.message };
    }
  }
  return { code: 'schema', path, message: issue.message };
}

export function parseHarnessSpec(input: unknown): ParseSpecResult {
  const issues: SpecIssue[] = [];

  // Security scan first: typed codes for the parser's attack surface, and a
  // depth bomb must never reach the shape validator.
  issues.push(...scanRawValue(input));
  const bombed = issues.some((i) => i.code === 'nesting-too-deep' || i.code === 'dangerous-key');

  // Version before shape: "your format is from the future" beats forty
  // unknown-field errors.
  if (input !== null && typeof input === 'object' && !Array.isArray(input)) {
    const v = (input as Record<string, unknown>).specVersion;
    if (v !== 1 && v !== undefined) {
      issues.push({
        code: 'unsupported-spec-version',
        path: 'specVersion',
        message: `unsupported specVersion ${JSON.stringify(v)} — this parser understands version 1`,
      });
      return { ok: false, issues };
    }
  }

  if (!bombed) {
    const parsed = HarnessSpecSchema.safeParse(input);
    if (parsed.success) {
      const spec = parsed.data as HarnessSpec;
      const computed = harnessSpecHash(spec);
      if (spec.hash !== undefined && spec.hash !== computed) {
        issues.push({
          code: 'hash-mismatch',
          path: 'hash',
          message: `embedded hash ${spec.hash.slice(0, 12)}… does not match content ${computed.slice(0, 12)}… — the spec was edited after hashing, or the hash is a forgery`,
        });
      }
      if (issues.length === 0) return { ok: true, spec, hash: computed };
    } else {
      issues.push(...parsed.error.issues.map(mapZodIssue));
    }
  }

  return { ok: false, issues };
}

export function parseHarnessSpecText(text: string): ParseSpecResult {
  // Byte length, not code-unit length: the cap is about input size.
  if (Buffer.byteLength(text, 'utf8') > MAX_TOTAL_BYTES) {
    return {
      ok: false,
      issues: [
        {
          code: 'oversize-total',
          path: '',
          message: `input exceeds ${MAX_TOTAL_BYTES} bytes — rejected before parsing`,
        },
      ],
    };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (e) {
    return {
      ok: false,
      issues: [
        { code: 'malformed-json', path: '', message: (e as Error).message.slice(0, 200) },
      ],
    };
  }
  return parseHarnessSpec(value);
}
