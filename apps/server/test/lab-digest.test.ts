// P-4 — the weekly digest's laws: pure window anchoring, truthful
// composition (scores averaged only over judged runs; no cost figures),
// and at-most-once-per-window delivery regardless of tick frequency.
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import {
  createDb,
  createLabRun,
  createMembership,
  createOrg,
  createUser,
  migrate,
  setLabRunJudge,
  type DbHandle,
} from '@potion/db';
import { composeDigest, digestTick, digestWindow } from '../src/lab-digest.js';

let h: DbHandle;

beforeAll(async () => {
  h = await createDb();
  await migrate(h.db);
  await createOrg(h.db, { id: 'org_digest', name: 'Digest Org' });
  await createUser(h.db, { id: 'usr_digest', email: 'digest@org.dev', name: 'd' });
  await createMembership(h.db, { orgId: 'org_digest', userId: 'usr_digest', role: 'admin' });
}, 120_000);

afterAll(async () => {
  await h.close();
});

describe('digestWindow', () => {
  it('anchors on the most recent Monday 08:00 UTC, stable within the week', () => {
    const wed = digestWindow(new Date('2026-08-26T15:00:00Z')); // Wednesday
    const fri = digestWindow(new Date('2026-08-28T02:00:00Z')); // Friday
    expect(wed.key).toBe(fri.key);
    expect(wed.key).toBe('dg-2026-08-24');
    // Monday before 08:00 belongs to the PREVIOUS window.
    expect(digestWindow(new Date('2026-08-24T07:59:00Z')).key).toBe('dg-2026-08-17');
  });
});

describe('composeDigest', () => {
  it('averages scores only over judged runs and counts states plainly', () => {
    const d = composeDigest([
      { harnessName: 'analyst', state: 'completed', judge: { overall: 8 } },
      { harnessName: 'analyst', state: 'completed', judge: null },
      { harnessName: 'analyst', state: 'failed', judge: null },
    ]);
    expect(d!.subject).toBe('Your workers this week: 2/3 checks completed');
    expect(d!.text).toContain('analyst — 3 checks, 2 completed · avg score 8.0/10 · 1 needed you');
    expect(d!.text).not.toMatch(/\$\d/); // no cost figures — the Usage page owns metered truth
  });
  it('a quiet week composes to null', () => {
    expect(composeDigest([])).toBeNull();
  });
});

describe('digestTick — at most once per window', () => {
  it('sends once, then dedups on the window key', async () => {
    const spec = {
      specVersion: 1, name: 'digest harness',
      brain: { policy: { type: 'min_cost', qualityFloor: 0 } },
      mission: { kind: 'standing', goal: 'work' },
      superpowers: [], memory: { enabled: true }, rules: [],
      fuel: { maxUsdPerRun: 1, hardStop: true }, checkIns: [],
    };
    await createLabRun(h.db, { id: 'run-dg-1', orgId: 'org_digest', harnessHash: 'a'.repeat(64), harnessName: 'digest harness', spec });
    await setLabRunJudge(h.db, 'run-dg-1', 'org_digest', { overall: 7, criteria: [], rationale: '', calibrated: false });

    const sent: Array<{ to: string; subject: string }> = [];
    // Date-independent for real this time (the first version broke when the
    // suite ran on a Monday between 00:00 and 08:59 UTC): tick at the first
    // Monday 09:00 UTC whose WINDOW OPEN (that Monday 08:00) is strictly
    // after "now" — then the just-created run always falls inside the
    // reported week [windowOpen − 7d, windowOpen).
    const base = new Date();
    let nextMonday = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate(), 9, 0, 0));
    while (nextMonday.getUTCDay() !== 1 || nextMonday.getTime() - 3_600_000 <= base.getTime()) {
      nextMonday = new Date(nextMonday.getTime() + 86_400_000);
    }
    const n1 = await digestTick({ db: h, sendEmail: async (m) => { sent.push({ to: m.to, subject: m.subject }); } }, nextMonday);
    expect(n1).toBe(1);
    expect(sent[0]!.to).toBe('digest@org.dev');
    expect(sent[0]!.subject).toContain('checks completed');

    const n2 = await digestTick({ db: h, sendEmail: async (m) => { sent.push({ to: m.to, subject: m.subject }); } }, nextMonday);
    expect(n2).toBe(0); // the window key dedups
    expect(sent).toHaveLength(1);
  });
});
