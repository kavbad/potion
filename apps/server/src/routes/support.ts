// P2-9: the support channel. One POST that lands a message in the founder's
// inbox with the org/user context attached — no ticket system, no new
// accounts, the same Resend transport that already delivers magic links and
// alerts. Delivery is NOT best-effort here: a support message that silently
// vanishes is worse than an error, so a failed send returns 502 and the UI
// tells the user to email directly.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getUserById } from '@potion/db';
import { openAiError } from '../auth.js';
import { sendEmailFromEnv } from '../email.js';
import type { PotionContext } from '../context.js';

const SUPPORT_EMAIL_DEFAULT = 'kavon@mutiny.ai';

const SupportBody = z
  .object({
    message: z.string().min(1).max(4000),
    page: z.string().max(200).optional(),
  })
  .strict();

export function registerSupportRoutes(app: FastifyInstance, ctx: PotionContext): void {
  app.post('/api/support', async (req, reply) => {
    const org = req.potionOrg;
    if (!org) {
      return reply.code(401).send(openAiError('authentication required', 'invalid_request_error', 'authentication_required'));
    }
    const parsed = SupportBody.safeParse(req.body);
    if (!parsed.success) {
      const message = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
      return reply.code(400).send(openAiError(message, 'invalid_request_error'));
    }
    const to = process.env.POTION_SUPPORT_EMAIL?.trim() || SUPPORT_EMAIL_DEFAULT;
    const { sendEmail, transport } = sendEmailFromEnv();
    const user = org.userId ? await getUserById(ctx.db.db, org.userId) : null;
    const who = user?.email ?? 'an api key (no human identity)';
    try {
      await sendEmail({
        to,
        subject: `[Potion support] ${org.orgId}`,
        text:
          `From: ${who} (org ${org.orgId}, role ${org.role})\n` +
          (parsed.data.page ? `Page: ${parsed.data.page}\n` : '') +
          `\n${parsed.data.message}\n`,
      });
    } catch {
      return reply
        .code(502)
        .send(openAiError(`could not deliver your message — email ${to} directly`, 'server_error', 'support_delivery_failed'));
    }
    return reply.send({ ok: true, transport });
  });
}
