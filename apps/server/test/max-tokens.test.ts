import { describe, expect, it } from 'vitest';
import { resolveMaxOutputTokens } from '../src/routes/chat.js';

describe('max_tokens threading', () => {
  it('passes the caller bound through, floored at 1 and capped at the ceiling', () => {
    expect(resolveMaxOutputTokens(50)).toBe(50);
    expect(resolveMaxOutputTokens(1800)).toBe(1800);
    expect(resolveMaxOutputTokens(100_000)).toBe(8192);
    expect(resolveMaxOutputTokens(0)).toBe(1);
    expect(resolveMaxOutputTokens(12.7)).toBe(12);
  });
  it('the chat route threads body.max_tokens into the execution context', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../src/routes/chat.ts', import.meta.url), 'utf8');
    const execBase = src.slice(src.indexOf('const execBase = {'), src.indexOf('const wantStream'));
    expect(execBase).toContain('maxOutputTokens: resolveMaxOutputTokens(body.max_tokens)');
  });
});
