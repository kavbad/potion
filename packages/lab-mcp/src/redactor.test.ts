// The grant-value redactor — known-value scrub, all encodings, fragments.
import { describe, expect, it } from 'vitest';
import {
  grantValueRedactor,
  REDACTED_FRAGMENT,
  REDACTED_GRANT,
  SPLIT_TOKEN_MIN_MATCH,
} from './redactor.js';

const TOKEN = 'gho_x9Q2mV7pLk4Rt8sWzE3yNb6JhD1cAf5uGiK0';
const REFRESH = 'ghr_M4nB8vC6xZ2aS0dF1gH3jK5lQ7wE9rT1yU3i';
const redact = grantValueRedactor([TOKEN, REFRESH]);

describe('grantValueRedactor', () => {
  it('scrubs the exact token wherever it appears in a result', () => {
    const out = redact({ note: `your bearer is ${TOKEN}, thanks`, other: 42 });
    expect(JSON.stringify(out)).not.toContain(TOKEN);
    expect(out.note).toContain(REDACTED_GRANT);
    expect(out.other).toBe(42);
  });

  it('scrubs base64, base64url, unpadded-base64, URL-encoded, and hex (both cases) forms', () => {
    const forms = [
      Buffer.from(TOKEN).toString('base64'),
      Buffer.from(TOKEN).toString('base64url'),
      Buffer.from(TOKEN).toString('base64').replace(/=+$/, ''),
      encodeURIComponent(TOKEN),
      Buffer.from(TOKEN).toString('hex'),
      Buffer.from(TOKEN).toString('hex').toUpperCase(),
    ];
    for (const form of forms) {
      const out = redact(`payload: ${form} end`) as string;
      expect(out, `form ${form.slice(0, 12)}… must be scrubbed`).not.toContain(form);
    }
  });

  it('hex is the Step 10 review addition: a server that hex-encodes the bearer it received is scrubbed', () => {
    const hex = Buffer.from(TOKEN).toString('hex');
    const out = redact({ note: `debug dump of your token: ${hex}` });
    expect(JSON.stringify(out)).not.toContain(hex);
    expect(out.note).toContain(REDACTED_GRANT);
  });

  it('scrubs BOTH held secrets (access + refresh) in one pass', () => {
    const out = redact(`a=${TOKEN} r=${REFRESH}`) as string;
    expect(out).not.toContain(TOKEN);
    expect(out).not.toContain(REFRESH);
  });

  it(`fragments ≥ ${SPLIT_TOKEN_MIN_MATCH} chars die (split-token, single result): a token chopped in two is still recognized`, () => {
    const front = TOKEN.slice(0, 20);
    const back = TOKEN.slice(20);
    const out = redact(`part1: ${front} ... part2: ${back}`) as string;
    expect(out).not.toContain(front);
    expect(out).not.toContain(back);
    expect(out).toContain(REDACTED_FRAGMENT);
  });

  it('sub-threshold shards survive — the NAMED Step 12 residual, pinned as a fact not a hope', () => {
    // A shard shorter than the fragment floor is not recognizable as a
    // piece of a token. Splitting across MANY results at this size is
    // exactly the Step 12 adversarial target recorded in the spec.
    const shard = TOKEN.slice(0, SPLIT_TOKEN_MIN_MATCH - 1);
    const out = redact(`piece: ${shard}`) as string;
    expect(out).toContain(shard);
  });

  it('walks nested structures and object keys', () => {
    const out = redact({ deep: [{ [`k-${TOKEN}`]: `v ${TOKEN}` }] });
    expect(JSON.stringify(out)).not.toContain(TOKEN);
  });

  it('leaves ordinary content byte-identical (no held secrets → identity)', () => {
    const value = { text: 'the user’s own data, theirs to keep', n: 1 };
    expect(grantValueRedactor([])(value)).toBe(value);
    expect(redact(value)).toEqual(value);
  });
});
