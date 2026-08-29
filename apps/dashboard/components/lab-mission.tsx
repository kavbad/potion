'use client';
// Mission control (P1, "the clock") — the explicit arm. A trial stays a
// trial; nothing runs itself until an admin arms the mission, and the
// armed state binds to THIS content-addressed version (an edit mints a new
// hash — re-arm deliberately). Words over chrome: state, cadence, next
// check, last note. Every value is a real row field or derived server-side.
import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { HarnessDto } from '@potion/lab-form';

const CADENCE_WORDS: Record<string, string> = {
  '0 * * * *': 'hourly',
  '0 9 * * *': 'daily at 09:00 UTC',
  '0 9 * * 1': 'weekly, Monday 09:00 UTC',
  event: 'on its event triggers (no fixed schedule)',
};

export function MissionControl({
  harness,
  role,
}: {
  harness: HarnessDto;
  role: 'admin' | 'member' | 'viewer';
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const mission = harness.mission ?? null;
  const spec = harness.spec;

  const [hookUrl, setHookUrl] = useState<string | null>(null);
  const flip = useCallback(async (to: 'arm' | 'pause') => {
    setBusy(true);
    setNote(null);
    try {
      const res = await fetch(`/api/lab/harnesses/${harness.harnessHash}/${to}`, { method: 'POST' });
      const body = (await res.json()) as { ok?: boolean; error?: string; message?: string; hook?: { url: string } };
      if (!res.ok) setNote(body.message ?? `${to} failed (${res.status})`);
      else {
        // P5: the webhook inlet's secret URL — shown ONCE (only its hash is
        // stored). It survives on screen until navigation, deliberately.
        if (to === 'arm' && body.hook?.url !== undefined) setHookUrl(body.hook.url);
        if (to === 'pause') setHookUrl(null);
        router.refresh();
      }
    } finally {
      setBusy(false);
    }
  }, [harness.harnessHash, router]);

  if (spec === null || spec.mission.kind !== 'standing') return null;
  const cron = spec.checkIns.find((c) => c.trigger === 'cron');
  // P5: event triggers make a mission armable without a cadence.
  const hasWebhook = spec.checkIns.some((c) => c.trigger === 'webhook');
  const feedUrls = spec.checkIns.filter((c): c is { trigger: 'feed-change'; url: string } => c.trigger === 'feed-change').map((c) => c.url);
  const armable = (cron !== undefined && 'schedule' in cron) || hasWebhook || feedUrls.length > 0;
  const armed = mission?.state === 'armed';
  // The cost question a buyer actually asks (zero-gaps audit, gap a):
  // cadence × cap = the worst-case month, stated plainly.
  const checksPerMonth: Record<string, number> = { '0 * * * *': 730.5, '0 9 * * *': 30.44, '0 9 * * 1': 4.35 };
  const cronSchedule = cron !== undefined && 'schedule' in cron ? cron.schedule : null;
  const worstCase = cronSchedule !== null && checksPerMonth[cronSchedule] !== undefined
    ? spec.fuel.maxUsdPerRun * checksPerMonth[cronSchedule]!
    : null;

  return (
    <section
      className={`mt-8 border px-6 py-4 ${armed ? 'border-accent/60 bg-[#fbfaf7]' : 'border-[#d9d5cb] bg-[#fbfaf7]'}`}
      data-testid="mission-control"
      data-armed={armed}
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className={`border px-2 py-0.5 font-mono text-[12px] uppercase tracking-[0.1em] ${armed ? 'border-accent text-accent' : 'border-[#c4bfb2] text-soft'}`}>
          {armed ? 'armed' : 'paused'}
        </span>
        <span className="text-[13.5px] text-soft">
          {armed ? (
            <>
              runs itself {CADENCE_WORDS[mission!.cadenceCron] ?? mission!.cadenceCron}
              {mission!.nextDueAt !== null ? <> · next check {new Date(mission!.nextDueAt).toUTCString().replace(':00 GMT', ' UTC')}</> : null}
            </>
          ) : cron !== undefined && 'schedule' in cron ? (
            <>armed, it would run {CADENCE_WORDS[cron.schedule] ?? cron.schedule} — until then, nothing starts by itself</>
          ) : armable ? (
            <>armed, its event triggers would start checks — until then, nothing starts by itself</>
          ) : (
            <>give it a schedule or an event trigger (the &ldquo;how often it checks&rdquo; field, or a page to watch) to make it armable</>
          )}
        </span>
        {role === 'admin' && armable ? (
          <button
            type="button"
            onClick={() => void flip(armed ? 'pause' : 'arm')}
            disabled={busy}
            className={armed
              ? 'border border-[#c4bfb2] px-4 py-1.5 text-[13px] text-soft hover:border-refuse hover:text-refuse disabled:opacity-40'
              : 'bg-ink px-4 py-1.5 text-[13px] font-semibold text-[#f4f2ec] hover:opacity-90 disabled:opacity-40'}
            data-testid="mission-flip"
          >
            {busy ? '…' : armed ? 'Pause the mission' : 'Arm the mission'}
          </button>
        ) : null}
      </div>
      {worstCase !== null ? (
        <p className="mt-2 font-mono text-[12px] text-faint" data-testid="mission-cost-line">
          cost, worst case: ≈ ${worstCase.toFixed(2)}/month (the ${spec.fuel.maxUsdPerRun.toFixed(2)} hard cap × every scheduled check) — actuals on the Usage page are usually far below it
        </p>
      ) : null}
      {hookUrl !== null ? (
        <div className="mt-2 border border-warn bg-white px-3 py-2" data-testid="mission-hook-url">
          <div className="font-mono text-[11.5px] uppercase tracking-[0.1em] text-warn">its webhook inlet — copy it now, shown once</div>
          <code className="mt-1 block break-all font-mono text-[12px] text-ink">{hookUrl}</code>
          <p className="mt-1 text-[12px] text-soft">POST to it and this worker starts a check (rate-limited, day budget honored). Re-arming rotates it; pausing closes it.</p>
        </div>
      ) : null}
      {armed && mission?.hasHook === true && hookUrl === null ? (
        <p className="mt-2 font-mono text-[12px] text-faint" data-testid="mission-hook-armed">
          webhook inlet: armed (the URL was shown at arm time — re-arm to rotate it)
        </p>
      ) : null}
      {feedUrls.length > 0 ? (
        <p className="mt-2 font-mono text-[12px] text-faint" data-testid="mission-feeds">
          watching: {feedUrls.join(' · ')}{armed ? ' — a real change starts a check within one cycle' : ' (once armed)'}
        </p>
      ) : null}
      {mission?.lastNote ? (
        <p className="mt-2 font-mono text-[12px] text-faint" data-testid="mission-note">
          scheduler: {mission.lastNote}
        </p>
      ) : null}
      {note ? <p className="mt-2 text-[12.5px] text-refuse">{note}</p> : null}
    </section>
  );
}
