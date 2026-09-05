// THE SECOND ASK (2026-09-05) — a run parked on a person mails once, at the
// moment it parks, and then goes silent for the rest of its life. On
// production a run has been waiting since 2026-08-31: the mail was sent,
// the person missed it, and nothing ever asked again.
//
// One nudge is not a system. These tests pin the one that replaced it, and
// they pin the failure mode a reminder introduces just as hard as the one
// it fixes: an email that repeats teaches people to filter the sender.
import { beforeEach, describe, expect, it } from 'vitest';
import {
  ORG_A,
  ORG_B,
  createDb,
  createLabRun,
  createMembership,
  createUser,
  listParkedRunsDue,
  listWaitingLabRuns,
  markParkedRunReminded,
  migrate,
  seedIsolationOrgs,
  labRuns,
  PARKED_REMINDER_AFTER_MS,
  type DbHandle,
} from '@potion/db';
import { eq } from 'drizzle-orm';
import {
  createLabParkedReminderHandler,
  DEFAULT_PRICES_PATH,
  waitedWords,
  type JobContext,
} from './handlers.js';
import { composeRunEvent, type NotifyMessage } from './notify.js';

let db: DbHandle;
const ADMIN = 'owner@fixture-a.example';

/** A run that has been parked on a person since `parkedAt`. */
async function park(id: string, parkedAt: Date, question: string): Promise<void> {
  await createLabRun(db.db, {
    id,
    orgId: ORG_A,
    harnessHash: `h-${id}`,
    harnessName: 'spreadsheet-analyst',
    spec: {},
  });
  // Set the parked state directly rather than through transitionLabRun:
  // that path is fenced to a live invocation lease, and what this sweep
  // reads is the ROW — state, pending question, and how long updated_at
  // says it has sat there, which is the whole subject here.
  await db.db
    .update(labRuns)
    .set({ state: 'awaiting-human', pendingQuestion: question, updatedAt: parkedAt })
    .where(eq(labRuns.id, id));
}

function handlerWith(sent: NotifyMessage[]): ReturnType<typeof createLabParkedReminderHandler> {
  return createLabParkedReminderHandler({
    sendNotify: async (msg) => {
      sent.push(msg);
    },
  });
}

// A REAL JobContext, built rather than cast. Forcing a bare `{ db }` into
// this type compiles and is checked against nothing: the day the handler
// reaches for dbHandle or pricesPath, what would have been a type error
// becomes a runtime undefined. The escape-hatch ratchet in
// scripts/test-typecheck-coverage.test.ts caught the first draft doing
// exactly that, and the three fields the type actually wants cost nothing.
const ctx = (): JobContext => ({ db: db.db, dbHandle: db, pricesPath: DEFAULT_PRICES_PATH });

beforeEach(async () => {
  db = await createDb();
  await migrate(db.db);
  await seedIsolationOrgs(db.db);
  await createUser(db.db, { id: 'usr-a', email: ADMIN, name: 'Owner' });
  await createMembership(db.db, { orgId: ORG_A, userId: 'usr-a', role: 'admin' });
});

describe('the sweep asks again for a run nobody answered', () => {
  it('reminds an org admin, naming the question and how long it has waited', async () => {
    const now = new Date('2026-09-05T00:00:00Z');
    await park('run-old', new Date('2026-08-31T00:00:00Z'), 'Should I use the 2024 sheet or the 2025 one?');
    const sent: NotifyMessage[] = [];
    const out = await handlerWith(sent)({ now: now.toISOString() }, ctx());
    expect(out).toEqual({ due: 1, reminded: 1 });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe(ADMIN);
    expect(sent[0]!.subject).toContain('still waiting');
    expect(sent[0]!.text).toContain('Should I use the 2024 sheet');
    expect(sent[0]!.text).toContain('5 days');
  });

  it('leaves a fresh park alone — a day is the grace, not a formality', async () => {
    const now = new Date('2026-09-05T00:00:00Z');
    await park('run-fresh', new Date(now.getTime() - PARKED_REMINDER_AFTER_MS + 60_000), 'Which file?');
    const sent: NotifyMessage[] = [];
    expect(await handlerWith(sent)({ now: now.toISOString() }, ctx())).toEqual({ due: 0, reminded: 0 });
    expect(sent).toHaveLength(0);
  });

  it('NEVER asks a third time — a repeating email is how a sender gets filtered', async () => {
    const now = new Date('2026-09-05T00:00:00Z');
    await park('run-old', new Date('2026-08-31T00:00:00Z'), 'Which sheet?');
    const sent: NotifyMessage[] = [];
    const handler = handlerWith(sent);
    await handler({ now: now.toISOString() }, ctx());
    await handler({ now: new Date('2026-09-06T00:00:00Z').toISOString() }, ctx());
    await handler({ now: new Date('2026-09-20T00:00:00Z').toISOString() }, ctx());
    expect(sent).toHaveLength(1);
  });

  it('the stamp is claimed BEFORE the mail, so two sweeps racing send one', async () => {
    // markParkedRunReminded returns whether THIS caller won the NULL guard.
    await park('run-old', new Date('2026-08-31T00:00:00Z'), 'Which sheet?');
    expect(await markParkedRunReminded(db.db, 'run-old')).toBe(true);
    expect(await markParkedRunReminded(db.db, 'run-old')).toBe(false);
  });

  it('a run that got answered stops being due', async () => {
    const now = new Date('2026-09-05T00:00:00Z');
    await park('run-old', new Date('2026-08-31T00:00:00Z'), 'Which sheet?');
    await db.db.update(labRuns).set({ state: 'running', pendingQuestion: null }).where(eq(labRuns.id, 'run-old'));
    expect(await listParkedRunsDue(db.db, now)).toEqual([]);
  });
});

describe('the reminder does not read like the first mail', () => {
  it('says how long, and says it is the last one', () => {
    const first = composeRunEvent({
      orgId: ORG_A, runId: 'r1', harnessName: 'analyst', state: 'awaiting-human', question: 'Which sheet?',
    });
    const again = composeRunEvent({
      orgId: ORG_A, runId: 'r1', harnessName: 'analyst', state: 'awaiting-human', question: 'Which sheet?',
      waitingFor: '5 days',
    });
    expect(again.subject).not.toBe(first.subject);
    expect(again.text).toContain('5 days');
    expect(again.text).toContain('last email');
    // Both must still carry the thing the reader has to act on.
    for (const m of [first, again]) expect(m.text).toContain('Which sheet?');
  });
});

describe('waitedWords', () => {
  it('is rough on purpose — the unit that matters, not the arithmetic', () => {
    expect(waitedWords(3_600_000)).toBe('1 hour');
    expect(waitedWords(25 * 3_600_000)).toBe('25 hours');
    expect(waitedWords(5 * 24 * 3_600_000)).toBe('5 days');
    expect(waitedWords(0)).toBe('1 hour'); // never "0 hours"
  });
});

describe('the standing signal reads only YOUR waiting workers', () => {
  it('is org-scoped — another tenant\'s parked run is invisible', async () => {
    await park('run-mine', new Date('2026-08-31T00:00:00Z'), 'Which sheet?');
    await createLabRun(db.db, {
      id: 'run-theirs',
      orgId: ORG_B,
      harnessHash: 'h-theirs',
      harnessName: 'their-worker',
      spec: {},
    });
    await db.db
      .update(labRuns)
      .set({ state: 'awaiting-human', pendingQuestion: 'their question' })
      .where(eq(labRuns.id, 'run-theirs'));

    const mine = await listWaitingLabRuns(db.db, ORG_A);
    expect(mine.map((r) => r.id)).toEqual(['run-mine']);
    expect(JSON.stringify(mine)).not.toContain('their question');
  });

  it('excludes a shadow rehearsal — nobody is asked to answer a dry run', async () => {
    await createLabRun(db.db, {
      id: 'run-shadow',
      orgId: ORG_A,
      harnessHash: 'h-s',
      harnessName: 'rehearsal',
      spec: {},
      shadow: true,
    });
    await db.db
      .update(labRuns)
      .set({ state: 'awaiting-human', pendingQuestion: 'rehearsed question' })
      .where(eq(labRuns.id, 'run-shadow'));
    expect(await listWaitingLabRuns(db.db, ORG_A)).toEqual([]);
  });

  it('is oldest first — the one most likely to have been forgotten leads', async () => {
    await park('run-newer', new Date('2026-09-04T00:00:00Z'), 'newer?');
    await park('run-older', new Date('2026-08-31T00:00:00Z'), 'older?');
    expect((await listWaitingLabRuns(db.db, ORG_A)).map((r) => r.id)).toEqual(['run-older', 'run-newer']);
  });
});

describe('restarts cannot starve the sweep, and cannot multiply the mail', () => {
  it('a hundred boots still send exactly one reminder per parked run', async () => {
    // The sweep now runs shortly after every boot as well as hourly,
    // because a bare interval restarts its clock with the process — on a
    // box deployed more often than the interval the tick never arrives,
    // and for THIS sweep a missed tick is a person who is never told.
    // Running at boot is only safe if it is idempotent, so that is pinned
    // here rather than assumed: reminded_at is claimed before the mail and
    // only by the writer that wins the NULL guard.
    const now = new Date('2026-09-05T00:00:00Z');
    await park('run-old', new Date('2026-08-31T00:00:00Z'), 'Which sheet?');
    const sent: NotifyMessage[] = [];
    const handler = handlerWith(sent);
    for (let boot = 0; boot < 100; boot += 1) {
      await handler({ now: now.toISOString() }, ctx());
    }
    expect(sent).toHaveLength(1);
  });

  it('two sweeps racing on the same run send one, not two', async () => {
    const now = new Date('2026-09-05T00:00:00Z');
    await park('run-old', new Date('2026-08-31T00:00:00Z'), 'Which sheet?');
    const sent: NotifyMessage[] = [];
    const handler = handlerWith(sent);
    await Promise.all([
      handler({ now: now.toISOString() }, ctx()),
      handler({ now: now.toISOString() }, ctx()),
    ]);
    expect(sent).toHaveLength(1);
  });
});
