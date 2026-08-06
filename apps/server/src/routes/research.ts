// Research routes (M4b, ROADMAP #37 + #32, SPEC §15.2/§15.5 + §13.4).
//
//   POST /api/research/scan          admin — enqueue a research:scan job
//                                    (new-model detection → cycle fan-out).
//   GET  /api/research/cycles        viewer+ — recent research cycles (the
//                                    lineage behind /recipes rows).
//   GET  /api/recipes?cluster&status viewer+ — the recipe LIBRARY: every
//                                    known strategy config + lifecycle state
//                                    + eval lineage (runs × provenance ×
//                                    cycles × dates).
//   POST /api/recipes/:hash/evaluate admin — enqueue a single-recipe
//                                    research:cycle (§15.5).
//   GET  /api/leaderboard            PUBLIC (session-free, §13.4) — the
//                                    public face of the library: per-cluster
//                                    LIVE-provenance frontier recipes only.
//                                    Pre-M1b there is no live evidence, and
//                                    the response says so honestly:
//                                    status 'awaiting_live_verification'.
//                                    Mock data is NEVER presented as live.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  latestLiveRunForPoint,
  listAllRecipeStatus,
  listAllStrategyConfigs,
  listClusters,
  listEvalLineageRows,
  listLeaderboardAdopters,
  listResearchCycles,
  RECIPE_STATUSES,
  type RecipeStatus,
} from '@potion/db';
import { strategyHash, type StrategyConfig } from '@potion/core';
import { loadCurrentFrontier } from '@potion/pareto';
import type { PotionQueue } from '@potion/queue';
import type { ResearchCyclePayload, ResearchScanPayload } from '@potion/workers';
import { openAiError, roleAtLeast } from '../auth.js';
import type { PotionContext } from '../context.js';

export interface ResearchRoutesOptions {
  queue: PotionQueue;
}

/** Public-leaderboard minimum quality for a listed point (env-tunable; the
 * bar exists so the board never showcases a weak recipe). */
export const LEADERBOARD_QUALITY_MIN = Number(process.env.POTION_LEADERBOARD_QUALITY_MIN ?? '0.5');

/** Human-readable one-liner for a strategy config (leaderboard/recipes). */
export function strategyLabel(config: StrategyConfig): string {
  switch (config.type) {
    case 'single':
      return `single · ${config.model}`;
    case 'cascade':
      return `cascade · ${config.stages.map((s) => s.model).join(' → ')}`;
    case 'composite':
      return `composite · ${config.startModel} ⇢ ${config.upgradeModel}`;
    case 'draft-verify':
      return `draft-verify · ${config.draftModel} + verify ${config.verifierModel}`;
    case 'best-of-n':
      return `best-of-${config.n} · ${config.model} (judge ${config.judge.model})`;
    case 'ensemble':
      return `ensemble · ${config.models.join(' + ')}`;
    case 'decompose':
      return `decompose · ${config.decomposerModel}`;
  }
}

const ScanBody = z.object({
  source: z.enum(['mock', 'openrouter']).optional(),
});

function forbidden(role: string, action: string) {
  return openAiError(
    `role '${role}' may not ${action} — requires 'admin'`,
    'invalid_request_error',
    'insufficient_role',
  );
}

export function registerResearchRoutes(
  app: FastifyInstance,
  ctx: PotionContext,
  opts: ResearchRoutesOptions,
): void {
  const db = ctx.db.db;

  // ---- POST /api/research/scan (admin) ----
  app.post('/api/research/scan', async (req: FastifyRequest, reply) => {
    const org = req.potionOrg!;
    if (!roleAtLeast(org.role, 'admin')) {
      return reply.code(403).send(forbidden(org.role, 'trigger a research scan'));
    }
    const parsed = ScanBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'invalid_body',
        message: parsed.error.issues.map((i) => i.message).join('; '),
      });
    }
    const payload: ResearchScanPayload = {
      ...(parsed.data.source !== undefined ? { source: parsed.data.source } : {}),
      orgId: org.orgId,
    };
    const jobId = await opts.queue.enqueue('research:scan', payload);
    return reply.code(202).send({ jobId });
  });

  // ---- GET /api/research/cycles (viewer+) ----
  app.get('/api/research/cycles', async (req: FastifyRequest, reply) => {
    const cycles = await listResearchCycles(db, 50);
    return reply.send({
      cycles: cycles.map((c) => ({
        id: c.id,
        trigger: c.trigger,
        focusAlias: c.focusAlias,
        status: c.status,
        candidates: (c.candidates as StrategyConfig[]).length,
        spendUsd: c.spendUsd,
        provenance: c.provenance,
        seed: c.seed,
        createdAt: c.createdAt,
        completedAt: c.completedAt,
      })),
    });
  });

  // ---- GET /api/recipes?cluster&status (viewer+) — the recipe library ----
  app.get('/api/recipes', async (req: FastifyRequest, reply) => {
    const query = z
      .object({
        cluster: z.string().min(1).optional(),
        status: z.enum(RECIPE_STATUSES as [RecipeStatus, ...RecipeStatus[]]).optional(),
      })
      .safeParse(req.query);
    if (!query.success) {
      return reply.code(400).send({
        error: 'invalid_query',
        message: query.error.issues.map((i) => i.message).join('; '),
      });
    }

    const configs = await listAllStrategyConfigs(db);
    const statuses = await listAllRecipeStatus(db);
    const statusByHash = new Map(statuses.map((s) => [s.strategyHash, s]));

    // Eval lineage per hash (provenance set, runs, dates, clusters).
    const evalRows = await listEvalLineageRows(db);
    type Lineage = {
      evalCount: number;
      runIds: Set<string>;
      provenances: Set<string>;
      clusters: Set<string>;
      firstSeen: Date | null;
      lastSeen: Date | null;
    };
    const lineageByHash = new Map<string, Lineage>();
    for (const r of evalRows) {
      const l = lineageByHash.get(r.strategyHash) ?? {
        evalCount: 0,
        runIds: new Set<string>(),
        provenances: new Set<string>(),
        clusters: new Set<string>(),
        firstSeen: null,
        lastSeen: null,
      };
      l.evalCount++;
      l.runIds.add(r.runId);
      l.provenances.add(r.providerMode);
      l.clusters.add(r.clusterId);
      const ts = new Date(r.createdAt);
      if (l.firstSeen === null || ts < l.firstSeen) l.firstSeen = ts;
      if (l.lastSeen === null || ts > l.lastSeen) l.lastSeen = ts;
      lineageByHash.set(r.strategyHash, l);
    }

    // Cycle membership per hash (recent cycles, candidates jsonb).
    const cycles = await listResearchCycles(db, 200);
    const cyclesByHash = new Map<string, { id: string; trigger: string; focusAlias: string | null; createdAt: Date }[]>();
    for (const c of cycles) {
      for (const cfg of c.candidates as StrategyConfig[]) {
        const h = strategyHash(cfg);
        const list = cyclesByHash.get(h) ?? [];
        list.push({ id: c.id, trigger: c.trigger, focusAlias: c.focusAlias, createdAt: c.createdAt });
        cyclesByHash.set(h, list);
      }
    }

    const recipes = configs
      .map((row) => {
        const lineage = lineageByHash.get(row.hash);
        const provenances = lineage ? [...lineage.provenances] : [];
        const provenance =
          provenances.length === 0
            ? 'unknown'
            : provenances.length === 1
              ? provenances[0]!
              : 'mixed';
        return {
          hash: row.hash,
          config: row.config,
          label: strategyLabel(row.config),
          status: statusByHash.get(row.hash)?.status ?? 'candidate',
          provenance,
          lineage: {
            evalCount: lineage?.evalCount ?? 0,
            runIds: lineage ? [...lineage.runIds].slice(-5) : [],
            clusters: lineage ? [...lineage.clusters] : [],
            firstSeen: lineage?.firstSeen ?? null,
            lastSeen: lineage?.lastSeen ?? null,
            cycles: cyclesByHash.get(row.hash) ?? [],
          },
          registeredAt: row.createdAt,
        };
      })
      .filter((r) => (query.data.status !== undefined ? r.status === query.data.status : true))
      .filter((r) =>
        query.data.cluster !== undefined ? r.lineage.clusters.includes(query.data.cluster) : true,
      )
      // Frontier recipes first, then most-evaluated, then newest.
      .sort((a, b) => {
        const rank = (s: string) => (s === 'frontier' ? 0 : s === 'candidate' ? 1 : 2);
        return (
          rank(a.status) - rank(b.status) ||
          b.lineage.evalCount - a.lineage.evalCount ||
          new Date(b.registeredAt).getTime() - new Date(a.registeredAt).getTime()
        );
      });

    return reply.send({ recipes });
  });

  // ---- POST /api/recipes/:hash/evaluate (admin) ----
  app.post('/api/recipes/:hash/evaluate', async (req: FastifyRequest, reply) => {
    const org = req.potionOrg!;
    if (!roleAtLeast(org.role, 'admin')) {
      return reply.code(403).send(forbidden(org.role, 'evaluate recipes'));
    }
    const { hash } = req.params as { hash: string };
    const rows = (await listAllStrategyConfigs(db)).filter((r) => r.hash === hash);
    if (rows.length === 0) {
      return reply
        .code(404)
        .send({ error: 'not_found', message: `no recipe registered with hash '${hash}'` });
    }
    const payload: ResearchCyclePayload = { recipeHash: hash, trigger: 'manual', orgId: org.orgId };
    const jobId = await opts.queue.enqueue('research:cycle', payload);
    return reply.code(202).send({ jobId });
  });

  // ---- GET /api/leaderboard — PUBLIC (§13.4; exempted in the auth hook) ----
  app.get('/api/leaderboard', async (_req: FastifyRequest, reply) => {
    const allClusters = await listClusters(db);
    const entries: {
      clusterId: string;
      clusterName: string;
      strategyHash: string;
      strategyLabel: string;
      costPer1K: number;
      quality: number;
      verificationRunId: string | null;
      frontierVersion: number;
      verifiedAt: string | null;
    }[] = [];

    for (const c of allClusters) {
      const frontier = await loadCurrentFrontier(db, c.id);
      if (!frontier) continue;
      // LIVE-provenance points at/above the quality bar only — mock evidence
      // never appears on the public board (§13.4).
      const livePoints = frontier.points.filter(
        (p) => p.providerMode === 'live' && p.quality >= LEADERBOARD_QUALITY_MIN,
      );
      for (const p of livePoints) {
        // Latest live run id for this (cluster, hash) — the verification
        // provenance a skeptic can re-run.
        const run = await latestLiveRunForPoint(db, c.id, p.strategyHash);
        entries.push({
          clusterId: c.id,
          clusterName: c.name,
          strategyHash: p.strategyHash,
          strategyLabel: strategyLabel(p.strategyConfig),
          costPer1K: p.costPer1K,
          quality: p.quality,
          verificationRunId: run?.runId ?? null,
          frontierVersion: frontier.version,
          verifiedAt: run?.createdAt ?? null,
        });
      }
    }

    // Org opt-in publishing (§13.4): names only, never data.
    const adopters = await listLeaderboardAdopters(db);

    if (entries.length === 0) {
      // Honest empty state (§13.4): pre-M1b there IS no live evidence. Never
      // substitute mock numbers.
      return reply.send({
        status: 'awaiting_live_verification',
        message:
          'No live-verified frontier recipes yet. The leaderboard publishes only recipes ' +
          'evaluated against real providers (provenance=live); simulated evidence is never shown.',
        entries: [],
        adoptingOrgs: adopters.map((a) => a.name),
      });
    }
    return reply.send({
      status: 'ok',
      entries: entries.sort((a, b) => a.clusterId.localeCompare(b.clusterId) || b.quality - a.quality),
      adoptingOrgs: adopters.map((a) => a.name),
    });
  });
}
