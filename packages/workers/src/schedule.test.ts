// The research heartbeat. Tested with an injected timer, so no wall clock.
//
// The properties that matter are the ones that keep a recurring job from
// becoming a recurring incident: off unless asked, never overlapping, never
// fatal, and stoppable.
import { describe, expect, it, vi } from 'vitest';
import { RESEARCH_SCAN_INTERVAL_ENV, startResearchSchedule } from './schedule.js';

/** A timer you drive by hand. */
function fakeTimer() {
  const pending: Array<{ fn: () => void; ms: number }> = [];
  return {
    setTimer: (fn: () => void, ms: number) => {
      const entry = { fn, ms };
      pending.push(entry);
      return {
        cancel: () => {
          const i = pending.indexOf(entry);
          if (i >= 0) pending.splice(i, 1);
        },
      };
    },
    /** Fire the oldest pending timer. */
    async fire(): Promise<void> {
      const next = pending.shift();
      next?.fn();
      await Promise.resolve();
      await Promise.resolve();
    },
    get count(): number {
      return pending.length;
    },
  };
}

function fakeQueue() {
  const enqueued: Array<{ kind: string; payload: unknown }> = [];
  return {
    enqueued,
    enqueue: vi.fn(async (kind: string, payload: unknown) => {
      enqueued.push({ kind, payload });
      return 'job-1';
    }),
  };
}

describe('research heartbeat', () => {
  it('is OFF unless an interval is named — a deployment that says nothing keeps the old behaviour', () => {
    const prev = process.env[RESEARCH_SCAN_INTERVAL_ENV];
    delete process.env[RESEARCH_SCAN_INTERVAL_ENV];
    const q = fakeQueue();
    const s = startResearchSchedule({ queue: q, log: () => {} });
    expect(s.intervalHours).toBeNull();
    expect(q.enqueue).not.toHaveBeenCalled();
    if (prev !== undefined) process.env[RESEARCH_SCAN_INTERVAL_ENV] = prev;
  });

  it('reads the env knob when no interval is passed', () => {
    const prev = process.env[RESEARCH_SCAN_INTERVAL_ENV];
    process.env[RESEARCH_SCAN_INTERVAL_ENV] = '6';
    const t = fakeTimer();
    const s = startResearchSchedule({
      queue: fakeQueue(),
      log: () => {},
      setTimer: t.setTimer,
    });
    expect(s.intervalHours).toBe(6);
    s.stop();
    if (prev === undefined) delete process.env[RESEARCH_SCAN_INTERVAL_ENV];
    else process.env[RESEARCH_SCAN_INTERVAL_ENV] = prev;
  });

  it('rejects a zero or negative interval rather than spinning', () => {
    for (const v of [0, -1, Number.NaN]) {
      const s = startResearchSchedule({
        queue: fakeQueue(),
        intervalHours: v,
        log: () => {},
      });
      expect(s.intervalHours).toBeNull();
    }
  });

  it('enqueues research:scan on each tick', async () => {
    const t = fakeTimer();
    const q = fakeQueue();
    const s = startResearchSchedule({
      queue: q,
      intervalHours: 6,
      log: () => {},
      setTimer: t.setTimer,
    });
    await t.fire();
    expect(q.enqueued.map((e) => e.kind)).toEqual(['research:scan']);
    await t.fire();
    expect(q.enqueued).toHaveLength(2);
    s.stop();
  });

  it('does NOT scan on start by default — a restart loop must not become a scan loop', async () => {
    const t = fakeTimer();
    const q = fakeQueue();
    const s = startResearchSchedule({
      queue: q,
      intervalHours: 6,
      log: () => {},
      setTimer: t.setTimer,
    });
    // A timer is armed, but nothing has been enqueued yet.
    expect(q.enqueue).not.toHaveBeenCalled();
    expect(t.count).toBe(1);
    s.stop();
  });

  it('re-arms only AFTER a tick completes, so two scans can never overlap', async () => {
    const t = fakeTimer();
    const q = fakeQueue();
    const s = startResearchSchedule({
      queue: q,
      intervalHours: 6,
      log: () => {},
      setTimer: t.setTimer,
    });
    expect(t.count).toBe(1); // exactly one timer in flight
    await t.fire();
    expect(t.count).toBe(1); // fired one, armed one — never two
    s.stop();
  });

  it('an enqueue failure is not fatal and the schedule keeps going', async () => {
    const t = fakeTimer();
    const q = {
      enqueue: vi
        .fn()
        .mockRejectedValueOnce(new Error('queue down'))
        .mockResolvedValue('job-2'),
    };
    const logs: string[] = [];
    const s = startResearchSchedule({
      queue: q,
      intervalHours: 6,
      log: (m) => logs.push(m),
      setTimer: t.setTimer,
    });
    await t.fire();
    expect(logs.some((l) => l.includes('scan enqueue failed'))).toBe(true);
    expect(t.count).toBe(1); // re-armed despite the failure
    await t.fire();
    expect(q.enqueue).toHaveBeenCalledTimes(2);
    s.stop();
  });

  it('stop() cancels the pending timer and is idempotent', async () => {
    const t = fakeTimer();
    const q = fakeQueue();
    const s = startResearchSchedule({
      queue: q,
      intervalHours: 6,
      log: () => {},
      setTimer: t.setTimer,
    });
    s.stop();
    s.stop();
    expect(t.count).toBe(0);
    await t.fire();
    expect(q.enqueue).not.toHaveBeenCalled();
  });
});
