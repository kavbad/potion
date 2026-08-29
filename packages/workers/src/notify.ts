// X3 — run-event notifications: the supervised loop must actually LOOP.
// A check-in that waits on a page nobody has open makes born-supervised a
// polite fiction, and a worker that failed in the night must be heard
// about. One email per event, to the org's admins, deep-linked.
//
// Transport mirrors apps/server/src/email.ts (Resend by env, log
// otherwise) — duplicated here deliberately: workers must not import the
// server app, and the twin is ~20 lines. Keep the two in step.
import { getUserById, listMembershipsByOrg, type PotionDb } from '@potion/db';

export interface NotifyMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export type SendNotify = (msg: NotifyMessage) => Promise<void>;

export function notifySenderFromEnv(env: NodeJS.ProcessEnv = process.env): SendNotify {
  const apiKey = env.RESEND_API_KEY?.trim();
  const from = env.POTION_EMAIL_FROM?.trim();
  if (apiKey && from) {
    return async (msg) => {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from, to: [msg.to], subject: msg.subject, text: msg.text, ...(msg.html !== undefined ? { html: msg.html } : {}) }),
      });
      if (!res.ok) throw new Error(`resend: HTTP ${res.status} sending to ${msg.to}`);
    };
  }
  return async (msg) => {
    console.log(`[potion notify] ${msg.to} :: ${msg.subject}\n${msg.text}`);
  };
}

export interface RunEvent {
  orgId: string;
  runId: string;
  harnessName: string;
  state: 'awaiting-human' | 'completed' | 'failed' | 'killed-budget';
  question?: string | undefined;
  reason?: string | undefined;
  hasDeliverable?: boolean;
}

function appUrl(env: NodeJS.ProcessEnv = process.env): string {
  return (env.POTION_APP_URL ?? 'https://withpotion.com').replace(/\/$/, '');
}

export function composeRunEvent(ev: RunEvent, env: NodeJS.ProcessEnv = process.env): { subject: string; text: string } {
  const link = `${appUrl(env)}/lab/run/${ev.runId}`;
  switch (ev.state) {
    case 'awaiting-human':
      return {
        subject: `${ev.harnessName} needs a decision`,
        text:
          `Your worker paused and is waiting for you.\n\n` +
          (ev.question !== undefined ? `It asks: ${ev.question}\n\n` : '') +
          `Answer here: ${link}\n\n— Potion`,
      };
    case 'completed':
      return {
        subject: ev.hasDeliverable === true ? `${ev.harnessName} filed its check` : `${ev.harnessName} completed a run`,
        text:
          (ev.hasDeliverable === true
            ? `The deliverable is in, with receipts on every step.\n\n`
            : `The run completed.\n\n`) +
          `Read it: ${link}\n\n— Potion`,
      };
    case 'failed':
      return {
        subject: `${ev.harnessName} stopped: it needs attention`,
        text: `The run failed${ev.reason !== undefined ? ` — ${ev.reason}` : ''}.\n\nSee what happened: ${link}\n\n— Potion`,
      };
    case 'killed-budget':
      return {
        subject: `${ev.harnessName} hit its spending cap`,
        text: `The hard stop did its job — the run was stopped at the budget line.\n\nDetails: ${link}\n\n— Potion`,
      };
  }
}

/** Notify every org admin about a run event. Best-effort: a delivery
 * failure logs and never fails the run's own handling. Gated by
 * POTION_NOTIFY ('0' disables). */
export async function notifyRunEvent(
  db: PotionDb,
  ev: RunEvent,
  send: SendNotify = notifySenderFromEnv(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  if (env.POTION_NOTIFY === '0') return 0;
  const members = await listMembershipsByOrg(db, ev.orgId);
  const admins = members.filter((m) => m.role === 'admin');
  const { subject, text } = composeRunEvent(ev, env);
  let sent = 0;
  for (const m of admins) {
    const user = await getUserById(db, m.userId);
    if (user === null) continue;
    try {
      await send({ to: user.email, subject, text });
      sent += 1;
    } catch (e) {
      console.warn(`[potion notify] delivery failed for ${user.email}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return sent;
}
