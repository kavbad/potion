// Email delivery for magic links. Production had NONE (deploy plan D5 assumed
// operator hand-delivery) — which meant the operator could not sign in to
// their own product (2026-08-22). Resend is the transport: an HTTPS API, no
// mail server, a verified sending domain.
//
// Selection is by environment: RESEND_API_KEY + POTION_EMAIL_FROM present →
// Resend; otherwise the log-only default (dev, sandbox, tests). Self-serve
// signup stays off regardless — this only DELIVERS links the server already
// decided to issue.
import type { EmailMessage, SendEmail } from './routes/auth.js';
import { logSendEmail } from './routes/auth.js';

export function resendSendEmail(opts: { apiKey: string; from: string; fetchImpl?: typeof fetch }): SendEmail {
  const f = opts.fetchImpl ?? fetch;
  return async (msg: EmailMessage) => {
    const res = await f('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${opts.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: opts.from, to: [msg.to], subject: msg.subject, text: msg.text }),
    });
    if (!res.ok) {
      // Never leak the link into logs on failure — only the status.
      throw new Error(`resend: HTTP ${res.status} sending to ${msg.to}`);
    }
  };
}

/** The transport the environment selects. Logged once at boot by the caller. */
export function sendEmailFromEnv(env: NodeJS.ProcessEnv = process.env): { sendEmail: SendEmail; transport: 'resend' | 'log' } {
  const apiKey = env.RESEND_API_KEY?.trim();
  const from = env.POTION_EMAIL_FROM?.trim();
  if (apiKey && from) return { sendEmail: resendSendEmail({ apiKey, from }), transport: 'resend' };
  return { sendEmail: logSendEmail, transport: 'log' };
}
