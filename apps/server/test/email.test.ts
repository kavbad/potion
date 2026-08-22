import { describe, expect, it } from 'vitest';
import { resendSendEmail, sendEmailFromEnv } from '../src/email.js';

describe('email transport', () => {
  it('posts to Resend with from/to/subject/text and bearer auth', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => { calls.push({ url, init }); return new Response('{"id":"x"}', { status: 200 }); }) as unknown as typeof fetch;
    const send = resendSendEmail({ apiKey: 're_test', from: 'Potion <sign-in@withpotion.com>', fetchImpl });
    await send({ to: 'a@b.c', subject: 'Sign in', text: 'https://app.withpotion.com/api/auth/verify?token=ml_x' });
    expect(calls[0]!.url).toBe('https://api.resend.com/emails');
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe('Bearer re_test');
    expect(JSON.parse(calls[0]!.init.body as string)).toMatchObject({ from: 'Potion <sign-in@withpotion.com>', to: ['a@b.c'], subject: 'Sign in' });
  });
  it('a failed send throws with the status and never the link', async () => {
    const fetchImpl = (async () => new Response('nope', { status: 403 })) as unknown as typeof fetch;
    const send = resendSendEmail({ apiKey: 'k', from: 'f@x.y', fetchImpl });
    await expect(send({ to: 'a@b.c', subject: 's', text: 'SECRET-LINK' })).rejects.toThrow(/HTTP 403/);
    await expect(send({ to: 'a@b.c', subject: 's', text: 'SECRET-LINK' })).rejects.not.toThrow(/SECRET-LINK/);
  });
  it('selects Resend only when both env values are present', () => {
    expect(sendEmailFromEnv({}).transport).toBe('log');
    expect(sendEmailFromEnv({ RESEND_API_KEY: 'k' }).transport).toBe('log');
    expect(sendEmailFromEnv({ RESEND_API_KEY: 'k', POTION_EMAIL_FROM: 'f@x.y' }).transport).toBe('resend');
  });
});

describe('magic link delivery is best-effort', () => {
  it('a failing transport never fails the request: the link is still issued and logged', async () => {
    const { issueMagicLink } = await import('../src/routes/auth.js');
    const { createDb, migrate, createOrg } = await import('@potion/db');
    const h = await createDb('pglite://');
    await migrate(h.db);
    await createOrg(h.db, { id: 'org-x', name: 'x' });
    const logs: string[] = [];
    const orig = console.log; const origWarn = console.warn;
    console.log = (m: string) => { logs.push(String(m)); }; console.warn = (m: string) => { logs.push(String(m)); };
    try {
      const link = await issueMagicLink(h.db, 'a@b.c', 'org-x', 'https://app.example', async () => { throw new Error('resend: HTTP 403'); });
      expect(link).toMatch(/auth\/verify\?token=ml_/);
      expect(logs.join('\n')).toMatch(/delivery failed/);
      expect(logs.join('\n')).toContain(link);
    } finally { console.log = orig; console.warn = origWarn; await h.close(); }
  });
});
