// P1-2 (external review, 2026-09-05): the dev-mode auth bypass FAILED OPEN.
//
// `devAuthBypassEnabled` resolved an unset POTION_DEV_AUTH as
// `NODE_ENV !== 'production'`. An absent or misspelled NODE_ENV is not
// production, so it turned the bypass ON — and the bypass resolves an
// UNAUTHENTICATED /api/* request to the default org with role 'admin'.
//
// The whole security posture of the dashboard surface therefore rested on a
// string being PRESENT and spelled exactly right, in a repo whose one
// production incident (2026-08-27) was a variable that was present and empty.
import { describe, expect, it } from 'vitest';
import { devAuthBypassEnabled } from '../src/auth.js';

describe('P1-2: the dev-auth bypass fails CLOSED', () => {
  const env = (o: Record<string, string | undefined>): NodeJS.ProcessEnv => o as NodeJS.ProcessEnv;

  it('NODE_ENV UNSET does not grant an anonymous admin', () => {
    expect(devAuthBypassEnabled(env({}))).toBe(false);
  });

  it('a MISSPELLED production marker does not grant one either', () => {
    // Every one of these is `!== 'production'` and used to open the bypass.
    for (const v of ['Production', 'PRODUCTION', 'prod', 'production ', 'produciton', '']) {
      expect(devAuthBypassEnabled(env({ NODE_ENV: v }))).toBe(false);
    }
  });

  it('the bypass is ON only for a runtime that NAMES itself non-production', () => {
    expect(devAuthBypassEnabled(env({ NODE_ENV: 'development' }))).toBe(true);
    expect(devAuthBypassEnabled(env({ NODE_ENV: 'test' }))).toBe(true);
  });

  it('an explicit flag still wins in both directions', () => {
    expect(devAuthBypassEnabled(env({ POTION_DEV_AUTH: '1' }))).toBe(true);
    expect(devAuthBypassEnabled(env({ POTION_DEV_AUTH: 'true', NODE_ENV: 'production' }))).toBe(true);
    expect(devAuthBypassEnabled(env({ POTION_DEV_AUTH: '0', NODE_ENV: 'development' }))).toBe(false);
  });

  it('an EMPTY or whitespace flag is unset, not a grant — the 2026-08-27 shape', () => {
    expect(devAuthBypassEnabled(env({ POTION_DEV_AUTH: '', NODE_ENV: 'development' }))).toBe(true);
    expect(devAuthBypassEnabled(env({ POTION_DEV_AUTH: '  ', NODE_ENV: 'development' }))).toBe(true);
    // ...and with no runtime marker, empty falls to the closed default.
    expect(devAuthBypassEnabled(env({ POTION_DEV_AUTH: '' }))).toBe(false);
    expect(devAuthBypassEnabled(env({ POTION_DEV_AUTH: '  ' }))).toBe(false);
  });

  it('an unrecognized flag VALUE is not a grant', () => {
    for (const v of ['yes', 'on', '2', 'TRUE!', 'enabled']) {
      expect(devAuthBypassEnabled(env({ NODE_ENV: 'production', POTION_DEV_AUTH: v }))).toBe(false);
    }
  });
});

// The unit tests above prove the RULE. This proves the WIRE: that a box which
// resolves to "bypass on in production" cannot get as far as taking the port.
// A pure-function assertion would have passed just as happily while the boot
// path ignored it, which is the 2026-08-27 class this whole file is about.
describe('P1-2: and the server REFUSES to boot in that state', () => {
  it('buildServer rejects with BootRefusedError, naming the gate', async () => {
    const saved = { env: process.env.NODE_ENV, flag: process.env.POTION_DEV_AUTH };
    process.env.NODE_ENV = 'production';
    process.env.POTION_DEV_AUTH = '1';
    try {
      const { buildServer } = await import('../src/server.js');
      const { BootRefusedError } = await import('../src/boot-report.js');
      await expect(buildServer({ seed: false })).rejects.toThrow(BootRefusedError);
      await expect(buildServer({ seed: false })).rejects.toThrow('AUTH BYPASS IS ON IN PRODUCTION');
    } finally {
      if (saved.env === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = saved.env;
      if (saved.flag === undefined) delete process.env.POTION_DEV_AUTH;
      else process.env.POTION_DEV_AUTH = saved.flag;
    }
  }, 60_000);
});
