// Team invites (P0-2, 2026-08-24): admin invites an email with a role; the
// invitee signs in with the normal magic link; verification converts the
// invite into the membership. The invitation email carries no token — the
// magic-link flow is the only credential path.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  createInvite,
  listInvites,
  getOrgById,
  getUserById,
  listMembersWithEmail,
  openInviteForEmail,
  revokeInvite,
} from '@potion/db';
import { openAiError, requireRole } from '../auth.js';
import type { PotionContext } from '../context.js';
import { sendEmailFromEnv } from '../email.js';

const InviteBody = z.object({
  email: z.string().email().max(254),
  role: z.enum(['admin', 'member', 'viewer']),
});

export function registerInviteRoutes(app: FastifyInstance, ctx: PotionContext, opts: { appUrl?: string } = {}): void {
  const db = ctx.db.db;

  app.get('/api/members', { preHandler: [requireRole('viewer')] }, async (req, reply) => {
    const org = req.potionOrg!;
    const members = await listMembersWithEmail(db, org.orgId);
    return reply.send({ members: members.map((m) => ({ email: m.email, role: m.role, since: m.createdAt })) });
  });

  app.get('/api/invites', { preHandler: [requireRole('admin')] }, async (req, reply) => {
    const org = req.potionOrg!;
    const rows = await listInvites(db, org.orgId);
    return reply.send({
      invites: rows.map((r) => ({
        id: r.id,
        email: r.email,
        role: r.role,
        invitedBy: r.invitedBy,
        createdAt: r.createdAt,
        status: r.acceptedAt ? 'accepted' : r.revokedAt ? 'revoked' : 'open',
      })),
    });
  });

  app.post('/api/invites', { preHandler: [requireRole('admin')] }, async (req, reply) => {
    const org = req.potionOrg!;
    const parsed = InviteBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send(openAiError('a valid email and a role (admin | member | viewer) are required', 'invalid_request_error'));
    }
    const { email, role } = parsed.data;
    const existingOpen = await openInviteForEmail(db, email, org.orgId);
    if (existingOpen) {
      return reply.code(409).send(openAiError(`an open invite for ${email} already exists`, 'invalid_request_error', 'invite_exists'));
    }
    const inviter = org.userId ? await getUserById(db, org.userId) : null;
    const invite = await createInvite(db, { orgId: org.orgId, email, role, invitedBy: inviter?.email ?? 'admin' });
    const appUrl = opts.appUrl ?? process.env.POTION_APP_URL ?? 'https://app.withpotion.com';
    const orgRow = await getOrgById(db, org.orgId);
    try {
      await sendEmailFromEnv().sendEmail({
        to: email,
        subject: `You've been invited to ${orgRow?.name ?? 'a team'} on Potion`,
        text: `You've been invited to join ${orgRow?.name ?? 'a team'} on Potion as ${role}.\n\nSign in with this email address to accept:\n${appUrl}/login\n\nThe invite is valid for 7 days. If you weren't expecting this, ignore it.\n`,
      });
    } catch (e) {
      req.log.warn(`invite email to ${email} failed: ${e instanceof Error ? e.message : String(e)} — the invite still stands; sign-in with the address accepts it`);
    }
    return reply.send({ id: invite.id, email, role, status: 'open' });
  });

  app.delete('/api/invites/:id', { preHandler: [requireRole('admin')] }, async (req, reply) => {
    const org = req.potionOrg!;
    const { id } = req.params as { id: string };
    if (!/^[0-9a-f-]{36}$/.test(id)) return reply.code(404).send(openAiError('unknown invite', 'invalid_request_error', 'not_found'));
    const ok = await revokeInvite(db, org.orgId, id);
    if (!ok) return reply.code(404).send(openAiError('unknown invite (or already accepted/revoked)', 'invalid_request_error', 'not_found'));
    return reply.send({ revoked: true });
  });
}
