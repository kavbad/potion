// P-4 (2026-08-28) — THE WEEKLY PORTFOLIO DIGEST: what your workers did,
// delivered, scored, and cost this week — one email per org, Monday 08:00
// UTC, at most once per window (the lab_digests row is the dedup, so tick
// frequency and restarts cannot double-send). Best-effort like every
// notification: a delivery failure logs and never breaks the tick.
import {
  getLabDigestKey,
  getUserById,
  listMembershipsByOrg,
  listOrgIdsWithLabRunsSince,
  listRecentLabRuns,
  setLabDigestKey,
  type DbHandle,
} from '@potion/db';
import { sendEmailFromEnv } from './email.js';
import type { SendEmail } from './routes/auth.js';

/** The digest window: anchored on the most recent Monday 08:00 UTC. Pure. */
export function digestWindow(now: Date): { key: string; openedAt: Date } {
  const dow = now.getUTCDay();
  const sinceMonday = (dow + 6) % 7;
  const monday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - sinceMonday, 8, 0, 0));
  const effective = now < monday ? new Date(monday.getTime() - 7 * 86_400_000) : monday;
  const pad = (n: number) => String(n).padStart(2, '0');
  return {
    key: `dg-${effective.getUTCFullYear()}-${pad(effective.getUTCMonth() + 1)}-${pad(effective.getUTCDate())}`,
    openedAt: effective,
  };
}

interface DigestRun {
  harnessName: string;
  state: string;
  judge: unknown;
}

/** Compose the digest from the week's runs. Pure — tested. Truth rules:
 * scores averaged only over runs that WERE judged; states counted plainly;
 * no cost figure (the Usage page owns metered truth — a digest must not
 * ship an unlabeled estimate as a bill). */
export function composeDigest(runs: DigestRun[]): { subject: string; text: string } | null {
  if (runs.length === 0) return null;
  const byWorker = new Map<string, { runs: number; completed: number; needed: number; scores: number[] }>();
  for (const r of runs) {
    const w = byWorker.get(r.harnessName) ?? { runs: 0, completed: 0, needed: 0, scores: [] };
    w.runs += 1;
    if (r.state === 'completed') w.completed += 1;
    if (r.state === 'failed' || r.state === 'killed-budget' || r.state === 'awaiting-human') w.needed += 1;
    const overall = (r.judge as { overall?: number } | null)?.overall;
    if (typeof overall === 'number') w.scores.push(overall);
    byWorker.set(r.harnessName, w);
  }
  const total = runs.length;
  const completed = runs.filter((r) => r.state === 'completed').length;
  const lines = [...byWorker.entries()].map(([name, w]) => {
    const avg = w.scores.length > 0 ? ` · avg score ${(w.scores.reduce((a, x) => a + x, 0) / w.scores.length).toFixed(1)}/10` : '';
    const needed = w.needed > 0 ? ` · ${w.needed} needed you` : '';
    return `  · ${name} — ${w.runs} check${w.runs === 1 ? '' : 's'}, ${w.completed} completed${avg}${needed}`;
  });
  return {
    subject: `Your workers this week: ${completed}/${total} checks completed`,
    text:
      `The week, per worker:\n${lines.join('\n')}\n\n` +
      `Every check has its receipts, record, and score on its run page. Costs live on the Usage page.\n\n— Potion`,
  };
}

export interface DigestTickOptions {
  db: DbHandle;
  sendEmail?: SendEmail;
  log?: (msg: string) => void;
}

export async function digestTick(opts: DigestTickOptions, now = new Date()): Promise<number> {
  if (process.env.POTION_NOTIFY === '0') return 0;
  const db = opts.db.db;
  const send = opts.sendEmail ?? sendEmailFromEnv().sendEmail;
  const log = opts.log ?? (() => {});
  const window = digestWindow(now);
  const weekBefore = new Date(window.openedAt.getTime() - 7 * 86_400_000);
  const orgIds = await listOrgIdsWithLabRunsSince(db, weekBefore);
  let sent = 0;
  for (const orgId of orgIds) {
    try {
      if ((await getLabDigestKey(db, orgId)) === window.key) continue;
      const runs = await listRecentLabRuns(db, orgId, { since: weekBefore, limit: 200 });
      // The digest covers the week BEFORE this window opened.
      const inWeek = runs.filter((r) => r.createdAt < window.openedAt);
      const digest = composeDigest(inWeek);
      // Mark the window even when quiet — a silent week must not retry forever.
      await setLabDigestKey(db, orgId, window.key);
      if (digest === null) continue;
      const admins = (await listMembershipsByOrg(db, orgId)).filter((m) => m.role === 'admin');
      for (const m of admins) {
        const user = await getUserById(db, m.userId);
        if (user === null) continue;
        try {
          await send({ to: user.email, subject: digest.subject, text: digest.text });
          sent += 1;
        } catch (e) {
          log(`[potion digest] delivery failed for ${user.email}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    } catch (e) {
      log(`[potion digest] org ${orgId} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return sent;
}
