// P1 — THE CLOCK. Armed standing missions start their own checks on their
// cadence. Laws, all load-bearing:
//   · at most ONE check per cadence window (deterministic run id + the
//     mission row's last_window_key — two dedups, either alone suffices);
//   · missed windows are SKIPPED, never bursted (the window key moves on);
//   · a paused mission starts nothing, instantly (the tick re-reads state);
//   · one broken mission never stalls the fleet (per-mission try/catch,
//     the error recorded on the row as last_note);
//   · maxUsdPerDay, when the spec carries it, refuses a window whose day
//     has already spent it (estimates + metered, whichever is known).
// Cadences are the CADENCE_CRON enum only — three fixed UTC crons; an
// unsupported string is a typed note, never a guess.
import {
  getLabHarness,
  listArmedMissions,
  recordMissionWindow,
  createLabRun,
  sumLabRunEstSince,
  type DbHandle,
} from '@potion/db';
import { parseHarnessSpecText } from '@potion/lab-spec';
import type { PotionQueue } from '@potion/queue';

/** The supported cadence windows (UTC). Returns the CURRENT window's key
 * and its due time, or null for an unsupported cron. Pure — tested. */
export function missionWindow(cron: string, now: Date): { key: string; dueAt: Date } | null {
  const y = now.getUTCFullYear();
  const mo = now.getUTCMonth();
  const d = now.getUTCDate();
  const pad = (n: number) => String(n).padStart(2, '0');
  if (cron === '0 * * * *') {
    const dueAt = new Date(Date.UTC(y, mo, d, now.getUTCHours(), 0, 0));
    return { key: `${y}-${pad(mo + 1)}-${pad(d)}T${pad(now.getUTCHours())}`, dueAt };
  }
  if (cron === '0 9 * * *') {
    const dueAt = new Date(Date.UTC(y, mo, d, 9, 0, 0));
    if (now < dueAt) return { key: `pre-${y}-${pad(mo + 1)}-${pad(d)}`, dueAt };
    return { key: `${y}-${pad(mo + 1)}-${pad(d)}`, dueAt };
  }
  if (cron === '0 9 * * 1') {
    // The window anchors on the most recent Monday 09:00 UTC.
    const dow = now.getUTCDay(); // 0=Sun..6=Sat
    const sinceMonday = (dow + 6) % 7;
    const monday = new Date(Date.UTC(y, mo, d - sinceMonday, 9, 0, 0));
    const effective = now < monday ? new Date(monday.getTime() - 7 * 86_400_000) : monday;
    const key = `${effective.getUTCFullYear()}-${pad(effective.getUTCMonth() + 1)}-${pad(effective.getUTCDate())}`;
    return { key: `wk-${key}`, dueAt: effective };
  }
  return null;
}

/** Deterministic check id — the second dedup: same window, same id, and
 * createLabRun's primary key refuses the duplicate. */
export function checkRunId(harnessHash: string, windowKey: string): string {
  return `chk-${harnessHash.slice(0, 8)}-${windowKey.replace(/[^0-9A-Za-z-]/g, '')}`.slice(0, 64);
}

export interface LabSchedulerOptions {
  db: DbHandle;
  queue: PotionQueue;
  intervalMs?: number;
  log?: (msg: string) => void;
}

/** One pass over every armed mission. Exported for tests; the interval
 * just calls it. */
export async function schedulerTick(opts: LabSchedulerOptions, now = new Date()): Promise<void> {
  const log = opts.log ?? (() => {});
  const missions = await listArmedMissions(opts.db.db);
  for (const m of missions) {
    try {
      const w = missionWindow(m.cadenceCron, now);
      if (w === null) {
        await recordMissionWindow(opts.db.db, m.orgId, m.harnessHash, m.lastWindowKey ?? '', `unsupported cadence '${m.cadenceCron}' — mission idle`);
        continue;
      }
      if (now < w.dueAt) continue; // not due yet
      if (w.key.startsWith('pre-')) continue; // daily window before 09:00
      if (m.lastWindowKey === w.key) continue; // this window is handled
      const row = await getLabHarness(opts.db.db, m.orgId, m.harnessHash);
      if (row === null) {
        await recordMissionWindow(opts.db.db, m.orgId, m.harnessHash, w.key, 'harness row missing — mission idle');
        continue;
      }
      const parsed = parseHarnessSpecText(row.specText);
      if (!parsed.ok || parsed.spec.mission.kind !== 'standing') {
        await recordMissionWindow(opts.db.db, m.orgId, m.harnessHash, w.key, 'spec invalid or not standing — mission idle');
        continue;
      }
      // Day budget, when declared: the estimate ledger is the refusal
      // basis (metered truth lags; the estimate is the conservative bound).
      if (parsed.spec.fuel.maxUsdPerDay !== undefined) {
        const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
        const spent = await sumLabRunEstSince(opts.db.db, m.orgId, m.harnessHash, dayStart);
        if (spent >= parsed.spec.fuel.maxUsdPerDay) {
          await recordMissionWindow(opts.db.db, m.orgId, m.harnessHash, w.key, `day budget reached (est $${spent.toFixed(2)} >= $${parsed.spec.fuel.maxUsdPerDay}) — window skipped`);
          continue;
        }
      }
      const runId = checkRunId(m.harnessHash, w.key);
      try {
        await createLabRun(opts.db.db, {
          id: runId,
          orgId: m.orgId,
          harnessHash: m.harnessHash,
          harnessName: parsed.spec.name,
          spec: parsed.spec,
        });
      } catch {
        // Duplicate id — the window already started once (belt to the
        // window-key suspenders). Record and move on.
        await recordMissionWindow(opts.db.db, m.orgId, m.harnessHash, w.key, 'window already started (duplicate id)');
        continue;
      }
      await opts.queue.enqueue('lab:run', { orgId: m.orgId, runId });
      await recordMissionWindow(opts.db.db, m.orgId, m.harnessHash, w.key, `check ${runId} started`);
      log(`[lab-scheduler] ${m.orgId} ${m.harnessHash.slice(0, 8)} → ${runId}`);
    } catch (e) {
      await recordMissionWindow(opts.db.db, m.orgId, m.harnessHash, m.lastWindowKey ?? '', `scheduler error: ${(e as Error).message.slice(0, 200)}`).catch(() => {});
    }
  }
}

/** Start the interval. Gated by POTION_LAB_SCHEDULER (default ON; '0'
 * disables). unref'd so it never holds a shutdown hostage. */
export function startLabScheduler(opts: LabSchedulerOptions): { stop: () => void } | null {
  if (process.env.POTION_LAB_SCHEDULER === '0') return null;
  const interval = setInterval(() => {
    void schedulerTick(opts).catch(() => {});
  }, opts.intervalMs ?? 60_000);
  interval.unref();
  return { stop: () => clearInterval(interval) };
}
