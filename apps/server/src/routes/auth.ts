// Magic-link auth routes (M2 Wave 2, ROADMAP #14) — passwordless sign-in for
// the dashboard, plus org administration (invite). Raw tokens are NEVER
// stored: only sha256(token) lands in sessions/magic_links (migration 0004).
//
//   POST /auth/request-link {email}
//     Create-or-get the user by email. First signup AUTO-PROVISIONS a solo
//     org (named after the email domain, "Personal" when there is none) with
//     an admin membership; subsequent sign-ins use the user's first
//     membership. New users can ONLY join an EXISTING org via /auth/invite.
//     Mints a 15-min, single-use magic link and delivers it via the pluggable
//     sendEmail (default: logs the link — dev). Always 200 (no account
//     enumeration); in dev mode (see devAuthBypassEnabled) the response ALSO
//     carries devLink so the login page can show it.
//   GET /auth/verify?token=ml_…
//     Consumes the link (single-use + expiry), creates a 7-day session pinned
//     to the link's org, sets the httpOnly SESSION_COOKIE (dashboard) AND
//     returns the raw ps_… bearer token (API clients).
//   POST /auth/logout
//     Revokes the caller's session (cookie or bearer) and clears the cookie.
//     Idempotent: always 200.
//   POST /auth/invite {email, role?}
//     ADMIN ONLY (RBAC). Create-or-get the user, add them to the INVITER's
//     org (default role 'member'), mint + deliver a magic link pinned to
//     that org.
//   GET /auth/me
//     The caller's session identity (user/org/role) — powers the dashboard
//     nav badge. 401 when unauthenticated (dev bypass OFF).
//
// EMAIL DELIVERY: the SendEmail interface is pluggable (buildServer opts /
// registerAuthRoutes opts). The default logs the link. SMTP is a documented
// TODO — wire POTION_SMTP_HOST / POTION_SMTP_PORT / POTION_SMTP_USER /
// POTION_SMTP_PASS / POTION_SMTP_FROM to a real transport (e.g. nodemailer)
// outside the sandbox; there is NO live email in this build.
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { sha256 } from '@potion/core';
import {
  ROLES,
  consumeMagicLink,
  createMagicLink,
  createMembership,
  createOrg,
  createSession,
  createUser,
  getOrgById,
  getUserByEmail,
  getUserById,
  insertAuthEvent,
  listMembershipsByUser,
  purgeExpired,
  revokeSession,
  type AuthEventKind,
  type AuthEventMethod,
  type PotionDb,
  type Role, openInviteForEmail, markInviteAccepted } from '@potion/db';
import {
  SESSION_COOKIE,
  bearerToken,
  authenticateSession,
  devAuthBypassEnabled,
  openAiError,
  parseCookies,
  requireRole,
  resolveRequestAuth,
} from '../auth.js';
import type { PotionContext } from '../context.js';
import { sendEmailFromEnv } from '../email.js';
import { googleConfigFromEnv, oidcConfigFromEnv } from '../oidc.js';

/** Session + magic-link TTLs. */
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
export const MAGIC_LINK_TTL_MS = 15 * 60 * 1000; // 15 minutes

// ---------------------------------------------------------------------------
// Pluggable email delivery (see file header — SMTP is a documented TODO)
// ---------------------------------------------------------------------------

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  /** Optional HTML body (2026-08-28: the plain-text-only email showed a raw
   * 51-char URL that some clients never linkified — a user transcribed it
   * by hand, three times, mangled: rM_DN2e0yf6…). */
  html?: string;
}

export type SendEmail = (msg: EmailMessage) => Promise<void>;

/** Default delivery: LOG the link (dev / sandbox). The login page also shows
 * the link when the dev bypass is on. TODO(prod): SMTP transport via
 * POTION_SMTP_HOST / POTION_SMTP_PORT / POTION_SMTP_USER / POTION_SMTP_PASS /
 * POTION_SMTP_FROM (e.g. nodemailer) — no live email in this build. */
export const logSendEmail: SendEmail = async (msg) => {
  console.log(`[potion auth] magic link for ${msg.to}:\n${msg.text}`);
};

export interface AuthRouteOptions {
  sendEmail?: SendEmail;
  /** Public base URL used inside magic links (default: request origin). */
  publicBaseUrl?: string;
  /** Whether the Google routes were ACTUALLY registered, for
   * /auth/providers. Passed in rather than re-derived from env, because the
   * routes themselves can be configured by injection (BuildServerOptions
   * .googleAuth) — and a /auth/providers that consults a different source
   * than the router is exactly the drift this endpoint exists to prevent.
   * Default: what env alone would decide. */
  googleEnabled?: boolean;
}

const EmailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email()
  .max(320);

const RequestLinkBodySchema = z.object({ email: EmailSchema });

const InviteBodySchema = z.object({
  email: EmailSchema,
  role: z.enum(ROLES as [Role, ...Role[]]).default('member'),
});

function newToken(prefix: 'ml' | 'ps'): string {
  return `${prefix}_${randomBytes(prefix === 'ml' ? 24 : 32).toString('hex')}`;
}

/**
 * Where a magic link must point: the DEPLOYED DASHBOARD's verify proxy
 * (`${POTION_APP_URL}/api/auth/verify`), which sets the session cookie on the
 * host the person actually uses. Never the request's own Host header in
 * production: the dashboard reaches the API as `server:3000` inside compose,
 * and a link built from that is unreachable from a mail client (shipped
 * once, 2026-08-22, the first time a real email went out). The operator
 * route had this fix since the rehearsal; this is the self-serve path.
 */
export function baseUrlOf(req: Pick<FastifyRequest, 'protocol' | 'headers'>, override?: string, appUrl = process.env.POTION_APP_URL): string {
  if (override) return override.replace(/\/$/, '');
  if (appUrl && appUrl.trim() !== '') return `${appUrl.replace(/\/$/, '')}/api`;
  const proto = req.protocol || 'http';
  const host = req.headers.host ?? 'localhost:3000';
  return `${proto}://${host}`;
}

/** Solo-org display name for first signup: the email domain ("acme.com"),
 * or "Personal" for domain-less/dev emails. */
export function soloOrgName(email: string): string {
  const domain = email.split('@')[1]?.trim();
  return domain || 'Personal';
}

/** User display name from the email local part. */
function userNameFromEmail(email: string): string {
  return email.split('@')[0] ?? email;
}

/**
 * Create-or-get a user by email. First signup auto-provisions a solo org
 * (named after the email domain, "Personal" when there is none) + admin
 * membership; existing users keep their FIRST membership's org. A user with
 * NO memberships (only possible via manual db edits — invite is the only
 * join path) gets a fresh solo org so sign-in never dead-ends.
 *
 * Shared by the magic-link flow AND the OIDC callback (M4 #34) — the
 * auto-provision contract is identical for both sign-in methods.
 */
export async function provisionForEmail(
  db: PotionDb,
  email: string,
): Promise<{ userId: string; orgId: string }> {
  const existing = await getUserByEmail(db, email);
  if (existing) {
    const first = (await listMembershipsByUser(db, existing.id))[0];
    if (first) return { userId: existing.id, orgId: first.orgId };
    const orgId = `org-${randomUUID().slice(0, 8)}`;
    await createOrg(db, { id: orgId, name: soloOrgName(email) });
    await createMembership(db, { orgId, userId: existing.id, role: 'admin' });
    return { userId: existing.id, orgId };
  }
  const userId = `usr-${randomUUID().slice(0, 8)}`;
  const orgId = `org-${randomUUID().slice(0, 8)}`;
  await createUser(db, { id: userId, email, name: userNameFromEmail(email) });
  await createOrg(db, { id: orgId, name: soloOrgName(email) });
  await createMembership(db, { orgId, userId, role: 'admin' });
  return { userId, orgId };
}

/**
 * Record an auth event (M4 #34, SPEC §13.6, migration 0012): login /
 * logout / invite via magic-link or OIDC. actor is the actor's EMAIL; ip +
 * requestId come from the request for observability correlation. detail
 * NEVER carries credentials or tokens.
 */
export async function recordAuthEvent(
  db: PotionDb,
  req: FastifyRequest,
  event: {
    orgId: string;
    kind: AuthEventKind;
    method: AuthEventMethod;
    actor: string;
    detail?: Record<string, unknown>;
  },
): Promise<void> {
  await insertAuthEvent(db, {
    id: `aev-${randomUUID()}`,
    orgId: event.orgId,
    kind: event.kind,
    method: event.method,
    actor: event.actor,
    ip: req.ip,
    requestId: String(req.id),
    ...(event.detail !== undefined ? { detail: event.detail } : {}),
  });
}

/**
 * Self-serve org provisioning gate (G2.7): the auto-provision path (any
 * email → new solo org, admin) is an operator decision, not a default.
 * POTION_SELF_SERVE=1/0 overrides explicitly; unset defaults to ON only
 * when the dev bypass is on (walkthrough/tests), OFF otherwise — production
 * onboarding is operator-credentialed (POST /operator/orgs).
 */
export function selfServeEnabled(): boolean {
  const v = process.env.POTION_SELF_SERVE;
  if (v === '1') return true;
  if (v === '0') return false;
  return devAuthBypassEnabled();
}

/**
 * Return the magic link IN THE RESPONSE instead of only emailing/logging it.
 *
 * There is no SMTP (honest-stub convention), so with self-serve ON in
 * production a signup completes, the org is created, and the link exists
 * only in the server log — the person who signed up can never sign in. This
 * flag closes that loop for a PRIVATE deployment being tested.
 *
 * It is off unless explicitly set, and it is deliberately its own flag
 * rather than riding `POTION_SELF_SERVE`, because the two decisions are
 * different: one opens signup, this one hands the caller a session-minting
 * token for whatever email they typed. With both on, anyone who can reach
 * the endpoint can sign in AS any address — fine for a closed test box,
 * never for a public one. Real SMTP is what retires it.
 */
export function magicLinkInResponseEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.POTION_MAGIC_LINK_IN_RESPONSE;
  return v === '1' || v?.toLowerCase() === 'true';
}

/**
 * Mint + record + deliver a magic link (G2.7 extraction: the operator
 * create-org route issues links outside this module's route closure).
 * Returns the raw link — the CALLER decides whether to surface it (dev
 * bypass / operator hand-delivery) or rely on the email side effect.
 */
/** The code credential's stored preimage — bound to the (lowercased) email
 * so eight digits alone identify nothing. */
export function signInCodePreimage(email: string, code: string): string {
  return `code:${email.trim().toLowerCase()}:${code.replace(/\D/g, '')}`;
}

export async function issueMagicLink(
  db: PotionDb,
  email: string,
  orgId: string,
  baseUrl: string,
  sendEmail: SendEmail,
): Promise<string> {
  const token = newToken('ml');
  await createMagicLink(db, {
    tokenHash: sha256(token),
    email,
    orgId,
    expiresAt: new Date(Date.now() + MAGIC_LINK_TTL_MS),
  });
  // The TYPE-ABLE fallback (2026-08-28): a second single-use credential —
  // eight digits a human can carry between devices without transcribing a
  // 51-char URL (which a real user did, by hand, mangled, three times).
  // Stored as its own magic-link row: same TTL, same atomic single-use
  // consume; the hash binds the code to the EMAIL so a code is meaningless
  // without knowing whose it is.
  const code = String(randomInt(10000000, 100000000)); // crypto-grade (node:crypto)
  await createMagicLink(db, {
    tokenHash: sha256(signInCodePreimage(email, code)),
    email,
    orgId,
    expiresAt: new Date(Date.now() + MAGIC_LINK_TTL_MS),
  });
  const codeShown = `${code.slice(0, 4)} ${code.slice(4)}`;
  const link = `${baseUrl}/auth/verify?token=${encodeURIComponent(token)}`;
  const message = {
    to: email,
    subject: 'Your Potion sign-in link',
    text:
      `Sign in to Potion: ${link}\n\n` +
      `On another device? Enter this code on the sign-in page instead: ${codeShown}\n\n` +
      `Link and code are single-use and expire in 15 minutes. If you did not request them, ignore this email.\n\n` +
      `— Potion, a product by Mutiny`,
    html:
      `<div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:480px;margin:0 auto;padding:24px 8px;color:#1c1a17">` +
      `<p style="font-size:15px">Sign in to Potion:</p>` +
      `<p><a href="${link}" style="display:inline-block;background:#1c1a17;color:#f4f2ec;text-decoration:none;padding:12px 22px;font-size:15px;font-weight:600">Sign in &rarr;</a></p>` +
      `<p style="font-size:13px;color:#6f6a5e">On another device? Enter this code on the sign-in page instead:</p>` +
      `<p style="font-family:ui-monospace,Menlo,monospace;font-size:24px;letter-spacing:0.12em;margin:4px 0 16px">${codeShown}</p>` +
      `<p style="font-size:12px;color:#8a857a">Link and code are single-use and expire in 15 minutes. If you did not request them, ignore this email.<br>&mdash; Potion, a product by Mutiny</p>` +
      `</div>`,
  };
  try {
    await sendEmail(message);
  } catch (e) {
    // Delivery is best-effort; the LINK is the product. A failed send must
    // never 500 the request (2026-08-22: Resend 403 on an unverified domain
    // took sign-in down entirely) — log the failure and fall back to the
    // log transport so the operator can hand-deliver.
    console.warn(`[potion auth] email delivery failed for ${email}: ${e instanceof Error ? e.message : String(e)} — falling back to log`);
    await logSendEmail(message);
  }
  return link;
}

export function registerAuthRoutes(
  app: FastifyInstance,
  ctx: PotionContext,
  opts: AuthRouteOptions = {},
): void {
  const db = ctx.db.db;
  const sendEmail = opts.sendEmail ?? sendEmailFromEnv().sendEmail;

  // Housekeeping on boot: dead sessions + consumed/expired links are purged
  // (idempotent; live rows untouched).
  app.addHook('onReady', async () => {
    await purgeExpired(db);
  });

  const deliverMagicLink = (email: string, orgId: string, baseUrl: string): Promise<string> =>
    issueMagicLink(db, email, orgId, baseUrl, sendEmail);

  /** Module-level provisioning shared with the OIDC callback (M4 #34). */
  const provision = (email: string) => provisionForEmail(db, email);

  // ---------- GET /auth/providers ----------
  // WHICH DOORS ARE ACTUALLY OPEN (2026-09-04). The login page needs this
  // before it can draw anything: a "Continue with Google" button on a
  // deployment with no Google client is a button that leads to a 404, and
  // a dead sign-in button is worse than no sign-in button. Deriving it from
  // a second NEXT_PUBLIC_* env var on the dashboard would put the answer in
  // two places and let them drift; this endpoint is the one place that
  // knows, because it asks the same config readers the routes gate on.
  //
  // Public and deliberately contentless: it names sign-in METHODS, never
  // whether an account exists, and it reveals nothing an anonymous visitor
  // could not learn by clicking the buttons.
  app.get('/auth/providers', async (_req, reply) =>
    reply.send({
      providers: {
        magicLink: true, // always — the floor of the sign-in contract
        google: opts.googleEnabled ?? googleConfigFromEnv() !== null,
        oidc: oidcConfigFromEnv() !== null,
      },
      selfServe: selfServeEnabled(),
    }),
  );

  // ---------- POST /auth/request-link ----------
  app.post('/auth/request-link', async (req, reply) => {
    const parsed = RequestLinkBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send(openAiError('a valid email is required', 'invalid_request_error'));
    }
    const { email } = parsed.data;
    // G2.7 self-serve gate: when OFF, only emails with an EXISTING
    // membership get provisioned+linked; unknown emails get the SAME
    // neutral response (no enumeration) and NO rows are written.
    if (!selfServeEnabled()) {
      const existing = await getUserByEmail(db, email);
      const hasMembership =
        existing !== null && (await listMembershipsByUser(db, existing.id)).length > 0;
      if (!hasMembership) {
        // Team invites (P0-2, 2026-08-24): an open invite authorizes this
        // email — the link is bound to the INVITE's org and verification
        // converts it into the membership. Without one, silent ok as before.
        const invite = await openInviteForEmail(db, email);
        if (invite === null) {
          // HONEST CLOSED DOOR (2026-09-02): selfServe is deployment-static
          // (identical for every email — no enumeration change). The login
          // page uses it to say "invite-only" instead of promising an email
          // that was deliberately never sent (the lie cost a live demo).
          return reply.send({ ok: true, email, selfServe: false });
        }
        if (existing === null) {
          await createUser(db, { id: `usr-${randomUUID().slice(0, 8)}`, email, name: userNameFromEmail(email) });
        }
        const link = await deliverMagicLink(email, invite.orgId, baseUrlOf(req, opts.publicBaseUrl));
        const dev = devAuthBypassEnabled() || magicLinkInResponseEnabled() ? { devLink: link } : {};
        return reply.send({ ok: true, email, selfServe: false, ...dev });
      }
    }
    const { orgId } = await provision(email);
    const link = await deliverMagicLink(email, orgId, baseUrlOf(req, opts.publicBaseUrl));
    // No account enumeration: identical response either way. devLink is
    // dev-only (documented bypass semantics) — the login page shows it.
    // POTION_MAGIC_LINK_IN_RESPONSE additionally surfaces it in production,
    // which is the only way a self-serve signup can complete without SMTP.
    const dev =
      devAuthBypassEnabled() || magicLinkInResponseEnabled() ? { devLink: link } : {};
    return reply.send({ ok: true, email, selfServe: selfServeEnabled(), ...dev });
  });

  // ---------- GET /auth/verify ----------
  /** Everything after a credential is CONSUMED — link and code share it
   * verbatim, so the two paths cannot drift (2026-08-28). */
  async function completeSignIn(req: FastifyRequest, reply: FastifyReply, link: { email: string; orgId: string }) {
    const user = await getUserByEmail(db, link.email);
    if (!user) {
      return reply
        .code(401)
        .send(openAiError('no user for this link', 'invalid_request_error', 'invalid_token'));
    }
    // Team invites: a link bound to an org the user is not yet a member of
    // is the acceptance — email possession is proven by the link itself.
    const memberOf = await listMembershipsByUser(db, user.id);
    if (!memberOf.some((m) => m.orgId === link.orgId)) {
      const invite = await openInviteForEmail(db, link.email, link.orgId);
      if (!invite) {
        return reply
          .code(401)
          .send(openAiError('no membership or open invite for this org', 'invalid_request_error', 'invalid_token'));
      }
      await createMembership(db, { orgId: link.orgId, userId: user.id, role: invite.role });
      await markInviteAccepted(db, invite.id);
      await recordAuthEvent(db, req, { orgId: link.orgId, kind: 'login', method: 'magic_link', actor: `${user.email} (invite accepted)` });
    }
    const sessionToken = newToken('ps');
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    const session = await createSession(db, {
      id: `ses-${randomUUID().slice(0, 8)}`,
      userId: user.id,
      tokenHash: sha256(sessionToken),
      orgId: link.orgId,
      expiresAt,
    });
    // M4 #34: auth trail for the unified audit export.
    await recordAuthEvent(db, req, {
      orgId: link.orgId,
      kind: 'login',
      method: 'magic_link',
      actor: user.email,
    });
    // httpOnly cookie for the dashboard; the raw token is ALSO returned for
    // API clients (bearer). Secure flag is set by the deploying proxy (TODO
    // in prod docs); SameSite=Lax keeps top-level email-link navigation working.
    reply.header(
      'set-cookie',
      `${SESSION_COOKIE}=${sessionToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
    );
    return reply.send({
      ok: true,
      token: sessionToken,
      session: {
        id: session.id,
        userId: user.id,
        email: user.email,
        orgId: link.orgId,
        expiresAt: expiresAt.toISOString(),
      },
    });
  }

  // ---------- POST /auth/verify-code ----------
  // The type-able path (2026-08-28): eight digits from the email, entered on
  // the sign-in page — for the person reading the email on one device and
  // signing in on another. Same single-use consume, same TTL, same session
  // mint as the link (completeSignIn is shared verbatim). Attempts are
  // limited per email (in-memory: honest for a single-instance deploy;
  // consume itself is atomic regardless).
  const codeAttempts = new Map<string, { n: number; resetAt: number }>();
  app.post('/auth/verify-code', async (req, reply) => {
    const parsed = z
      .object({ email: z.string().email().max(320), code: z.string().min(8).max(12) })
      .safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send(openAiError('email and the 8-digit code are required', 'invalid_request_error'));
    }
    const email = parsed.data.email.trim().toLowerCase();
    const now = Date.now();
    const slot = codeAttempts.get(email);
    if (slot !== undefined && slot.resetAt > now && slot.n >= 6) {
      return reply.code(429).send(openAiError('too many attempts — request a fresh email and try again in a few minutes', 'invalid_request_error', 'rate_limited'));
    }
    codeAttempts.set(email, slot !== undefined && slot.resetAt > now ? { n: slot.n + 1, resetAt: slot.resetAt } : { n: 1, resetAt: now + 15 * 60_000 });
    const link = await consumeMagicLink(db, sha256(signInCodePreimage(email, parsed.data.code)));
    if (!link) {
      return reply
        .code(401)
        .send(openAiError('invalid, expired, or already-used code — request a fresh email', 'invalid_request_error', 'invalid_token'));
    }
    codeAttempts.delete(email);
    return completeSignIn(req, reply, link);
  });

  app.get('/auth/verify', async (req, reply) => {
    const { token } = req.query as { token?: string };
    if (!token) {
      return reply.code(400).send(openAiError('missing token', 'invalid_request_error'));
    }
    const link = await consumeMagicLink(db, sha256(token));
    if (!link) {
      return reply
        .code(401)
        .send(openAiError('invalid, expired, or already-used link', 'invalid_request_error', 'invalid_token'));
    }
    return completeSignIn(req, reply, link);
  });

  // ---------- POST /auth/logout ----------
  app.post('/auth/logout', async (req, reply) => {
    const token =
      bearerToken(req.headers.authorization) ?? parseCookies(req.headers.cookie)[SESSION_COOKIE];
    const auth = await authenticateSession(db, token ?? null);
    if (auth) {
      await revokeSession(db, auth.session.id);
      // M4 #34: auth trail (best-effort actor lookup; logout stays
      // idempotent — an unknown user row never fails the request).
      const user = await getUserById(db, auth.session.userId);
      if (user) {
        await recordAuthEvent(db, req, {
          orgId: auth.session.orgId,
          kind: 'logout',
          method: 'magic_link',
          actor: user.email,
        });
      }
    }
    reply.header(
      'set-cookie',
      `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
    );
    return reply.send({ ok: true }); // idempotent: unknown/dead sessions → ok
  });

  // ---------- POST /auth/invite (admin only) ----------
  // /auth/* routes are NOT covered by the /api/* dashboard hook, so invite
  // resolves the caller itself (same resolution order, dev bypass included)
  // before requireRole('admin') gates on the resolved OrgContext role.
  app.post(
    '/auth/invite',
    {
      preHandler: [
        async (req, reply) => {
          const auth = await resolveRequestAuth(db, req.headers);
          if (!auth) {
            return reply
              .code(401)
              .send(
                openAiError('authentication required', 'invalid_request_error', 'authentication_required'),
              );
          }
          req.potionAuth = auth;
          req.potionOrg = auth.org;
          return undefined;
        },
        requireRole('admin'),
      ],
    },
    async (req, reply) => {
      const parsed = InviteBodySchema.safeParse(req.body);
      if (!parsed.success) {
        const message = parsed.error.issues
          .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
          .join('; ');
        return reply.code(400).send(openAiError(message, 'invalid_request_error'));
      }
      const { email, role } = parsed.data;
      const inviterOrg = req.potionOrg!;
      // Create-or-get the user, then add them to the INVITER's org (invite
      // is the ONLY way to join an existing org). createMembership is
      // idempotent; a re-invite re-sends the link without changing the role.
      let user = await getUserByEmail(db, email);
      if (!user) {
        const id = `usr-${randomUUID().slice(0, 8)}`;
        await createUser(db, { id, email, name: userNameFromEmail(email) });
        user = await getUserByEmail(db, email);
      }
      await createMembership(db, { orgId: inviterOrg.orgId, userId: user!.id, role });
      const link = await deliverMagicLink(email, inviterOrg.orgId, baseUrlOf(req, opts.publicBaseUrl));
      // M4 #34: auth trail — actor is the invitee; the inviter travels in
      // detail (session user id; api-key / dev bypass actors noted as-is).
      await recordAuthEvent(db, req, {
        orgId: inviterOrg.orgId,
        kind: 'invite',
        method: 'magic_link',
        actor: email,
        detail: { role, invitedBy: req.potionAuth?.kind === 'session' ? req.potionAuth.session.userId : req.potionAuth?.kind ?? 'unknown' },
      });
      const dev = devAuthBypassEnabled() ? { devLink: link } : {};
      return reply.send({ ok: true, email, orgId: inviterOrg.orgId, role, ...dev });
    },
  );

  // ---------- GET /auth/me ----------
  app.get('/auth/me', async (req, reply) => {
    const auth = await resolveRequestAuth(db, req.headers);
    if (!auth || auth.kind === 'dev') {
      return reply
        .code(401)
        .send(openAiError('not signed in', 'invalid_request_error', 'authentication_required'));
    }
    const userId = auth.kind === 'session' ? auth.session.userId : undefined;
    const [userRow, org] = await Promise.all([
      userId ? getUserById(db, userId) : Promise.resolve(null),
      getOrgById(db, auth.org.orgId),
    ]);
    return reply.send({
      user: userRow ? { id: userRow.id, email: userRow.email, name: userRow.name } : null,
      // M4 #34: publishToLeaderboard is the org leaderboard opt-in flag
      // (migration 0012; read by ROADMAP #32). Falls back to false when the
      // org row is missing (shouldn't happen — orgs are FK-pinned).
      org: org
        ? { id: org.id, name: org.name, publishToLeaderboard: org.publishToLeaderboard }
        : { id: auth.org.orgId, name: auth.org.orgId, publishToLeaderboard: false },
      role: auth.org.role,
      kind: auth.kind,
    });
  });
}
