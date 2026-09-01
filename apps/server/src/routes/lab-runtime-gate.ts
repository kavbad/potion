// L-G4 — the runtime gate (Lab direction v2, 2026-08-26): the pore, over
// HTTP, for EXTERNAL runtimes. OpenClaw is the first substrate; anything
// that can call four endpoints with a serving key can be governed.
//
//   POST /v1/lab/runtime/sessions      register an external session
//   POST /v1/lab/runtime/pore          "may I do X?" — the gate decision
//   POST /v1/lab/runtime/pore/resolve  report the human's resolution
//   POST /v1/lab/runtime/outcome       report execution results
//
// The decision honors the trust record exactly as the hosted loop does:
//   blocked      → refuse
//   autonomous   → allow (with the standing audit sample flag)
//   supervised   → HOLD: a fingerprint-bound check-in step is written and
//                  the session waits; the resolution becomes evidence via
//                  the same extractor the hosted pore feeds.
// Unanswered resolutions (timeout/cancelled) write NOTHING — a question
// the human never answered says nothing about the agent.
//
// Bearer-key surface (api.<domain>): org comes from the CALLING key, so
// every route is self-scoped; run ids are still org-guarded on read.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { sha256 } from '@potion/core';
import {
  appendExternalLabStep,
  ensureActionGrant,
  ensureExternalSession,
  getExternalSession,
  getLabHarness,
  getLabRun,
  holdExternalSession,
  insertEvidenceReport,
  listActionGrants,
  releaseExternalSession,
} from '@potion/db';
import { buildStepPayload, ceilingFor, constitutionTierOverrides, decideAction, runGraduationPass } from '@potion/lab-runtime';
import { parseHarnessSpecText } from '@potion/lab-spec';
import { CATALOG } from '@potion/lab-superpowers';
import { authenticate, bearerToken, openAiError } from '../auth.js';
import type { PotionContext } from '../context.js';

const SessionBody = z.object({
  harnessHash: z.string().regex(/^[0-9a-f]{64}$/),
  sessionKey: z.string().min(1).max(256),
  runtime: z.enum(['openclaw', 'external']).default('openclaw'),
});

const PoreBody = z.object({
  runId: z.string().min(1),
  /** W0: per-call unique identity — audit/approval state binds to it so
   * identical concurrent actions never collide. Optional for older
   * clients; ours always sends it. */
  actionId: z.string().min(1).max(64).optional(),
  toolName: z.string().min(1).max(200),
  argsHash: z.string().min(1).max(128),
  /** Shown to the supervisor; the runtime should pre-truncate. */
  argsSummary: z.string().max(2000).optional(),
});

const ResolveBody = z.object({
  runId: z.string().min(1),
  actionId: z.string().min(1).max(64).optional(),
  argsHash: z.string().min(1).max(128),
  resolution: z.enum(['allow-once', 'deny', 'timeout', 'cancelled']),
});

const OutcomeBody = z.object({
  runId: z.string().min(1),
  actionId: z.string().min(1).max(64).optional(),
  toolName: z.string().min(1).max(200),
  argsHash: z.string().min(1).max(128),
  ok: z.boolean(),
  fromAudit: z.boolean().optional(),
});

function classifyTool(actionClass: string): 'read' | 'act' | undefined {
  for (const pkg of CATALOG) {
    const tool = pkg.tools.find((t) => t.name === actionClass);
    if (tool) return tool.action;
  }
  return undefined;
}

const EvidenceBody = z.object({
  runId: z.string().min(1).max(128),
  actionClass: z.string().min(1).max(200),
  actionId: z.string().min(1).max(64).optional(),
  kind: z.enum(['outcome-ok', 'reversal', 'incident', 'audit-clean', 'audit-flagged']),
  detail: z.string().max(2000).optional(),
});

export function registerLabRuntimeGateRoutes(app: FastifyInstance, ctx: PotionContext): void {
  const db = ctx.db.db;
  const unauthorized = openAiError('missing or invalid api key', 'invalid_request_error', 'invalid_api_key');
  const notFound = openAiError('not found', 'invalid_request_error', 'not_found');
  registerLabEvidenceRoutes(app, ctx);

  async function orgOf(req: FastifyRequest): Promise<string | null> {
    const auth = await authenticate(db, bearerToken(req.headers.authorization));
    return auth ? auth.org.orgId : null;
  }

  app.post('/v1/lab/runtime/sessions', async (req: FastifyRequest, reply) => {
    const orgId = await orgOf(req);
    if (!orgId) return reply.code(401).send(unauthorized);
    const body = SessionBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send(openAiError('invalid session body', 'invalid_request_error'));
    const harness = await getLabHarness(db, orgId, body.data.harnessHash);
    if (!harness) return reply.code(404).send(notFound);
    // Deterministic id → idempotent registration per (org, harness, session).
    const id = `runx-${sha256(`${orgId}|${body.data.harnessHash}|${body.data.sessionKey}`).slice(0, 16)}`;
    const run = await ensureExternalSession(db, {
      id,
      orgId,
      harnessHash: body.data.harnessHash,
      harnessName: harness.name,
      spec: { runtime: body.data.runtime, sessionKey: body.data.sessionKey, harnessHash: body.data.harnessHash },
    });
    return reply.send({ runId: run.id, state: run.state });
  });

  app.post('/v1/lab/runtime/pore', async (req: FastifyRequest, reply) => {
    const orgId = await orgOf(req);
    if (!orgId) return reply.code(401).send(unauthorized);
    const body = PoreBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send(openAiError('invalid pore body', 'invalid_request_error'));
    const run = await getExternalSession(db, orgId, body.data.runId);
    if (!run) return reply.code(404).send(notFound);

    const grants = await listActionGrants(db, orgId, run.harnessHash);
    const grant =
      grants.find((g) => g.actionClass === body.data.toolName) ??
      (await ensureActionGrant(db, {
        orgId,
        harnessHash: run.harnessHash,
        actionClass: body.data.toolName,
        riskTier:
          classifyTool(body.data.toolName) === 'read'
            ? 'reversible-read'
            : classifyTool(body.data.toolName) === 'act'
              ? 'reversible-act'
              : 'irreversible-act', // fail closed: unknown consequence is high consequence
      }));

    // W1: ONE decision function for every runtime — the same pure
    // decideAction the native loop records and replay re-derives. The
    // harness's constitution ceiling out-ranks the grant row here too.
    const harnessRow = await getLabHarness(db, orgId, run.harnessHash);
    const parsedSpec = harnessRow !== null ? parseHarnessSpecText(harnessRow.specText) : null;
    const ceiling = ceilingFor(parsedSpec?.ok === true ? parsedSpec.spec.constitution : undefined, body.data.toolName);
    const gd = decideAction(
      { actionClass: body.data.toolName, ceiling, grantState: grant.state, auditRate: grant.auditRate },
      Math.random(),
    );
    if (gd.decision === 'block') {
      return reply.send({ decision: 'blocked', reason: grant.state === 'blocked' ? (grant.stateReason ?? gd.reason) : gd.reason });
    }
    if (gd.decision === 'allow') {
      // The standing sampled audit: unaudited autonomy is unmeasured autonomy.
      return reply.send({ decision: 'allow', audit: gd.audit });
    }
    // Supervised: the pore opens. Fingerprint-bound, exactly like the loop's.
    const question =
      `The agent wants to run ${body.data.toolName}` +
      (body.data.argsSummary ? ` with: ${body.data.argsSummary}` : '') +
      ' — allow it?';
    await appendExternalLabStep(db, {
      runId: run.id,
      orgId,
      kind: 'check-in',
      payload: buildStepPayload({
        kind: 'check-in',
        checkInTrigger: 'before-external-action',
        checkInQuestion: question,
        checkInAction: {
          toolName: body.data.toolName,
          argsHash: body.data.argsHash,
          arguments: body.data.argsSummary ?? '',
          ...(body.data.actionId !== undefined ? { actionId: body.data.actionId } : {}),
        },
        clockMs: Date.now(),
        rngSample: Math.random(),
      }),
    });
    await holdExternalSession(db, orgId, run.id, question);
    return reply.send({ decision: 'hold', question });
  });

  app.post('/v1/lab/runtime/pore/resolve', async (req: FastifyRequest, reply) => {
    const orgId = await orgOf(req);
    if (!orgId) return reply.code(401).send(unauthorized);
    const body = ResolveBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send(openAiError('invalid resolve body', 'invalid_request_error'));
    const run = await getExternalSession(db, orgId, body.data.runId);
    if (!run) return reply.code(404).send(notFound);
    let recorded = false;
    if (body.data.resolution === 'allow-once' || body.data.resolution === 'deny') {
      // The answer step the evidence extractor reads. 'timeout'/'cancelled'
      // write nothing: unanswered says nothing about the agent.
      await appendExternalLabStep(db, {
        runId: run.id,
        orgId,
        kind: 'model',
        payload: buildStepPayload({
          kind: 'model',
          checkInAnswer:
            (body.data.resolution === 'allow-once' ? 'approved' : 'rejected by supervisor') +
            (body.data.actionId !== undefined ? ` [action ${body.data.actionId}]` : ''),
          clockMs: Date.now(),
          rngSample: Math.random(),
        }),
      });
      recorded = true;
    }
    await releaseExternalSession(db, orgId, run.id);
    return reply.send({ recorded });
  });

  app.post('/v1/lab/runtime/outcome', async (req: FastifyRequest, reply) => {
    const orgId = await orgOf(req);
    if (!orgId) return reply.code(401).send(unauthorized);
    const body = OutcomeBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send(openAiError('invalid outcome body', 'invalid_request_error'));
    const run = await getExternalSession(db, orgId, body.data.runId);
    if (!run) return reply.code(404).send(notFound);
    await appendExternalLabStep(db, {
      runId: run.id,
      orgId,
      kind: 'tool',
      payload: buildStepPayload({
        kind: 'tool',
        toolName: body.data.toolName,
        // fromAudit rides the output marker so the sampled-review stream
        // stays labeled when the audit surface reads these steps back.
        toolOutput:
          `${body.data.ok ? 'executed' : 'failed'}` +
          `${body.data.fromAudit ? ' (audit sample)' : ''}` +
          `${body.data.actionId !== undefined ? ` [action ${body.data.actionId}]` : ''}`,
        clockMs: Date.now(),
        rngSample: Math.random(),
      }),
    });
    return reply.send({ recorded: true });
  });
}

/** W2 — the Outcome ABI (v1): external systems report what actually
 * happened downstream — outcomes, reversals, incidents, audit verdicts —
 * bound to the run (and optionally the actionId) they judge. Reports are
 * source documents; the graduation pass reads them beside the record, and
 * a reversal or incident tightens autonomy at the very next evaluation.
 * Bearer-keyed: the calling key's org scopes everything. */
export function registerLabEvidenceRoutes(app: FastifyInstance, ctx: PotionContext): void {
  const db = ctx.db.db;
  const unauthorized = openAiError('missing or invalid api key', 'invalid_request_error', 'invalid_api_key');
  const notFound = openAiError('not found', 'invalid_request_error', 'not_found');

  app.post('/v1/lab/evidence', async (req: FastifyRequest, reply) => {
    const auth = await authenticate(db, bearerToken(req.headers.authorization));
    if (!auth) return reply.code(401).send(unauthorized);
    const body = EvidenceBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send(openAiError('invalid evidence body', 'invalid_request_error'));
    // The run anchors the report to a harness — evidence about a run the
    // org does not own is a 404, never a write.
    const run = await getLabRun(db, body.data.runId, auth.org.orgId);
    if (run === null) return reply.code(404).send(notFound);
    const row = await insertEvidenceReport(db, {
      orgId: auth.org.orgId,
      harnessHash: run.harnessHash,
      runId: run.id,
      actionClass: body.data.actionClass,
      ...(body.data.actionId !== undefined ? { actionId: body.data.actionId } : {}),
      kind: body.data.kind,
      ...(body.data.detail !== undefined ? { detail: body.data.detail } : {}),
      reportedBy: `key:${auth.org.orgId}`,
    });
    // W2 — EVIDENCE ARRIVAL IS THE TRIGGER: the graduation pass runs the
    // moment a report lands, so a reversal or incident tightens autonomy
    // NOW — the gateway's act-time read makes it bite the very next
    // action. Best-effort: a pass failure never loses the report.
    let tightened: Array<{ actionClass: string; why: string }> = [];
    try {
      const harnessRow2 = await getLabHarness(db, auth.org.orgId, run.harnessHash);
      const parsed2 = harnessRow2 !== null ? parseHarnessSpecText(harnessRow2.specText) : null;
      const pass = await runGraduationPass({
        db, orgId: auth.org.orgId, harnessHash: run.harnessHash, classify: classifyTool,
        tierOverrides: constitutionTierOverrides(parsed2?.ok === true ? parsed2.spec.constitution : undefined),
      });
      tightened = pass.tightened;
    } catch { /* the report is durable; the next event retries the pass */ }
    return reply.code(201).send({ id: row.id, kind: row.kind, actionClass: row.actionClass, runId: row.runId, tightened });
  });
}
