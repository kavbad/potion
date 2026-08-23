import { describe, expect, it } from 'vitest';
import { baseUrlOf } from '../src/routes/auth.js';

const req = { protocol: 'http', headers: { host: 'server:3000' } } as never;

describe('magic-link base URL', () => {
  it('points at the deployed dashboard verify proxy when POTION_APP_URL is set', () => {
    expect(baseUrlOf(req, undefined, 'https://app.withpotion.com/')).toBe('https://app.withpotion.com/api');
  });
  it('falls back to the request host only when no public URL is configured (local dev)', () => {
    expect(baseUrlOf(req, undefined, undefined)).toBe('http://server:3000');
  });
  it('an explicit override still wins', () => {
    expect(baseUrlOf(req, 'http://localhost:3001/api/', 'https://app.withpotion.com')).toBe('http://localhost:3001/api');
  });
});
