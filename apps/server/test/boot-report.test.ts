// The boot gate report. These assertions ARE the 2026-08-27 incident:
// POTION_SELF_SERVE was scaffolded empty, read as unset, defaulted OFF, and
// new-account sign-in died silently. Every case below is a config shape
// that changes security or billing behaviour without saying so.
import { describe, expect, it } from 'vitest';
import {
  bootFatals,
  bootGateReport,
  bootWarnings,
  BootRefusedError,
  type BootGateLog,
  logBootGates,
  sourceOf,
} from '../src/boot-report.js';

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

  // (the session-minting combination is asserted below, split across the
  // production case — now FATAL — and the closed-test-box case, still a warn)

  it('an auth bypass left on in production is FATAL, not a warning', () => {
    // P1-2 / HARDENING-PLAN P2.1. This used to be `warn`, and the whole
    // mechanism was a line in a deploy log that nobody was reading — the
    // 2026-08-27 class exactly: a gate that reported its state and did not act.
    const g = gate({ POTION_DEV_AUTH: '1' }, 'POTION_DEV_AUTH');
    expect(g.warn).toBeUndefined();
    expect(g.fatal).toContain('AUTH BYPASS IS ON IN PRODUCTION');
    expect(g.fatal).toContain('Unset POTION_DEV_AUTH'); // and names the remedy
    expect(gate({}, 'POTION_DEV_AUTH').fatal).toBeUndefined(); // unset is OFF in prod
  });

  it('the report reads the REAL resolver, so the log cannot disagree with the server', () => {
    // It used to re-implement the rule inline. Two copies of a security
    // decision is one copy that can drift, and the log is the only place an
    // operator would ever look.
    expect(gate({ NODE_ENV: 'garbage' }, 'POTION_DEV_AUTH').state).toContain('bypass off');
    expect(bootGateReport({ NODE_ENV: 'development' }, 'live')
      .find((r) => r.name === 'POTION_DEV_AUTH')!.state).toContain('bypass ON');
  });

  it('magic links + self-serve is FATAL in production, a warning off it', () => {
    const prod = gate({ POTION_SELF_SERVE: '1', POTION_MAGIC_LINK_IN_RESPONSE: '1' }, 'POTION_MAGIC_LINK_IN_RESPONSE');
    expect(prod.fatal).toContain('ANY email');
    const box = bootGateReport(
      { NODE_ENV: 'development', POTION_SELF_SERVE: '1', POTION_MAGIC_LINK_IN_RESPONSE: '1' },
      'live',
    ).find((r) => r.name === 'POTION_MAGIC_LINK_IN_RESPONSE')!;
    expect(box.fatal).toBeUndefined();
    expect(box.warn).toContain('DANGEROUS COMBINATION');
  });

  it('a fatal gate REFUSES THE BOOT — the process does not take the port', () => {
    // A real BootGateLog, not a cast: the fake now has to actually match the
    // shape the function asks for, so a change to that shape breaks here.
    const log: BootGateLog = { info: () => {}, warn: () => {}, fatal: () => {} };
    expect(() => logBootGates(log, { NODE_ENV: 'production', POTION_DEV_AUTH: '1' }, 'live'))
      .toThrow(BootRefusedError);
    // ...and a clean production box still boots.
    expect(() =>
      logBootGates(log, {
        NODE_ENV: 'production', POTION_SELF_SERVE: '1', POTION_DEV_AUTH: '0',
        STRIPE_SECRET_KEY: 'sk_live_x', REDIS_URL: 'redis://x', SENTRY_DSN: 'https://x',
        POTION_PUBLIC_URL: 'https://api.withpotion.com', POTION_OPERATOR_TOKEN: 't',
      }, 'live'),
    ).not.toThrow();
  });

  it('bootFatals selects exactly the gates that refuse', () => {
    const rows = bootGateReport({ NODE_ENV: 'production', POTION_DEV_AUTH: '1' }, 'live');
    expect(bootFatals(rows).map((r) => r.name)).toEqual(['POTION_DEV_AUTH']);
    expect(bootFatals(bootGateReport({ NODE_ENV: 'production' }, 'live'))).toEqual([]);
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
    expect(bootFatals(rows)).toEqual([]);
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

  it('prints the EXACT Google redirect URI, derived from this box, not a doc', () => {
    // Google matches redirect_uri exactly and refuses a mismatch at the
    // first click. The runbook once spelled out withpotion.com while the
    // box carried POTION_APP_URL=https://app.withpotion.com — a fifteen
    // minute console job wasted on a wrong string. The log now states what
    // the flow will actually send, resolved by the same reader.
    const row = bootGateReport(
      {
        POTION_GOOGLE_CLIENT_ID: 'id',
        POTION_GOOGLE_CLIENT_SECRET: 's',
        POTION_APP_URL: 'https://app.withpotion.com',
      },
      'live',
    ).find((r) => r.name === 'sign in with Google');
    expect(row?.state).toContain('https://app.withpotion.com/api/auth/google/callback');

    // Change the host, and the printed URI changes with it.
    const apex = bootGateReport(
      { POTION_GOOGLE_CLIENT_ID: 'id', POTION_GOOGLE_CLIENT_SECRET: 's', POTION_APP_URL: 'https://withpotion.com' },
      'live',
    ).find((r) => r.name === 'sign in with Google');
    expect(apex?.state).toContain('https://withpotion.com/api/auth/google/callback');

    // An explicit override wins, because that is what the flow sends.
    const pinned = bootGateReport(
      {
        POTION_GOOGLE_CLIENT_ID: 'id',
        POTION_GOOGLE_CLIENT_SECRET: 's',
        POTION_APP_URL: 'https://withpotion.com',
        POTION_GOOGLE_REDIRECT_URI: 'https://other.example/cb',
      },
      'live',
    ).find((r) => r.name === 'sign in with Google');
    expect(pinned?.state).toContain('https://other.example/cb');
  });

  it('reports every gate on every boot, warning or not', () => {
    expect(bootGateReport({}, 'live').length).toBeGreaterThanOrEqual(8);
  });
});
