// Server-side alert emission (M4 #33, SPEC §13.5) — the twin of the
// workers' emitAlertEvent: enqueue `alerts:dispatch` when the context
// carries a queue (the normal server boot), else dispatch in-process (tests
// and queue-less contexts). Fire-and-forget by contract — callers wrap in
// try/catch exactly like shadow/guarantee emissions; an alert fault must
// never affect a served response or a refused one.
import { dispatchAlertEvent, type AlertsDispatchPayload } from '@potion/workers';
import type { PotionContext } from './context.js';
import { sendEmailFromEnv } from './email.js';

export async function emitAlert(ctx: PotionContext, payload: AlertsDispatchPayload): Promise<void> {
  if (ctx.queue) {
    await ctx.queue.enqueue('alerts:dispatch', payload);
    return;
  }
  await dispatchAlertEvent(ctx.db.db, payload, {
    sendEmail: (msg) => Promise.resolve(sendEmailFromEnv().sendEmail({ to: msg.to, subject: msg.subject, text: msg.text })).then(() => undefined),
  });
}
