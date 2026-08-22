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
