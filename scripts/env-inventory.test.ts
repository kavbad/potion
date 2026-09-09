// THE ENV INVENTORY GUARD (P2, external review 2026-09-05).
//
// The review's finding: env flags are read in code and never written down, so
// an operator cannot know what knobs exist. Measured properly (see
// env-inventory.ts for why the obvious grep gets this wrong in BOTH
// directions): 100 distinct variables read in shipped source, 29 documented.
// Among the 71 undocumented were STRIPE_SECRET_KEY, REDIS_URL and
// POTION_DEV_AUTH — whether real money can move, whether the rate limiter
// spans replicas, and whether /api/* requires authentication.
//
// THE RULE. Every environment variable read by shipped source is either
//   · named in .env.example — the operator's contract, or
//   · listed in INTERNAL below WITH A REASON — not an operator knob.
// A new flag has to be put in one bucket or the other, deliberately. That is
// the same ratchet discipline as the route inventory and the type-escape
// budget: it cannot be satisfied by accident.
//
// AND THE REVERSE. .env.example must not name a flag nothing reads. A
// deployment doc that lists a dead knob teaches an operator to set something
// that does nothing, which is how POTION_ROOT_SITE (documented, read nowhere)
// survived in the file this guard was written against.
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { deploymentFileNames, documentedNames, scanEnvUsage } from './env-inventory.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * Read by shipped source, but NOT an operator knob. Every entry needs a
 * reason that says who sets it instead — "internal" alone is not one.
 */
const INTERNAL: Record<string, string> = {
  VITEST: 'set by the test runner; context.ts uses it to isolate prices.json from the repo copy',
  NODE_ENV: 'set by the runtime and by the Dockerfile/compose, never hand-written into .env.prod — and since P1-2 the auth bypass is an allow-list, so an operator cannot open it by forgetting this',
  PORT: 'the container publishes 3000; compose maps the host port, so .env.prod never sets it',
  OTEL_SERVICE_NAME: 'written BY the app (otel.ts sets it from serviceName) rather than read from a deployment',
  REHEARSAL_LOG: 'a knob of the local Postgres rehearsal script, not of a deployment',
  NEXT_PUBLIC_SEED_DEMO: 'a dashboard BUILD-time flag baked into the bundle by Next, not a runtime deployment variable',
  POTION_API_KEY: 'never read as configuration — it appears in the code snippets the docs page GENERATES for a customer to paste',
};

describe('P2: the environment inventory', () => {
  const usage = scanEnvUsage(ROOT);
  const documented = documentedNames(ROOT);

  it('every flag shipped source reads is documented, or declared internal with a reason', () => {
    const undocumented = [...usage.keys()].filter(
      (name) => !documented.has(name) && INTERNAL[name] === undefined,
    );
    expect(
      undocumented,
      `Undocumented environment flags. Add each to .env.example (operator knob) or to ` +
        `INTERNAL in this file with a reason (not one):\n` +
        undocumented.map((n) => `  ${n}  — read in ${usage.get(n)!.slice(0, 2).join(', ')}`).join('\n'),
    ).toEqual([]);
  });

  it('.env.example names nothing that nothing consumes', () => {
    // NOT just TypeScript. Writing this rule as "read by src" nearly deleted
    // POTION_ROOT_SITE, which no TypeScript touches and which deploy/Caddyfile
    // needs for the bare-domain vhost — compose demands it with `:?`, so the
    // next deploy would have failed at startup. The consumer is CHECKED (the
    // deployment files are read), not exempted.
    const consumedElsewhere = deploymentFileNames(ROOT);
    const dead = [...documented].filter((n) => !usage.has(n) && !consumedElsewhere.has(n)).sort();
    expect(
      dead,
      `.env.example documents flags nothing consumes: ${dead.join(', ')}. ` +
        `Either the reader was deleted, or the name is misspelled in one of the two places.`,
    ).toEqual([]);
  });

  it('the site vars are the proof that rule needs — documented, no TS reader, alive', () => {
    for (const name of ['POTION_ROOT_SITE', 'POTION_API_SITE', 'POTION_APP_SITE']) {
      expect(documented.has(name)).toBe(true);
      expect(usage.has(name), `${name} now has a TS reader — this test's premise is stale`).toBe(false);
      expect(deploymentFileNames(ROOT).has(name), `${name} lost its deployment consumer`).toBe(true);
    }
  });

  it('every INTERNAL entry is still read, and still carries a real reason', () => {
    for (const [name, reason] of Object.entries(INTERNAL)) {
      expect(usage.has(name), `stale INTERNAL entry (nothing reads ${name} any more)`).toBe(true);
      expect(reason.length, `INTERNAL['${name}'] has no real reason`).toBeGreaterThan(30);
      expect(
        documented.has(name),
        `${name} is in BOTH .env.example and INTERNAL — pick one`,
      ).toBe(false);
    }
  });

  it('the scanner sees the injected-env pattern, not just process.env', () => {
    // The guard above is worthless if the scan cannot see how this repo reads
    // env. These four are read ONLY as `env.X` through an injected parameter;
    // the first version of the scan reported every one of them as unread.
    for (const name of ['PG_POOL_MAX', 'POTION_BREAKER_THRESHOLD', 'RESEND_API_KEY', 'POTION_OIDC_ISSUER']) {
      expect(usage.has(name), `scanner missed ${name} (injected-env pattern)`).toBe(true);
    }
    // ...and it must see the plain one too.
    expect(usage.has('POTION_MASTER_KEY')).toBe(true);
  });

  it('the inventory is big enough that the guard is doing work', () => {
    // A scan that silently started matching nothing would make every
    // assertion above pass vacuously.
    expect(usage.size).toBeGreaterThan(80);
  });
});
