// alerts:dispatch (M4 #33, SPEC §13.5) — moved out of handlers.ts 2026-09-09.
//
// A PURE MOVE. Its own module rather than part of handler-shared because
// `emitAlertEvent`, which other handlers call, reaches `dispatchAlertEvent`
// and the delivery types with it — "shared" would have meant dragging a whole
// subsystem into a file meant for common ground.

import { type PotionDb } from '@potion/db';
import { ALERT_EVENTS, insertAlertDelivery, matchingAlertRules, redactUrl, redactUrlsInText, type AlertEvent, type AlertRuleRow } from '@potion/db';
import {  } from 'drizzle-orm';
import {  } from 'drizzle-orm';
import { type AlertsDispatchPayload } from './jobs.js';
import {
    
   
  type JobContext, type WorkerHandler,
} from './handler-shared.js';

// alerts:dispatch — alert delivery (M4 #33, SPEC §13.5). One job per alert
// EVENT; the handler resolves the org's ENABLED rules subscribed to the
// event and POSTs each one. Per-rule outcomes land in alert_deliveries
// (audit). target_url NEVER leaves alert_rules: delivery rows and error
// text are query-string-redacted (webhook secrets ride query strings).
//
// RETRY SEMANTICS (documented): delivery retries are PER-RULE INLINE (up to
// ALERT_DISPATCH_ATTEMPTS with backoff). The memory queue driver does not
// retry jobs at all, and a job-level retry would re-deliver the rules that
// already succeeded (duplicate notifications) — inline per-rule attempts
// keep delivery idempotent across both drivers. The bullmq driver's 3×
// job-level retry still covers infrastructure faults (db down mid-job).
// ---------------------------------------------------------------------------

/** Attempts per rule before the delivery is marked failed. */
export const ALERT_DISPATCH_ATTEMPTS = 3;
/** Per-attempt POST timeout. */
export const ALERT_DISPATCH_TIMEOUT_MS = 5_000;
/** Backoff BEFORE attempt i+1 (ms) — index 0 is the first attempt. */
export const ALERT_DISPATCH_BACKOFF_MS = [0, 50, 150] as const;

/** Injectable seams (tests / server in-process fallback). */
export interface AlertDispatchDeps {
  fetchImpl?: typeof fetch;
  /** Email transport for mailto: rules (2026-08-24) — the server registers
   * its Resend sender; without one a mailto rule records a failed delivery
   * instead of silently succeeding. */
  sendEmail?: (msg: { to: string; subject: string; text: string }) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  /** Failure/observability log — receives ONLY redacted text. */
  log?: (msg: string) => void;
  /** G2.2: SLA latency observation per DELIVERED rule (server-registered). */
  meter?: { observeAlertNotificationLatency?(o: { orgId: string; event: string; latencyMs: number }): void };
}

/** Slack-compatible text form of an alert event (kind=slack → {text}). */
export function alertSlackText(payload: AlertsDispatchPayload): string {
  const detail = JSON.stringify(payload.detail ?? {});
  return `*[potion] ${payload.event}* org=${payload.orgId} — ${detail}`;
}

/** The POST body for a rule kind: webhook gets the contract JSON
 * {event, org_id, detail, ts}; slack gets {text} (incoming-webhook shape). */
export function alertRequestBody(
  kind: AlertRuleRow['kind'],
  payload: AlertsDispatchPayload,
  ts: string,
): string {
  if (kind === 'slack') return JSON.stringify({ text: alertSlackText(payload) });
  return JSON.stringify({
    event: payload.event,
    org_id: payload.orgId,
    detail: payload.detail ?? {},
    ts,
  });
}

export interface AlertDeliveryOutcome {
  ruleId: string;
  kind: AlertRuleRow['kind'];
  status: 'delivered' | 'failed';
  attempts: number;
  /** Query-string-redacted failure detail (null on success). */
  lastError: string | null;
}

export interface AlertsDispatchResult {
  orgId: string;
  event: AlertEvent;
  /** Enabled rules matching the event subscription. */
  matched: number;
  delivered: number;
  failed: number;
  outcomes: AlertDeliveryOutcome[];
}

/** POST one rule with inline per-rule retry; append the audit row. */
async function deliverByEmail(
  db: PotionDb,
  rule: AlertRuleRow,
  payload: AlertsDispatchPayload,
  body: string,
  ts: string,
  deps: AlertDispatchDeps,
): Promise<AlertDeliveryOutcome> {
  const to = rule.targetUrl.slice('mailto:'.length);
  let delivered = false;
  let lastError: string | null = null;
  if (deps.sendEmail === undefined) {
    lastError = 'no email transport registered for mailto rules';
  } else {
    try {
      await deps.sendEmail({
        to,
        subject: `[potion alert] ${payload.event} — org ${payload.orgId}`,
        text: `Alert: ${payload.event}\nOrg: ${payload.orgId}\nAt: ${ts}\n\n${body}\n`,
      });
      delivered = true;
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
  }
  await insertAlertDelivery(db, {
    ruleId: rule.id,
    event: payload.event,
    status: delivered ? 'delivered' : 'failed',
    attempts: 1,
    ...(lastError !== null ? { lastError } : {}),
    ...(delivered ? { deliveredAt: deps.now?.() ?? new Date() } : {}),
    ...(payload.incidentId !== undefined ? { incidentId: payload.incidentId } : {}),
  });
  return { ruleId: rule.id, kind: rule.kind, status: delivered ? 'delivered' : 'failed', attempts: 1, lastError };
}

async function deliverToRule(
  db: PotionDb,
  rule: AlertRuleRow,
  payload: AlertsDispatchPayload,
  deps: AlertDispatchDeps,
): Promise<AlertDeliveryOutcome> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? (() => new Date());
  const ts = now().toISOString();
  const body = alertRequestBody(rule.kind, payload, ts);
  // mailto: rules deliver by email (2026-08-24) — same retries, same
  // delivery record, a different transport.
  if (rule.targetUrl.startsWith('mailto:')) {
    return deliverByEmail(db, rule, payload, body, ts, deps);
  }
  // The redacted target is safe to put in logs/audit; the raw URL is not.
  const redactedTarget = redactUrl(rule.targetUrl);
  let attempts = 0;
  let lastError: string | null = null;
  let delivered = false;
  for (let i = 0; i < ALERT_DISPATCH_ATTEMPTS; i++) {
    const backoff = ALERT_DISPATCH_BACKOFF_MS[Math.min(i, ALERT_DISPATCH_BACKOFF_MS.length - 1)]!;
    if (backoff > 0) await sleep(backoff);
    attempts += 1;
    try {
      const res = await fetchImpl(rule.targetUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal: AbortSignal.timeout(ALERT_DISPATCH_TIMEOUT_MS),
      });
      if (res.ok) {
        delivered = true;
        lastError = null;
        break;
      }
      lastError = `HTTP ${res.status} from ${redactedTarget}`;
    } catch (err) {
      // fetch errors never embed the URL, but redact defensively anyway.
      lastError = redactUrlsInText(
        `POST ${redactedTarget} failed: ${(err as Error).message}`,
      );
    }
  }
  // G2.2 SLA latency: measured at the SUCCESSFUL POST against the clock
  // the EMITTER bound (advisory creation on the hierarchy path). Clamped
  // ≥ 0 against db/app clock skew. A failed delivery has NO latency —
  // the row still carries the clock so the gap is auditable.
  const clockStartMs = payload.clockStartAt !== undefined ? Date.parse(payload.clockStartAt) : NaN;
  const latencyMs =
    delivered && Number.isFinite(clockStartMs)
      ? Math.max(0, now().getTime() - clockStartMs)
      : null;
  await insertAlertDelivery(db, {
    ruleId: rule.id,
    event: payload.event,
    status: delivered ? 'delivered' : 'failed',
    attempts,
    ...(lastError !== null ? { lastError } : {}),
    ...(delivered ? { deliveredAt: now() } : {}),
    ...(payload.incidentId !== undefined ? { incidentId: payload.incidentId } : {}),
    ...(Number.isFinite(clockStartMs) ? { clockStartAt: new Date(clockStartMs) } : {}),
    ...(latencyMs !== null ? { latencyMs } : {}),
  });
  if (latencyMs !== null) {
    deps.meter?.observeAlertNotificationLatency?.({
      orgId: payload.orgId,
      event: payload.event,
      latencyMs,
    });
  }
  if (!delivered) {
    deps.log?.(
      `alerts: rule ${rule.id} (${rule.kind}) event ${payload.event} FAILED after ` +
        `${attempts} attempt(s): ${lastError ?? 'unknown'}`,
    );
  }
  return { ruleId: rule.id, kind: rule.kind, status: delivered ? 'delivered' : 'failed', attempts, lastError };
}

/**
 * Dispatch one alert event to the org's matching enabled rules. Shared by
 * the alerts:dispatch job handler AND the server's in-process fire-and-
 * forget fallback (no queue on ctx — see apps/server/src/alerts.ts).
 */
export async function dispatchAlertEvent(
  db: PotionDb,
  payload: AlertsDispatchPayload,
  deps: AlertDispatchDeps = {},
): Promise<AlertsDispatchResult> {
  if (!ALERT_EVENTS.includes(payload.event)) {
    throw new Error(`alerts:dispatch unknown event '${payload.event}'`);
  }
  const rules = await matchingAlertRules(db, payload.orgId, payload.event);
  const outcomes: AlertDeliveryOutcome[] = [];
  for (const rule of rules) {
    outcomes.push(await deliverToRule(db, rule, payload, deps));
  }
  return {
    orgId: payload.orgId,
    event: payload.event,
    matched: rules.length,
    delivered: outcomes.filter((o) => o.status === 'delivered').length,
    failed: outcomes.filter((o) => o.status === 'failed').length,
    outcomes,
  };
}

/** alerts:dispatch handler factory (G2.2): the server registers it with
 * its observability meter + log sink; the meter-less default below keeps
 * bare workers working. */
export function createAlertsDispatchHandler(opts: {
  deps?: AlertDispatchDeps;
}): WorkerHandler<'alerts:dispatch'> {
  return async (payload: AlertsDispatchPayload, ctx: JobContext): Promise<AlertsDispatchResult> =>
    dispatchAlertEvent(ctx.db, payload, opts.deps ?? {});
}

export const alertsDispatchHandler: WorkerHandler<'alerts:dispatch'> =
  createAlertsDispatchHandler({});

/**
 * Emit an alert event: enqueue alerts:dispatch when the job context carries
 * a queue, else deliver in-process (the same fallback contract the server
 * uses — see apps/server/src/alerts.ts). NEVER throws into the caller's
 * control flow beyond queue/db faults the caller already tolerates; callers
 * wrap in try/catch like every other fire-and-forget emission.
 */
export async function emitAlertEvent(
  ctx: Pick<JobContext, 'db' | 'queue'>,
  payload: AlertsDispatchPayload,
): Promise<void> {
  if (ctx.queue) {
    await ctx.queue.enqueue('alerts:dispatch', payload);
    return;
  }
  await dispatchAlertEvent(ctx.db, payload);
}

