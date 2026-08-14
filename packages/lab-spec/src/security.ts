// Security validators for the harness spec (Lab).
//
// What this file judges: the PARSER's attack surface — secret material,
// control characters, dangerous keys, nesting depth. What it deliberately
// does NOT judge: prose. A mission saying "ignore your rules" VALIDATES —
// prose-sniffing would be fake security (the spec layer cannot know intent,
// and rejecting scary text trains authors to rephrase, not to be safe). The
// real injection posture lives in the runtime: tool results are untrusted
// input and spec strings are data, never the runtime's own instructions.
// The fixture corpus pins BOTH sides of this boundary.
import { MAX_DEPTH } from './limits.js';
import type { SpecIssue } from './types.js';

/**
 * Detection-only port of the converter's secret patterns
 * (scripts/claude-code-to-traces.ts — the G2.8 scrubber). Deliberately
 * DUPLICATED, not imported: scripts are not importable from packages, and
 * the two sites serve different jobs (the script REPLACES for ingestion;
 * this REJECTS at validation). Step 10's custody tests re-verify both
 * copies; if you change one, change the other.
 *
 * The custody rule these enforce: credentials NEVER live in specs. A key
 * pasted into a rules line or a superpower id is a typed rejection, not a
 * stored secret.
 */
const SECRET_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: 'openrouter-key', re: /sk-or-v1-[A-Za-z0-9]{16,}/ },
  { name: 'anthropic-key', re: /sk-ant-[A-Za-z0-9_-]{16,}/ },
  { name: 'openai-project-key', re: /sk-proj-[A-Za-z0-9_-]{16,}/ },
  { name: 'generic-sk-key', re: /\bsk-[A-Za-z0-9_-]{20,}/ },
  { name: 'potion-api-key', re: /\bpk_[A-Za-z0-9_]{4,}/ },
  { name: 'bearer-token', re: /\b[Bb]earer\s+[A-Za-z0-9._~+/-]{8,}=*/ },
  // Step 10 (grant-shaped credentials — the connector era's key shapes):
  // gho_/ghp_/ghu_/ghs_/ghr_ (GitHub OAuth/PAT/refresh), github_pat_
  // (fine-grained), lin_api_/lin_oauth_ (Linear). All literal-prefix
  // anchored (the F21 rule). Known GRANT VALUES are additionally scrubbed
  // by the runtime redactor BEFORE this gate ever sees a tool result —
  // these patterns are the fail-closed backstop for shapes we can name.
  { name: 'github-token', re: /\bgh[opsur]_[A-Za-z0-9]{16,}/ },
  { name: 'github-fine-grained-pat', re: /\bgithub_pat_[A-Za-z0-9_]{20,}/ },
  { name: 'linear-key', re: /\blin_(?:api|oauth)_[A-Za-z0-9]{16,}/ },
  // KEY=value assignments catch a credential even when the value itself
  // matches no known key shape.
  { name: 'env-assignment', re: /\b[A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)\s*=\s*\S{8,}/ },
];

/** Linear per-string scan — the F21 lesson is standing: no
 * repetition-quantified regex over untrusted input on a parse path.
 * (Each SECRET_PATTERN above is anchored to a literal prefix; none is of
 * the (group)* shape that blew up the migration splitter.) */
function hasControlChars(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c <= 0x08 || c === 0x0b || c === 0x0c || (c >= 0x0e && c <= 0x1f)) return true;
  }
  return false;
}

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Walk a parsed-but-unvalidated value: collect dangerous keys, control
 * characters, secret material, and nesting depth in ONE linear pass.
 * Runs BEFORE zod so these get their own typed codes rather than drowning
 * in shape errors — and so a depth bomb is a typed rejection, not a stack
 * overflow inside a validator.
 */
export function scanRawValue(root: unknown): SpecIssue[] {
  const issues: SpecIssue[] = [];
  // Explicit stack, not recursion: the thing being measured (depth) must not
  // be able to crash the instrument measuring it.
  const stack: Array<{ value: unknown; path: string; depth: number }> = [
    { value: root, path: '', depth: 0 },
  ];
  let deepReported = false;
  while (stack.length > 0) {
    const { value, path, depth } = stack.pop()!;
    if (depth > MAX_DEPTH) {
      if (!deepReported) {
        issues.push({
          code: 'nesting-too-deep',
          path,
          message: `nesting exceeds ${MAX_DEPTH} levels`,
        });
        deepReported = true;
      }
      continue; // do not descend further into the bomb
    }
    if (typeof value === 'string') {
      if (hasControlChars(value)) {
        issues.push({ code: 'control-characters', path, message: 'string contains control characters' });
      }
      for (const { name, re } of SECRET_PATTERNS) {
        if (re.test(value)) {
          issues.push({
            code: 'secret-material',
            path,
            message: `string matches secret pattern '${name}' — credentials never live in specs`,
          });
          break; // one secret finding per string is enough
        }
      }
      continue;
    }
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        stack.push({ value: value[i], path: `${path}[${i}]`, depth: depth + 1 });
      }
      continue;
    }
    if (value !== null && typeof value === 'object') {
      // getOwnPropertyNames, not Object.keys: JSON.parse creates
      // '__proto__' as an own property, but own-ness games are exactly what
      // this check exists to catch.
      for (const key of Object.getOwnPropertyNames(value)) {
        const childPath = path === '' ? key : `${path}.${key}`;
        if (DANGEROUS_KEYS.has(key)) {
          issues.push({ code: 'dangerous-key', path: childPath, message: `dangerous object key '${key}'` });
          continue; // never descend through a dangerous key
        }
        stack.push({
          value: (value as Record<string, unknown>)[key],
          path: childPath,
          depth: depth + 1,
        });
      }
    }
  }
  return issues;
}
