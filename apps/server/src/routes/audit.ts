// Unified audit surface (M4, ROADMAP #34, SPEC §13.6) — org-scoped,
// admin-only audit reads over the THREE event sources, merged into one
// chronology:
//
//   custody_audit (0005) → custody.<action>  key created(encrypt)/rotated/
//                                            revoked/validated/decrypted
//   auth_events   (0012) → auth.<kind>       login/logout/invite
//   incidents     (0008) → incident.<kind>   quality_breach/rollback
//
//   GET /api/audit                 recent 100 unified events (dashboard
//                                  /settings/audit rendering), admin only.
//   GET /api/audit/export.jsonl?from&to
//                                  JSONL download, admin only. from/to are
//                                  REQUIRED (ISO dates or datetimes) and the
//                                  window is bounded to 92 days; the body is
//                                  STREAMED (chunked source reads merged
//                                  line-by-line — never fully buffered) with
//                                  Content-Disposition: attachment.
//
// Every line carries actor + ip + requestId where the source has them
// (auth_events does; custody/incidents predate per-request capture → null).
import { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import {
  AUDIT_EXPORT_CHUNK,
  listAuthEvents,
  listAuthEventsRange,
  listCustodyAudit,
  listCustodyAuditRange,
  listIncidentsRange,
  listIncidentsRecent,
  type AuthEventRow,
  type CustodyAuditRow,
  type IncidentRow,
  type PotionDb,
} from '@potion/db';
import { openAiError, requireRole } from '../auth.js';
import type { PotionContext } from '../context.js';

/** One unified audit line (JSON in /api/audit; one JSONL line in the export). */
export interface AuditEventDto {
  /** ISO-8601 event time. */
  ts: string;
  /** '<source>.<action>' — custody.encrypt, auth.login, incident.rollback, … */
  kind: string;
  /** Who acted (user id, email, api-key id, or a system actor). */
  actor: string;
  /** Source-specific metadata; NEVER key material or credentials. */
  detail: unknown;
  ip: string | null;
  requestId: string | null;
}

export const AUDIT_MAX_WINDOW_MS = 92 * 24 * 60 * 60 * 1000; // 92 days (contract)

function custodyDto(row: CustodyAuditRow): AuditEventDto {
  return {
    ts: row.createdAt.toISOString(),
    kind: `custody.${row.action}`,
    actor: row.actor,
    detail: { providerKeyId: row.providerKeyId, metadata: row.metadata },
    ip: null,
    requestId: null,
  };
}

function authDto(row: AuthEventRow): AuditEventDto {
  return {
    ts: row.createdAt.toISOString(),
    kind: `auth.${row.kind}`,
    actor: row.actor,
    detail: { method: row.method, ...(row.detail ?? {}) },
    ip: row.ip,
    requestId: row.requestId,
  };
}

function incidentDto(row: IncidentRow): AuditEventDto {
  return {
    ts: row.createdAt.toISOString(),
    kind: `incident.${row.kind}`,
    actor: 'system:guarantee',
    detail: { ...row.detail, resolvedAt: row.resolvedAt?.toISOString() ?? null },
    ip: null,
    requestId: null,
  };
}

/** Parse a from/to window: both REQUIRED, from ≤ to, span ≤ 92 days. */
export function parseAuditWindow(query: {
  from?: string;
  to?: string;
}): { from: Date; to: Date } | { error: string } {
  if (!query.from || !query.to) {
    return { error: 'from and to are both required (ISO dates or datetimes, max 92-day window)' };
  }
  const from = new Date(query.from);
  const to = new Date(query.to);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    return { error: 'from and to must be valid ISO dates or datetimes' };
  }
  if (from.getTime() > to.getTime()) {
    return { error: 'from must be at or before to' };
  }
  if (to.getTime() - from.getTime() > AUDIT_MAX_WINDOW_MS) {
    return { error: 'the export window may span at most 92 days' };
  }
  return { from, to };
}

// ---------------------------------------------------------------------------
// Streaming merge: chunked (LIMIT/OFFSET) oldest-first reads per source,
// k-way merged by created_at — the response body is never fully buffered.
// ---------------------------------------------------------------------------

type Timestamped = { createdAt: Date };

async function* chunks<T extends Timestamped>(
  read: (limit: number, offset: number) => Promise<T[]>,
): AsyncGenerator<T> {
  let offset = 0;
  for (;;) {
    const rows = await read(AUDIT_EXPORT_CHUNK, offset);
    for (const row of rows) yield row;
    if (rows.length < AUDIT_EXPORT_CHUNK) return;
    offset += rows.length;
  }
}

/** Merge N ascending streams into one ascending stream of DTO lines. */
async function* mergedLines(
  db: PotionDb,
  orgId: string,
  from: Date,
  to: Date,
): AsyncGenerator<string> {
  const sources: Array<{ it: AsyncGenerator<AuditEventDto>; head: IteratorResult<AuditEventDto> }> = [];
  const wrap = <T extends Timestamped>(
    gen: AsyncGenerator<T>,
    map: (row: T) => AuditEventDto,
  ): AsyncGenerator<AuditEventDto> =>
    (async function* () {
      for await (const row of gen) yield map(row);
    })();
  for (const it of [
    wrap(chunks((l, o) => listCustodyAuditRange(db, orgId, from, to, l, o)), custodyDto),
    wrap(chunks((l, o) => listAuthEventsRange(db, orgId, from, to, l, o)), authDto),
    wrap(chunks((l, o) => listIncidentsRange(db, orgId, from, to, l, o)), incidentDto),
  ]) {
    sources.push({ it, head: await it.next() });
  }
  for (;;) {
    let pick = -1;
    for (let i = 0; i < sources.length; i++) {
      const head = sources[i]!.head;
      if (head.done) continue;
      if (pick < 0 || head.value.ts < sources[pick]!.head.value!.ts) pick = i;
    }
    if (pick < 0) return;
    yield `${JSON.stringify(sources[pick]!.head.value)}\n`;
    sources[pick]!.head = await sources[pick]!.it.next();
  }
}

export function registerAuditRoutes(app: FastifyInstance, ctx: PotionContext): void {
  const db = ctx.db.db;

  // ---------- GET /api/audit — recent 100 unified events (admin) ----------
  app.get('/api/audit', { preHandler: [requireRole('admin')] }, async (req, reply) => {
    const org = req.potionOrg!;
    const [custody, auth, incidents] = await Promise.all([
      listCustodyAudit(db, org.orgId, undefined, 100),
      listAuthEvents(db, org.orgId, 100),
      listIncidentsRecent(db, org.orgId, 100),
    ]);
    const events = [...custody.map(custodyDto), ...auth.map(authDto), ...incidents.map(incidentDto)]
      .sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0))
      .slice(0, 100);
    return reply.send({ orgId: org.orgId, events });
  });

  // ---------- GET /api/audit/export.jsonl?from&to — JSONL download (admin) ----------
  app.get(
    '/api/audit/export.jsonl',
    { preHandler: [requireRole('admin')] },
    async (req, reply) => {
      const org = req.potionOrg!;
      const window = parseAuditWindow(req.query as { from?: string; to?: string });
      if ('error' in window) {
        return reply.code(400).send(openAiError(window.error, 'invalid_request_error'));
      }
      const day = (d: Date) => d.toISOString().slice(0, 10);
      const filename = `potion-audit-${org.orgId}-${day(window.from)}-${day(window.to)}.jsonl`;
      reply.header('content-type', 'application/x-ndjson; charset=utf-8');
      reply.header('content-disposition', `attachment; filename="${filename}"`);
      return reply.send(Readable.from(mergedLines(db, org.orgId, window.from, window.to)));
    },
  );
}
