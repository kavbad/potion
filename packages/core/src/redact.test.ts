// PII redaction tests (G1.1): pattern coverage, Luhn negative control,
// determinism + idempotency (loop signatures depend on it), structural walk.
import { describe, expect, it } from 'vitest';
import { redactAttrs, redactPii } from './redact.js';

describe('redactPii', () => {
  it('redacts each structured pattern with its specific tag', () => {
    expect(redactPii('mail cfo@acme.io now')).toBe('mail <email> now');
    expect(redactPii('token sk-abcdef12345678 leaked')).toBe('token <secret> leaked');
    expect(redactPii('ssn 123-45-6789 on file')).toBe('ssn <ssn> on file');
    expect(redactPii('card 4111 1111 1111 1111 ok')).toBe('card <card> ok'); // Luhn-valid test PAN
    expect(redactPii('iban DE89370400440532013000 given')).toBe('iban <iban> given');
    expect(redactPii('call +1 (555) 123-4567 today')).toBe('call <phone> today');
    expect(redactPii('host 10.0.12.7 up')).toBe('host <ip> up');
    expect(redactPii('at https://user:pass@example.com/x')).toBe('at <url-cred>@example.com/x');
    expect(redactPii('hdr eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abcDEF123-_ok done').includes('<jwt>')).toBe(true);
    expect(redactPii('invoice 4421 status')).toBe('invoice <num> status');
  });

  it('Luhn negative control: 16 digits failing checksum become <num>, not <card>', () => {
    const out = redactPii('ref 1234 5678 9012 3455 thanks'); // fails Luhn
    expect(out).not.toContain('<card>');
    expect(out).toContain('<num>');
  });

  it('is deterministic and idempotent (placeholders never re-match)', () => {
    const input = 'cfo@acme.io paid 99887766 via 4111 1111 1111 1111, call 555-123-4567';
    const once = redactPii(input);
    expect(redactPii(once)).toBe(once);
    expect(redactPii(input)).toBe(once);
    expect(once).not.toMatch(/\d{4,}/);
  });

  it('leaves clean prose byte-identical', () => {
    const s = 'Fix the retry budget loop';
    expect(redactPii(s)).toBe(s);
  });
});

describe('redactAttrs', () => {
  it('redacts string leaves recursively; preserves keys, numbers, booleans, null', () => {
    const out = redactAttrs({
      'gen_ai.prompt': 'email cfo@acme.io about invoice 4421',
      'tool.args': { q: 'invoice 4421', deep: ['ssn 123-45-6789', 7] },
      p: 1,
      done: true,
      missing: null,
    });
    expect(out['gen_ai.prompt']).toBe('email <email> about invoice <num>');
    expect(out['tool.args']).toEqual({ q: 'invoice <num>', deep: ['ssn <ssn>', 7] });
    expect(out['p']).toBe(1);
    expect(out['done']).toBe(true);
    expect(out['missing']).toBeNull();
    expect(Object.keys(out).sort()).toEqual(['done', 'gen_ai.prompt', 'missing', 'p', 'tool.args']);
  });

  it('allowlisted operational keys survive verbatim (model ids carry digit runs)', () => {
    const out = redactAttrs({
      'gen_ai.request.model': 'claude-haiku-4-5-20251001',
      'gen_ai.operation.name': 'execute_tool',
      'tool.name': 'search',
      'gen_ai.prompt': 'order 20251001',
    });
    expect(out['gen_ai.request.model']).toBe('claude-haiku-4-5-20251001');
    expect(out['gen_ai.operation.name']).toBe('execute_tool');
    expect(out['tool.name']).toBe('search');
    expect(out['gen_ai.prompt']).toBe('order <num>');
  });
});
