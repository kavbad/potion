// G2.2 notification-latency mechanics on the alert dispatcher: the audit
// row carries the incident linkage + the emitter-bound SLA clock; latency
// is measured at the SUCCESSFUL POST only (a failed delivery has no
// latency), clamped ≥ 0 against clock skew, and observed per delivered
// rule on the injected meter. All deterministic via injected fetch/now.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  alertDeliveries,
  createDb,
  createOrg,
  insertAlertRule,
  migrate,
  type AlertEvent,
  type DbHandle,
} from '@potion/db';
import { dispatchAlertEvent, type AlertDispatchDeps } from './handlers.js';

const ORG = 'org_disp';

let db: DbHandle;

function okFetch(): typeof fetch {
  return (async () => new Response('ok', { status: 200 }));
}
function failFetch(): typeof fetch {
  return (async () => new Response('nope', { status: 500 }));
}

function deps(over: Partial<AlertDispatchDeps> = {}): AlertDispatchDeps {
  return { fetchImpl: okFetch(), sleep: async () => {}, ...over };
}

async function rule(events: AlertEvent[] = ['quality_breach']): Promise<void> {
  await insertAlertRule(db.db, {
    orgId: ORG,
    kind: 'webhook',
    targetUrl: 'https://alerts.example.com/hook?token=secret',
    events,
  });
}

async function deliveries() {
  return db.db.select().from(alertDeliveries);
}

beforeEach(async () => {
  db = await createDb();
  await migrate(db.db);
  await createOrg(db.db, { id: ORG, name: 'Dispatch' });
});

afterEach(async () => {
  await db.close();
});

describe('dispatch latency (G2.2)', () => {
  it('delivered row persists incidentId + clockStartAt + deterministic latency; meter observed', async () => {
    await rule();
    const clockStart = new Date('2026-08-08T10:00:00.000Z');
    const dispatchAt = new Date('2026-08-08T10:07:30.000Z'); // 450_000 ms later
    const observed: Array<{ orgId: string; event: string; latencyMs: number }> = [];
    const result = await dispatchAlertEvent(
      db.db,
      {
        orgId: ORG,
        event: 'quality_breach',
        incidentId: 'inc-123',
        clockStartAt: clockStart.toISOString(),
        detail: { clusterId: 'agent-x' },
      },
      deps({
        now: () => dispatchAt,
        meter: { observeAlertNotificationLatency: (o) => void observed.push(o) },
      }),
    );
    expect(result.delivered).toBe(1);
    const rows = await deliveries();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.incidentId).toBe('inc-123');
    expect(rows[0]!.clockStartAt?.toISOString()).toBe(clockStart.toISOString());
    expect(rows[0]!.latencyMs).toBe(450_000);
    expect(observed).toEqual([{ orgId: ORG, event: 'quality_breach', latencyMs: 450_000 }]);
  });

  it('negative skew clamps to 0 (db clock ahead of the worker clock)', async () => {
    await rule();
    const clockStart = new Date('2026-08-08T10:00:05.000Z');
    await dispatchAlertEvent(
      db.db,
      { orgId: ORG, event: 'quality_breach', clockStartAt: clockStart.toISOString() },
      deps({ now: () => new Date('2026-08-08T10:00:00.000Z') }),
    );
    expect((await deliveries())[0]!.latencyMs).toBe(0);
  });

  it('FAILED delivery: clock persisted for auditability, latency NULL (no delivery, no latency)', async () => {
    await rule();
    const observed: unknown[] = [];
    await dispatchAlertEvent(
      db.db,
      {
        orgId: ORG,
        event: 'quality_breach',
        incidentId: 'inc-9',
        clockStartAt: '2026-08-08T10:00:00.000Z',
      },
      deps({
        fetchImpl: failFetch(),
        meter: { observeAlertNotificationLatency: (o) => void observed.push(o) },
      }),
    );
    const row = (await deliveries())[0]!;
    expect(row.status).toBe('failed');
    expect(row.incidentId).toBe('inc-9');
    expect(row.clockStartAt).not.toBeNull();
    expect(row.latencyMs).toBeNull();
    expect(observed).toHaveLength(0);
  });

  it('no clock bound (budget-style events) → NULL clock and latency', async () => {
    await rule(['budget_warning']);
    await dispatchAlertEvent(db.db, { orgId: ORG, event: 'budget_warning' }, deps());
    const row = (await deliveries())[0]!;
    expect(row.status).toBe('delivered');
    expect(row.clockStartAt).toBeNull();
    expect(row.latencyMs).toBeNull();
  });

  it('the G2.2 event vocabulary dispatches (rule subscription honored)', async () => {
    await rule(['guarantee_unverifiable', 'guarantee_restored', 'guarantee_recovery_unconfirmed']);
    for (const event of ['guarantee_unverifiable', 'guarantee_restored', 'guarantee_recovery_unconfirmed'] as const) {
      const r = await dispatchAlertEvent(db.db, { orgId: ORG, event, clockStartAt: new Date().toISOString() }, deps());
      expect(r.delivered).toBe(1);
    }
    // Unknown events still refuse loudly. The cast is DELIBERATE and scoped
    // to this one field: it feeds an event outside the AlertEvent union past
    // the compiler to exercise the runtime ALERT_EVENTS guard in
    // dispatchAlertEvent, which is the only thing standing between a typo'd
    // enqueue and a silently undelivered alert.
    await expect(
      dispatchAlertEvent(db.db, { orgId: ORG, event: 'nope' as never }, deps()),
    ).rejects.toThrow(/unknown event/);
  });
});
