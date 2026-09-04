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
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createWriteStream, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
  listRecentlyPromoted,
  listResearchCycles,
  migrate,
  upsertLabRunFile,
} from '@potion/db';
import { buildStepPayload, ceilingFor, decideAction } from '@potion/lab-runtime';
import { parseHarnessSpecText } from '@potion/lab-spec';
import type { PotionQueue } from '@potion/queue';
import { clockFsIo, composeDailyFacts, dailyLedgerTick, frontierNotesTick, isoWeekOf, PUBLISH_ACTION_CLASS, type ClockIO, type DailyFacts } from '@potion/workers';
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

  // F6: the day's facts, composed from the instruments' own rows.
  const dailyFacts = async (): Promise<DailyFacts> => {
    const cycles = await listResearchCycles(db, 200);
    const promoted = await listRecentlyPromoted(db, 1, 100);
    const now = new Date();
    const since = now.getTime() - 24 * 60 * 60 * 1000;
    return composeDailyFacts({
      now,
      cycles: cycles.map((c) => ({
        focusAlias: c.focusAlias,
        status: c.status,
        provenance: c.provenance,
        candidates: (c.candidates ?? []).length,
        spendUsd: c.spendUsd,
        createdAt: c.createdAt,
      })),
      promoted: promoted.filter((p) => new Date(p.updatedAt).getTime() >= since).length,
      registrySize: Object.keys(ctx.prices.entries ?? {}).length,
      pricesVersion: ctx.prices.version,
    });
  };

  // ══ F5 — THE MONDAY TICK: the measurement half ══════════════════════
  //
  // This lane SPENDS REAL MONEY, so it does not reimplement anything: it
  // runs the proven scripts/observatory-week.ts — the same orchestration,
  // the same envelope belt (a monthly cap written as a hard-stop budget on
  // the platform-ops org), the same per-lane caps — inside this container,
  // where the whole tree and tsx already live.
  //
  // The belts, in order:
  //   1. DISARMED by default. POTION_OBSERVATORY_ARM must carry a date —
  //      the same dated risk-acceptance the script demands by hand. No
  //      value, no spending, ever.
  //   2. One run per ISO week: an exclusive state file plus the run-file
  //      guard, so a restart storm cannot double-spend.
  //   3. The script's own envelope remains the real ceiling.
  //   4. FRONTIER_NOTES_SKIP=1 — the measurement never publishes; the
  //      fleet's Tuesday chain owns the byline.
  const armDate = process.env.POTION_OBSERVATORY_ARM ?? '';
  const measureArmed = armed && /^\d{4}-\d{2}-\d{2}$/.test(armDate);
  let measureRunning: { week: string; startedAt: string } | null = null;

  /** Monday 06:00–23:59 PT — before the notes window opens on Tuesday. */
  function inMondayWindow(d: Date): boolean {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', weekday: 'short', hour: 'numeric', hour12: false }).formatToParts(d);
    return parts.find((p) => p.type === 'weekday')?.value === 'Mon' && Number(parts.find((p) => p.type === 'hour')?.value ?? '0') >= 6;
  }

  async function observatoryTick(opts: { dry?: boolean; force?: boolean } = {}): Promise<string | null> {
    if (!measureArmed) return null;
    if (measureRunning !== null) return null; // one at a time, always
    const now = new Date();
    if (!opts.force && !inMondayWindow(now)) return null;
    const week = isoWeekOf(now);
    const io = buildIo(envDir!);
    if (!opts.dry && io.readObservatoryRun(week) !== null) return null; // measured already
    const stateDir = join(envDir!, 'artifacts', 'observatory-state');
    const marker = join(stateDir, `${week}.json`);
    if (!opts.dry) {
      mkdirSync(stateDir, { recursive: true });
      try {
        // Exclusive create IS the lock: a second replica loses the race.
        writeFileSync(marker, JSON.stringify({ week, startedAt: now.toISOString(), arm: armDate }, null, 1), { flag: 'wx' });
      } catch {
        return null;
      }
    }
    measureRunning = { week, startedAt: now.toISOString() };
    const logPath = join(envDir!, 'artifacts', `observatory-${week}${opts.dry ? '-dry' : ''}.log`);
    // The .bin/tsx entry is a SHELL wrapper, not a JS module — handing it
    // to node fails with a syntax error (found by driving the real command
    // in the container). Spawn the wrapper itself; its shebang runs it.
    const tsx = join('/app', 'node_modules', '.bin', 'tsx');
    const args = ['scripts/observatory-week.ts', ...(opts.dry ? ['--dry'] : [])];
    app.log.info({ week, dry: opts.dry === true }, 'observatory: starting the weekly measurement');
    const child = spawn(tsx, args, {
      cwd: '/app',
      env: {
        ...process.env,
        KEY_RISK_ACCEPTED: armDate,
        OBSERVATORY_DB: join(envDir!, 'store'),
        OBSERVATORY_ARTIFACTS: join(envDir!, 'artifacts'),
        // The fleet publishes; the measurement never does.
        FRONTIER_NOTES_SKIP: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const log = createWriteStream(logPath, { flags: 'a' });
    child.stdout.pipe(log);
    child.stderr.pipe(log);
    child.on('close', (code) => {
      measureRunning = null;
      app.log.info({ week, code, logPath }, `observatory: measurement exited ${code}`);
      if (!opts.dry && code !== 0) {
        // A failed week must not wedge the lane: clear the marker so the
        // next Monday tick (or an operator trigger) can retry.
        try {
          rmSync(marker, { force: true });
        } catch {
          /* the marker is a convenience, never a correctness boundary */
        }
      }
    });
    return `observatory:${week}${opts.dry ? ' (dry)' : ''}`;
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
    // F5: the measurement half — Mondays, money-armed only.
    try {
      await observatoryTick();
    } catch (err) {
      app.log.warn({ err }, 'observatory tick failed — swallowed');
    }
    // F6: the daily ledger — every day, on the primary dir only.
    if (armed) {
      try {
        const io = buildIo(envDir!);
        await dailyLedgerTick({
          now: io.now,
          dailyFacts,
          readIssue: io.readIssue,
          writeIssueFiles: io.writeIssueFiles,
          startWorkerRun: io.startWorkerRun,
          runTerminalState: io.runTerminalState,
          readRunFile: io.readRunFile,
          readState: io.readState,
          writeState: io.writeState,
          deltaHarness: io.deltaHarness,
          log: io.log,
        });
      } catch (err) {
        app.log.warn({ err }, 'frontier-notes daily tick failed — swallowed');
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
        /** F5: 'dry' plans the measurement without spending a cent; 'run'
         * starts the real one (still refused unless money-armed). */
        measure: z.enum(['dry', 'run']).optional(),
        week: z.string().regex(/^\d{4}-W\d{2}$/).optional(),
        /** A rehearsal dir under the research mount — the full chain runs
         * against it without touching the public notes. */
        dir: z.string().max(300).optional(),
      })
      .safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: 'invalid_body', message: body.error.issues.map((i) => i.message).join('; ') });
    if (body.data.measure !== undefined) {
      if (!measureArmed) {
        return reply.code(409).send({ error: 'measurement_disarmed', message: 'set POTION_OBSERVATORY_ARM=YYYY-MM-DD to arm the spending lane' });
      }
      const started = await observatoryTick({ dry: body.data.measure === 'dry', force: true });
      return reply.send({ measurement: started ?? 'not started (already running, or already measured this week)', arm: armDate });
    }
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
    return reply.send({
      armed,
      week,
      states,
      // F5: the measurement lane — armed separately because it spends.
      measurement: {
        armed: measureArmed,
        arm: measureArmed ? armDate : null,
        running: measureRunning,
        measuredThisWeek: armed ? buildIo(envDir!).readObservatoryRun(week) !== null : null,
      },
    });
  });
}
