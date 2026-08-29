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
import { parseHarnessSpecText, type HarnessSpec } from '@potion/lab-spec';
import { checkUrl } from '@potion/lab-runtime';
import { createHash } from 'node:crypto';
import { setMissionFeedState } from '@potion/db';
import { digestTick } from './lab-digest.js';
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
  /** P5 feed watcher (tests inject a scripted page + DNS). */
  feedFetch?: typeof fetch;
  feedLookup?: (host: string) => Promise<{ address: string; family?: number }>;
}

/** One pass over every armed mission. Exported for tests; the interval
 * just calls it. */
export async function schedulerTick(opts: LabSchedulerOptions, now = new Date()): Promise<void> {
  const log = opts.log ?? (() => {});
  const missions = await listArmedMissions(opts.db.db);
  for (const m of missions) {
    try {
      // P5: event-only missions have no cadence — their checks start from
      // the webhook inlet or the feed watcher, never from this clock.
      if (m.cadenceCron === 'event') continue;
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

// ─────────────────────────────────────────────────────────────────────────────
// P5 — EVENT TRIGGERS. Two inlets, one starter:
//   · the FEED WATCHER polls each armed mission's feed-change urls on the
//     tick (rate-limited per url), hashes a normalized body, and starts a
//     check within one cycle of a REAL change — first sight primes
//     silently, and script/comment/whitespace churn is normalized away so
//     a rotating nonce is not "a change";
//   · the WEBHOOK INLET (the /hooks/lab/:token route) calls the same
//     starter when a valid token arrives.
// The starter enforces the same laws as the clock: day budget honored,
// per-minute deterministic run ids so neither inlet can burst.
// ─────────────────────────────────────────────────────────────────────────────

export const FEED_LIMITS = {
  POLL_MS: 5 * 60_000,
  MIN_FIRE_MS: 30 * 60_000,
  MAX_FEEDS_PER_MISSION: 3,
  MAX_BYTES: 262_144,
  TIMEOUT_MS: 8_000,
} as const;

/** Normalize a page body before hashing: scripts, styles, comments and
 * whitespace runs carry the nonce churn that makes raw hashes cry wolf. */
export function normalizeFeedBody(body: string): string {
  return body
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, FEED_LIMITS.MAX_BYTES);
}

export function feedHash(body: string): string {
  return createHash('sha256').update(normalizeFeedBody(body)).digest('hex');
}

export type EventCheckStart = { ok: true; runId: string } | { ok: false; reason: string };

/** Start one event-triggered check — the webhook and the feed watcher both
 * come through here. Same refusal basis as the clock: day budget, and a
 * deterministic per-minute run id (a duplicate id = a refused burst). */
export async function startEventCheck(
  opts: LabSchedulerOptions,
  input: { orgId: string; harnessHash: string; kind: 'hook' | 'feed'; note: string },
  now = new Date(),
): Promise<EventCheckStart> {
  const row = await getLabHarness(opts.db.db, input.orgId, input.harnessHash);
  if (row === null) return { ok: false, reason: 'harness row missing' };
  const parsed = parseHarnessSpecText(row.specText);
  if (!parsed.ok || parsed.spec.mission.kind !== 'standing') {
    return { ok: false, reason: 'spec invalid or not standing' };
  }
  if (parsed.spec.fuel.maxUsdPerDay !== undefined) {
    const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const spent = await sumLabRunEstSince(opts.db.db, input.orgId, input.harnessHash, dayStart);
    if (spent >= parsed.spec.fuel.maxUsdPerDay) {
      return { ok: false, reason: `day budget reached (est $${spent.toFixed(2)})` };
    }
  }
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}`;
  const runId = `${input.kind === 'hook' ? 'hk' : 'fc'}-${input.harnessHash.slice(0, 8)}-${stamp}`;
  try {
    await createLabRun(opts.db.db, {
      id: runId,
      orgId: input.orgId,
      harnessHash: input.harnessHash,
      harnessName: parsed.spec.name,
      spec: parsed.spec,
    });
  } catch {
    return { ok: false, reason: 'a check already started this minute — burst refused' };
  }
  await opts.queue.enqueue('lab:run', { orgId: input.orgId, runId });
  await recordMissionWindow(opts.db.db, input.orgId, input.harnessHash, `evt-${stamp}`, input.note).catch(() => {});
  return { ok: true, runId };
}

interface FeedStamp {
  hash: string;
  checkedAt: string;
  firedAt?: string;
}

/** One pass of the feed watcher over every armed mission. Exported for
 * tests; the interval calls it beside the cadence tick. */
export async function feedTick(opts: LabSchedulerOptions, now = new Date()): Promise<void> {
  const log = opts.log ?? (() => {});
  const fetchImpl = opts.feedFetch ?? fetch;
  const missions = await listArmedMissions(opts.db.db);
  for (const m of missions) {
    try {
      const row = await getLabHarness(opts.db.db, m.orgId, m.harnessHash);
      if (row === null) continue;
      const parsed = parseHarnessSpecText(row.specText);
      if (!parsed.ok || parsed.spec.mission.kind !== 'standing') continue;
      const feeds = (parsed.spec as HarnessSpec).checkIns
        .filter((c): c is { trigger: 'feed-change'; url: string } => c.trigger === 'feed-change')
        .slice(0, FEED_LIMITS.MAX_FEEDS_PER_MISSION);
      if (feeds.length === 0) continue;
      const state = { ...((m.feedState ?? {}) as Record<string, FeedStamp>) };
      let dirty = false;
      for (const f of feeds) {
        const prior = state[f.url];
        if (prior !== undefined && now.getTime() - Date.parse(prior.checkedAt) < FEED_LIMITS.POLL_MS) continue;
        const verdict = await checkUrl(f.url, opts.feedLookup !== undefined ? { lookupImpl: opts.feedLookup } : {});
        if (!verdict.ok) continue; // SSRF-refused url: typed silence, never a fetch
        let body: string;
        try {
          const res = await fetchImpl(f.url, { signal: AbortSignal.timeout(FEED_LIMITS.TIMEOUT_MS), redirect: 'follow' });
          if (!res.ok) throw new Error(`status ${res.status}`);
          body = (await res.text()).slice(0, FEED_LIMITS.MAX_BYTES * 4);
        } catch {
          state[f.url] = { ...(prior ?? { hash: '' }), checkedAt: now.toISOString() };
          dirty = true;
          continue; // an unreachable feed is not a change
        }
        const h = feedHash(body);
        if (prior === undefined || prior.hash === '') {
          state[f.url] = { hash: h, checkedAt: now.toISOString() }; // first sight primes silently
          dirty = true;
          continue;
        }
        if (prior.hash === h) {
          state[f.url] = { ...prior, checkedAt: now.toISOString() };
          dirty = true;
          continue;
        }
        // A REAL change. Rate-limit fires per url.
        const lastFired = prior.firedAt !== undefined ? Date.parse(prior.firedAt) : 0;
        if (now.getTime() - lastFired < FEED_LIMITS.MIN_FIRE_MS) {
          state[f.url] = { hash: h, checkedAt: now.toISOString(), firedAt: prior.firedAt! };
          dirty = true;
          continue;
        }
        const started = await startEventCheck(opts, {
          orgId: m.orgId,
          harnessHash: m.harnessHash,
          kind: 'feed',
          note: `feed changed: ${f.url}`,
        }, now);
        state[f.url] = { hash: h, checkedAt: now.toISOString(), ...(started.ok ? { firedAt: now.toISOString() } : prior.firedAt !== undefined ? { firedAt: prior.firedAt } : {}) };
        dirty = true;
        if (started.ok) log(`[lab-feed] ${m.orgId} ${m.harnessHash.slice(0, 8)} change on ${f.url} → ${started.runId}`);
      }
      if (dirty) await setMissionFeedState(opts.db.db, m.orgId, m.harnessHash, state);
    } catch (e) {
      log(`[lab-feed] ${m.orgId} ${m.harnessHash.slice(0, 8)} error: ${(e as Error).message.slice(0, 160)}`);
    }
  }
}

/** Start the interval. Gated by POTION_LAB_SCHEDULER (default ON; '0'
 * disables). unref'd so it never holds a shutdown hostage. */
export function startLabScheduler(opts: LabSchedulerOptions): { stop: () => void } | null {
  if (process.env.POTION_LAB_SCHEDULER === '0') return null;
  const interval = setInterval(() => {
    void schedulerTick(opts).catch(() => {});
    // P5: the feed watcher rides the same clock (own rate limits per url).
    void feedTick(opts).catch(() => {});
    // P-4: the weekly digest rides the same clock (its own window dedup
    // makes tick frequency irrelevant; its own try/catch keeps it from
    // ever touching the mission tick).
    void digestTick({ db: opts.db, log: (m) => console.warn(m) }).catch(() => {});
  }, opts.intervalMs ?? 60_000);
  interval.unref();
  return { stop: () => clearInterval(interval) };
}
