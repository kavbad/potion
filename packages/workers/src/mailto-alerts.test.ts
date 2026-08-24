// mailto: alert rules deliver by email (2026-08-24) — the 'nobody is
// watching production' fix rides the existing rule machinery.
import { beforeAll, describe, expect, it } from 'vitest';
import { createDb, insertAlertRule, migrate, createOrg } from '@potion/db';
import { dispatchAlertEvent } from './handlers.js';

let h: Awaited<ReturnType<typeof createDb>>;
beforeAll(async () => {
  h = await createDb();
  await migrate(h.db);
  await createOrg(h.db, { id: 'org-mailto', name: 'Mailto' });
});

describe('mailto alert delivery', () => {
  it('delivers through the registered email transport and records the delivery', async () => {
    await insertAlertRule(h.db, { orgId: 'org-mailto', kind: 'webhook', targetUrl: 'mailto:ops@example.com', events: ['breaker_open'] } as never);
    const sent: { to: string; subject: string }[] = [];
    const res = await dispatchAlertEvent(h.db, { orgId: 'org-mailto', event: 'breaker_open', detail: { breaker: 'openrouter:m' } } as never, {
      sendEmail: async (m) => { sent.push({ to: m.to, subject: m.subject }); },
    });
    expect(res.delivered).toBe(1);
    expect(sent).toEqual([{ to: 'ops@example.com', subject: '[potion alert] breaker_open — org org-mailto' }]);
  });
  it('without a transport the delivery is recorded as FAILED, never silently dropped', async () => {
    await createOrg(h.db, { id: 'org-mailto2', name: 'M2' });
    await insertAlertRule(h.db, { orgId: 'org-mailto2', kind: 'webhook', targetUrl: 'mailto:ops@example.com', events: ['breaker_open'] } as never);
    const res = await dispatchAlertEvent(h.db, { orgId: 'org-mailto2', event: 'breaker_open', detail: {} } as never, {});
    expect(res.failed).toBe(1);
    expect(res.outcomes[0]!.lastError).toContain('no email transport');
  });
});
