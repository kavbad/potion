// Alert rules + delivery audit repository (M4, ROADMAP #33, SPEC §13.5,
// migration 0010).
//
//   alert_rules      — org notification targets (webhook | slack). The
//     target_url may embed a secret: it lives ONLY in this table. Nothing
//     in this repo (or the dispatcher) copies it into the delivery audit,
//     and error text is query-string-redacted before it is stored/logged.
//   alert_deliveries — append-only audit, one row per (dispatch, rule)
//     outcome. ruleId is TEXT by contract and deliberately not an FK, so
//     the audit outlives rule deletion. Org scoping of delivery reads goes
//     THROUGH the rule (delivery → rule → org); cross-org reads are
//     impossible by construction.
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { PotionDb } from '../db.js';
import {
  alertDeliveries,
  alertRules,
  type AlertDeliveryRow,
  type AlertEvent,
  type AlertRuleRow,
  type NewAlertDelivery,
  type NewAlertRule,
} from '../schema.js';

/** Redact the query string (and any userinfo) of a URL for logs/errors —
 * webhook targets may embed secrets there. Never throws: a non-URL input
 * is returned with anything after '?' stripped. */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    u.search = '';
    u.username = '';
    u.password = '';
    return u.toString();
  } catch {
    return url.split('?')[0] ?? url;
  }
}

/** Redact any URL query strings inside an arbitrary error message. */
export function redactUrlsInText(text: string): string {
  return text.replace(/https?:\/\/[^\s)]+/g, (m) => redactUrl(m));
}

// ---------------------------------------------------------------------------
// alert_rules
// ---------------------------------------------------------------------------

/** All rules for an org (newest first) — the CRUD read surface. */
export async function listAlertRules(db: PotionDb, orgId: string): Promise<AlertRuleRow[]> {
  return db
    .select()
    .from(alertRules)
    .where(eq(alertRules.orgId, orgId))
    .orderBy(desc(alertRules.createdAt));
}

/** Insert one rule. Returns the inserted row (generated id/created_at). */
export async function insertAlertRule(db: PotionDb, row: NewAlertRule): Promise<AlertRuleRow> {
  const inserted = await db.insert(alertRules).values(row).returning();
  return inserted[0]!;
}

/**
 * Delete a rule, org-scoped (a rule id from another org deletes nothing and
 * returns false — no cross-org existence oracle). Returns true when a row
 * was deleted.
 */
export async function deleteAlertRule(
  db: PotionDb,
  orgId: string,
  id: string,
): Promise<boolean> {
  const deleted = await db
    .delete(alertRules)
    .where(and(eq(alertRules.id, id), eq(alertRules.orgId, orgId)))
    .returning({ id: alertRules.id });
  return deleted.length > 0;
}

/**
 * ENABLED rules of an org subscribed to `event` (event ∈ events,
 * disabled_at IS NULL) — the dispatcher's match set.
 */
export async function matchingAlertRules(
  db: PotionDb,
  orgId: string,
  event: AlertEvent,
): Promise<AlertRuleRow[]> {
  const rows = await db
    .select()
    .from(alertRules)
    .where(
      and(
        eq(alertRules.orgId, orgId),
        isNull(alertRules.disabledAt),
        sql`${event} = ANY(${alertRules.events})`,
      ),
    );
  return rows;
}

/**
 * Distinct org ids with ≥1 ENABLED rule subscribed to `event` — the
 * broadcast set for org-less platform events (breaker_open: breakers are a
 * platform-global signal, so the readiness hook fans out per org).
 */
export async function orgsWithAlertRulesFor(db: PotionDb, event: AlertEvent): Promise<string[]> {
  const rows = await db
    .selectDistinct({ orgId: alertRules.orgId })
    .from(alertRules)
    .where(and(isNull(alertRules.disabledAt), sql`${event} = ANY(${alertRules.events})`));
  return rows.map((r) => r.orgId);
}

// ---------------------------------------------------------------------------
// alert_deliveries
// ---------------------------------------------------------------------------

/** Append one delivery audit row. Returns the generated id. */
export async function insertAlertDelivery(
  db: PotionDb,
  row: NewAlertDelivery,
): Promise<string> {
  const inserted = await db
    .insert(alertDeliveries)
    .values(row)
    .returning({ id: alertDeliveries.id });
  return inserted[0]!.id;
}

/**
 * Recent delivery audit rows FOR AN ORG (scoped through the rule — see the
 * file header), newest first.
 */
export async function listAlertDeliveriesForOrg(
  db: PotionDb,
  orgId: string,
  limit = 50,
): Promise<AlertDeliveryRow[]> {
  const rules = await db
    .select({ id: alertRules.id })
    .from(alertRules)
    .where(eq(alertRules.orgId, orgId));
  const ids = rules.map((r) => r.id);
  if (ids.length === 0) return [];
  return db
    .select()
    .from(alertDeliveries)
    .where(inArray(alertDeliveries.ruleId, ids))
    .orderBy(desc(alertDeliveries.createdAt))
    .limit(limit);
}
