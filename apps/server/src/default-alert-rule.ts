// THE DEFAULT ALERT RULE (2026-09-16, customer-eyes review). Until today
// exactly one org on production had an alert rule — the operator's own,
// created by hand on 2026-08-24. A customer whose budget blew, whose
// breaker opened, or whose floor nothing could clear was told nothing
// unless they had found /settings/alerts and set one up. An org is
// provisioned with an email rule to the address that signed up, so the
// first thing that goes wrong is the first thing they hear about.
//
// Idempotent and deferential: an org that already has ANY rule is left
// exactly as it is — the customer's configuration outranks the default.
import { insertAlertRule, listAlertRules, type AlertEvent, type PotionDb } from '@potion/db';

export const DEFAULT_ALERT_EVENTS: readonly AlertEvent[] = [
  'budget_warning',
  'budget_exceeded',
  'breaker_open',
  'quality_breach',
  'rollback',
  'policy_infeasible',
  'job_failed',
];

export async function ensureDefaultAlertRule(
  db: PotionDb,
  orgId: string,
  email: string,
): Promise<{ created: boolean; ruleId: string | null }> {
  const address = email.trim().toLowerCase();
  if (!address.includes('@')) return { created: false, ruleId: null };
  const existing = await listAlertRules(db, orgId);
  if (existing.length > 0) return { created: false, ruleId: existing[0]!.id };
  const row = await insertAlertRule(db, {
    orgId,
    kind: 'webhook',
    targetUrl: `mailto:${address}`,
    events: [...DEFAULT_ALERT_EVENTS],
  });
  return { created: true, ruleId: row.id };
}
