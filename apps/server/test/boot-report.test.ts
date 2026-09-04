// The boot gate report. These assertions ARE the 2026-08-27 incident:
// POTION_SELF_SERVE was scaffolded empty, read as unset, defaulted OFF, and
// new-account sign-in died silently. Every case below is a config shape
// that changes security or billing behaviour without saying so.
import { describe, expect, it } from 'vitest';
import { bootGateReport, bootWarnings, sourceOf } from '../src/boot-report.js';

const PROD = { NODE_ENV: 'production' } as const;
const gate = (env: Record<string, string | undefined>, name: string, mode: 'live' | 'mock' = 'live') =>
  bootGateReport({ ...PROD, ...env }, mode).find((r) => r.name === name)!;

describe('boot gate report', () => {
  it('separates empty from unset — both default, only one is a mistake', () => {
    expect(sourceOf(undefined)).toBe('default-unset');
    expect(sourceOf('')).toBe('default-empty');
    expect(sourceOf('   ')).toBe('default-empty');
    expect(sourceOf('1')).toBe('explicit');
  });

  it('names the exact 2026-08-27 shape: SELF_SERVE present but empty', () => {
    const g = gate({ POTION_SELF_SERVE: '' }, 'POTION_SELF_SERVE');
    expect(g.source).toBe('default-empty');
    expect(g.state).toContain('CLOSED');
    expect(g.warn).toContain('EMPTY');
    expect(g.warn).toContain('2026-08-27');
  });

  it('does not warn when the gate was set deliberately', () => {
    expect(gate({ POTION_SELF_SERVE: '1' }, 'POTION_SELF_SERVE').warn).toBeUndefined();
    expect(gate({ POTION_SELF_SERVE: '0' }, 'POTION_SELF_SERVE').warn).toBeUndefined();
  });

  it('flags the session-minting combination as dangerous', () => {
    const g = gate({ POTION_SELF_SERVE: '1', POTION_MAGIC_LINK_IN_RESPONSE: '1' }, 'POTION_MAGIC_LINK_IN_RESPONSE');
    expect(g.warn).toContain('DANGEROUS COMBINATION');
    expect(g.warn).toContain('ANY email');
  });

  it('flags an auth bypass left on in production', () => {
    expect(gate({ POTION_DEV_AUTH: '1' }, 'POTION_DEV_AUTH').warn).toContain('PRODUCTION');
    expect(gate({}, 'POTION_DEV_AUTH').warn).toBeUndefined(); // unset defaults OFF in prod
  });

  it('says plainly whether money can actually move', () => {
    expect(gate({ STRIPE_SECRET_KEY: 'sk_live_x' }, 'STRIPE_SECRET_KEY').state).toContain('CAN take real money');
    expect(gate({}, 'STRIPE_SECRET_KEY').state).toContain('never collected');
    expect(gate({ STRIPE_SECRET_KEY: '' }, 'STRIPE_SECRET_KEY').warn).toContain('collects nothing');
  });

  it('warns that an in-memory limiter is single-replica only (F18)', () => {
    expect(gate({}, 'REDIS_URL').warn).toContain('ONE REPLICA');
    expect(gate({ REDIS_URL: 'redis://x' }, 'REDIS_URL').warn).toBeUndefined();
  });

  it('refuses to let mock providers hide in production', () => {
    expect(gate({}, 'provider mode', 'mock').warn).toContain('MOCK PROVIDERS IN PRODUCTION');
    expect(gate({}, 'provider mode', 'live').warn).toBeUndefined();
  });

  it('a fully configured production box reports no warnings at all', () => {
    const rows = bootGateReport(
      {
        NODE_ENV: 'production',
        POTION_SELF_SERVE: '1',
        POTION_DEV_AUTH: '0',
        STRIPE_SECRET_KEY: 'sk_live_x',
        REDIS_URL: 'redis://x',
        SENTRY_DSN: 'https://x',
        POTION_PUBLIC_URL: 'https://api.withpotion.com',
        POTION_OPERATOR_TOKEN: 't',
      },
      'live',
    );
    expect(bootWarnings(rows)).toEqual([]);
  });

  it('sign in with Google: both halves, or it is off and says so', () => {
    const off = bootGateReport({}, 'live').find((r) => r.name === 'sign in with Google');
    expect(off?.state).toContain('off');
    expect(off?.warn).toBeUndefined();

    const on = bootGateReport(
      { POTION_GOOGLE_CLIENT_ID: 'id', POTION_GOOGLE_CLIENT_SECRET: 's' },
      'live',
    ).find((r) => r.name === 'sign in with Google');
    expect(on?.state).toContain('on');
    expect(on?.warn).toBeUndefined();
  });

  it('HALF a Google pair is the silent-off shape this file exists for', () => {
    // Paste the client id, miss the secret: the routes never register, the
    // button never draws, and without this row nothing anywhere says why.
    const half = bootGateReport({ POTION_GOOGLE_CLIENT_ID: 'id' }, 'live').find(
      (r) => r.name === 'sign in with Google',
    );
    expect(half?.state).toContain('OFF');
    expect(half?.warn).toContain('secret missing');
    // And an EMPTY secret is the same mistake, not a different one.
    const empty = bootGateReport(
      { POTION_GOOGLE_CLIENT_ID: 'id', POTION_GOOGLE_CLIENT_SECRET: '' },
      'live',
    ).find((r) => r.name === 'sign in with Google');
    expect(empty?.warn).toContain('secret missing');
  });

  it('reports every gate on every boot, warning or not', () => {
    expect(bootGateReport({}, 'live').length).toBeGreaterThanOrEqual(8);
  });
});
