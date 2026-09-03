// F4 — the Frontier Notes clock (docs/RESEARCH-FLEET.md + RESEARCH-OPS.md):
// the Tuesday chain runs INSIDE the server on a 60-second tick (the
// reaper's pattern — the queue is one worker at concurrency 1, so a job
// that waited on lab:run legs would deadlock it). The tick machine lives
// in @potion/workers (frontierNotesTick); this module wires its IO to the
// real database, queue, and the mounted research directory, and registers
// the admin trigger/status routes.
//
// Armed only when the four env vars are set:
//   POTION_RESEARCH_DIR              (prod: /research, mounted rw)
//   POTION_RESEARCH_ORG              (org-research)
//   POTION_RESEARCH_DELTA_HARNESS    (the author generation)
//   POTION_RESEARCH_AUDITOR_HARNESS  (the verifier generation)
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { sha256 } from '@potion/core';
import {
  appendExternalLabStep,
  createDb,
  createLabRun,
  ensureActionGrant,
  ensureExternalSession,
  getLabHarness,
  getLabRun,
  getLabRunFile,
  holdExternalSession,
  listActionGrants,
  listLabSteps,
  migrate,
  upsertLabRunFile,
} from '@potion/db';
import { buildStepPayload, ceilingFor, decideAction } from '@potion/lab-runtime';
import { parseHarnessSpecText } from '@potion/lab-spec';
import type { PotionQueue } from '@potion/queue';
import { clockFsIo, frontierNotesTick, isoWeekOf, PUBLISH_ACTION_CLASS, type ClockIO } from '@potion/workers';
import type { PotionContext } from './context.js';
import { requireRole } from './auth.js';

const TERMINAL = new Set(['completed', 'failed', 'killed-budget', 'killed-operator']);

export function registerFrontierNotesClock(
  app: FastifyInstance,
  ctx: PotionContext,
  opts: { queue: PotionQueue; intervalMs?: number },
): void {
  const db = ctx.db.db;
  const envDir = process.env.POTION_RESEARCH_DIR;
  const orgId = process.env.POTION_RESEARCH_ORG;
  const deltaHarness = process.env.POTION_RESEARCH_DELTA_HARNESS;
  const auditorHarness = process.env.POTION_RESEARCH_AUDITOR_HARNESS;
  const armed = Boolean(envDir && orgId && deltaHarness && auditorHarness);
  /** The primary dir plus any rehearsal dirs armed via the route (in-memory
   * by design: a rehearsal that does not survive a restart is a feature). */
  const dirs = new Set<string>(armed ? [envDir!] : []);

  function buildIo(researchDir: string): ClockIO {
    const fsIo = clockFsIo({
      researchDir,
      pricesVersion: ctx.prices.version,
      openStore: async (path) => {
        const handle = await createDb(`pglite://${path}`);
        await migrate(handle.db);
        return { db: handle.db as never, close: () => handle.close() };
      },
    });
    const gateSession = async (week: string): Promise<string> => {
      const sessionKey = `frontier-notes-publisher-${week.toLowerCase()}`;
      const id = `runx-${sha256(`${orgId}|${deltaHarness}|${sessionKey}`).slice(0, 16)}`;
      const harness = await getLabHarness(db, orgId!, deltaHarness!);
      const run = await ensureExternalSession(db, {
        id,
        orgId: orgId!,
        harnessHash: deltaHarness!,
        harnessName: harness?.name ?? 'delta',
        spec: { runtime: 'external', sessionKey, harnessHash: deltaHarness! },
      });
      return run.id;
    };
    return {
      ...fsIo,
      now: () => new Date(),
      deltaHarness: deltaHarness!,
      auditorHarness: auditorHarness!,
      log: (line) => app.log.info({ researchDir }, line),
      async startWorkerRun(harnessHash, attachment, extra) {
        const row = await getLabHarness(db, orgId!, harnessHash);
        if (row === null) throw new Error(`harness ${harnessHash.slice(0, 8)}… not found in ${orgId}`);
        const parsed = parseHarnessSpecText(row.specText);
        if (!parsed.ok) throw new Error(`harness ${harnessHash.slice(0, 8)}… spec invalid`);
        const runId = `run-${randomUUID().slice(0, 8)}`;
        await createLabRun(db, { id: runId, orgId: orgId!, harnessHash: parsed.hash, harnessName: parsed.spec.name, spec: parsed.spec });
        for (const a of [attachment, ...(extra ? [extra] : [])]) {
          const wrote = await upsertLabRunFile(db, { orgId: orgId!, runId, name: a.name, content: Buffer.from(a.content) });
          if (!wrote.ok) throw new Error(`attachment ${a.name} refused: ${wrote.reason}`);
        }
        await opts.queue.enqueue('lab:run', { orgId: orgId!, runId });
        return runId;
      },
      async runTerminalState(runId) {
        const run = await getLabRun(db, runId, orgId!);
        if (run === null) return 'failed';
        return TERMINAL.has(run.state) ? run.state : null;
      },
      async readRunFile(runId, name) {
        const f = await getLabRunFile(db, orgId!, runId, name);
        return f === null ? null : f.content.toString('utf8');
      },
      async gateAsk(argsHash, actionId, summary) {
        const week = isoWeekOf(new Date());
        const gateRunId = await gateSession(week);
        const grants = await listActionGrants(db, orgId!, deltaHarness!);
        const grant =
          grants.find((g) => g.actionClass === PUBLISH_ACTION_CLASS) ??
          (await ensureActionGrant(db, { orgId: orgId!, harnessHash: deltaHarness!, actionClass: PUBLISH_ACTION_CLASS, riskTier: 'irreversible-act' }));
        const harnessRow = await getLabHarness(db, orgId!, deltaHarness!);
        const parsedSpec = harnessRow !== null ? parseHarnessSpecText(harnessRow.specText) : null;
        const ceiling = ceilingFor(parsedSpec?.ok === true ? parsedSpec.spec.constitution : undefined, PUBLISH_ACTION_CLASS);
        const gd = decideAction({ actionClass: PUBLISH_ACTION_CLASS, ceiling, grantState: grant.state, auditRate: grant.auditRate }, Math.random());
        if (gd.decision === 'block') return { decision: 'blocked', question: gd.reason, gateRunId };
        if (gd.decision === 'allow') return { decision: 'allow', audit: gd.audit, gateRunId };
        const question = `The agent wants to run ${PUBLISH_ACTION_CLASS} with: ${summary} — allow it?`;
        await appendExternalLabStep(db, {
          runId: gateRunId,
          orgId: orgId!,
          kind: 'check-in',
          payload: buildStepPayload({
            kind: 'check-in',
            checkInTrigger: 'before-external-action',
            checkInQuestion: question,
            checkInAction: { toolName: PUBLISH_ACTION_CLASS, argsHash, arguments: summary, actionId },
            clockMs: Date.now(),
            rngSample: Math.random(),
          }),
        });
        await holdExternalSession(db, orgId!, gateRunId, question);
        return { decision: 'hold', question, gateRunId };
      },
      async gateResolution(gateRunId, actionId) {
        const steps = await listLabSteps(db, gateRunId, orgId!);
        for (const s of [...steps].reverse()) {
          const a = (s.payload as { checkInAnswer?: string }).checkInAnswer ?? '';
          if (!a.includes(`[action ${actionId}]`)) continue;
          if (a.startsWith('approved')) return 'approved';
          if (a.includes('rejected')) return 'rejected';
        }
        return null;
      },
      async gateOutcome(gateRunId, actionId, argsHash, ok) {
        await appendExternalLabStep(db, {
          runId: gateRunId,
          orgId: orgId!,
          kind: 'tool',
          payload: buildStepPayload({
            kind: 'tool',
            toolName: PUBLISH_ACTION_CLASS,
            toolOutput: `${ok ? 'executed' : 'failed'} [action ${actionId}] args ${argsHash.slice(0, 12)}`,
            clockMs: Date.now(),
            rngSample: Math.random(),
          }),
        });
      },
    };
  }

  // ---- the tick ----
  const tick = async (): Promise<void> => {
    for (const dir of dirs) {
      try {
        await frontierNotesTick(buildIo(dir));
      } catch (err) {
        app.log.warn({ err, dir }, 'frontier-notes tick failed — swallowed');
      }
    }
  };
  if (armed) {
    const interval = setInterval(() => void tick(), opts.intervalMs ?? 60_000);
    interval.unref();
    app.addHook('onClose', () => clearInterval(interval));
    app.log.info({ dir: envDir }, 'frontier-notes clock armed (Tuesday 06:00 PT window)');
  } else {
    app.log.info('frontier-notes clock disarmed — POTION_RESEARCH_* env not set');
  }

  // ---- admin trigger + status ----
  app.post('/api/research/frontier-notes', { preHandler: [requireRole('admin')] }, async (req: FastifyRequest, reply) => {
    if (!armed) return reply.code(409).send({ error: 'clock_disarmed', message: 'POTION_RESEARCH_* env not set' });
    const body = z
      .object({
        week: z.string().regex(/^\d{4}-W\d{2}$/).optional(),
        /** A rehearsal dir under the research mount — the full chain runs
         * against it without touching the public notes. */
        dir: z.string().max(300).optional(),
      })
      .safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: 'invalid_body', message: body.error.issues.map((i) => i.message).join('; ') });
    const dir = body.data.dir ?? envDir!;
    if (dir !== envDir && !dir.startsWith(`${envDir}/`)) {
      return reply.code(400).send({ error: 'invalid_body', message: `dir must live under ${envDir}` });
    }
    dirs.add(dir);
    const io = buildIo(dir);
    const week = body.data.week ?? isoWeekOf(new Date());
    if (io.readIssue(week) !== null) return reply.code(409).send({ error: 'already_produced', message: `${week} already has an issue in ${dir}` });
    if (io.readObservatoryRun(week) === null) return reply.code(409).send({ error: 'no_observatory_run', message: `${dir}/artifacts/runs/${week}.json is missing` });
    io.writeState({ week, phase: 'delta', startedAt: new Date().toISOString(), attempts: 0, note: 'operator-triggered' }, { exclusive: true });
    const stepped = await frontierNotesTick(io).catch((e: unknown) => `tick error: ${e instanceof Error ? e.message : String(e)}`);
    return reply.send({ armed: true, dir, week, stepped, state: io.readState(week) });
  });

  app.get('/api/research/frontier-notes', { preHandler: [requireRole('admin')] }, async (_req: FastifyRequest, reply) => {
    const week = isoWeekOf(new Date());
    const states = [...dirs].map((dir) => ({ dir, week, state: buildIo(dir).readState(week), issue: buildIo(dir).readIssue(week)?.status ?? null }));
    return reply.send({ armed, week, states });
  });
}
