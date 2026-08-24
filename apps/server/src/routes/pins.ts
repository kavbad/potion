// R7 (2026-08-24) — the customer's half of "the frontier must move".
//
//   GET    /api/pins                  what you are served vs what exists
//   PUT    /api/pins/:clusterId       freeze the version you are served now
//   DELETE /api/pins/:clusterId       release; the newest version serves again
//   GET    /api/frontier-changelog    what moved, in buyer-readable English
//
// Silent improvement stays the DEFAULT — no pin, no change in behavior. What
// this adds is the right to opt out of it deliberately, and to be told what
// you are holding back. Procurement asks about reproducibility before it
// asks about savings; this is the answer.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  getFrontierPin,
  getLatestFrontier,
  getServingFrontier,
  getUserById,
  listClusters,
  listFrontierPins,
  listServedClusterIds,
  releaseFrontierPin,
  setFrontierPin,
} from '@potion/db';
import { diffFrontiers } from '@potion/pareto';
import type { Frontier } from '@potion/core';
import { openAiError, requireRole } from '../auth.js';
import type { PotionContext } from '../context.js';

const INSTRUMENTS = ['default', 'tools', 'vision', 'audio'] as const;
type Instrument = (typeof INSTRUMENTS)[number];
const PinBody = z.object({ instrument: z.enum(INSTRUMENTS).optional() }).strict();

export function registerPinRoutes(app: FastifyInstance, ctx: PotionContext): void {
  const db = ctx.db.db;

  /** One row per cluster the org can see: served, latest, and whether a pin
   * is holding a movement back. */
  app.get('/api/pins', async (req, reply) => {
    const org = req.potionOrg;
    if (!org) return reply.code(401).send(openAiError('authentication required', 'invalid_request_error', 'authentication_required'));
    const [clusterIds, clusterRows, pins] = await Promise.all([
      listServedClusterIds(db, org.orgId),
      listClusters(db, { orgId: org.orgId }),
      listFrontierPins(db, org.orgId),
    ]);
    const nameOf = new Map(clusterRows.map((c) => [c.id, c.name ?? c.id]));
    const pinByCluster = new Map(pins.filter((p) => p.instrument === 'default').map((p) => [p.clusterId, p]));
    const rows = [];
    for (const cid of clusterIds) {
      const c = { id: cid, name: nameOf.get(cid) ?? cid };
      const [served, latestOrg, latestPlatform] = await Promise.all([
        getServingFrontier(db, c.id, org.orgId),
        getLatestFrontier(db, c.id, org.orgId),
        getLatestFrontier(db, c.id, null),
      ]);
      // The newest thing that WOULD serve if nothing were pinned: an org
      // frontier outranks the platform chain, same rule as the serving read.
      const newest = latestOrg ?? latestPlatform;
      if (served === null && newest === null) continue;
      const pin = pinByCluster.get(c.id) ?? null;
      rows.push({
        clusterId: c.id,
        name: c.name,
        servedVersion: served?.version ?? null,
        servedFrontierId: served?.id ?? null,
        latestVersion: newest?.version ?? null,
        pinned: pin
          ? { frontierId: pin.frontierId, version: pin.frontierVersion, pinnedBy: pin.pinnedBy, pinnedAt: pin.createdAt.toISOString() }
          : null,
        /** A pin is HOLDING BACK a real movement (not merely present). */
        holdingBack: pin !== null && newest !== null && newest.version > pin.frontierVersion,
      });
    }
    return reply.send({ pins: rows });
  });

  app.put('/api/pins/:clusterId', { preHandler: [requireRole('admin')] }, async (req, reply) => {
    const org = req.potionOrg!;
    const { clusterId } = req.params as { clusterId: string };
    const parsed = PinBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send(openAiError(parsed.error.issues.map((i) => i.message).join('; '), 'invalid_request_error'));
    const instrument: Instrument = parsed.data.instrument ?? 'default';
    // Pin what is served RIGHT NOW — pinning a version the customer has
    // never been served would freeze a claim they never tested.
    const served = await getServingFrontier(db, clusterId, org.orgId, instrument);
    if (!served) {
      return reply
        .code(404)
        .send(openAiError(`no ${instrument} frontier serves cluster '${clusterId}' — nothing to pin`, 'invalid_request_error', 'not_found'));
    }
    const user = org.userId ? await getUserById(db, org.userId) : null;
    const pin = await setFrontierPin(db, {
      orgId: org.orgId,
      clusterId,
      instrument,
      frontierId: served.id,
      frontierVersion: served.version,
      pinnedBy: user?.email ?? `api key ${org.role}`,
    });
    return reply.send({
      pinned: { clusterId, instrument, frontierId: pin.frontierId, version: pin.frontierVersion, pinnedAt: pin.createdAt.toISOString() },
    });
  });

  app.delete('/api/pins/:clusterId', { preHandler: [requireRole('admin')] }, async (req, reply) => {
    const org = req.potionOrg!;
    const { clusterId } = req.params as { clusterId: string };
    const q = req.query as { instrument?: string };
    const instrument = (INSTRUMENTS as readonly string[]).includes(q.instrument ?? 'default')
      ? ((q.instrument ?? 'default') as Instrument)
      : 'default';
    const released = await releaseFrontierPin(db, org.orgId, clusterId, instrument);
    if (!released) {
      return reply.code(404).send(openAiError(`cluster '${clusterId}' is not pinned`, 'invalid_request_error', 'not_found'));
    }
    return reply.send({ released: true, clusterId, instrument });
  });

  /**
   * What moved, in the words diffFrontiers already writes for a buyer.
   *
   * Pinned clusters report what the pin is holding back (served → newest);
   * unpinned clusters report the movement that most recently changed what
   * they are served (parent → current), because "we improved it silently" is
   * exactly the thing a customer is entitled to read after the fact.
   */
  app.get('/api/frontier-changelog', async (req, reply) => {
    const org = req.potionOrg;
    if (!org) return reply.code(401).send(openAiError('authentication required', 'invalid_request_error', 'authentication_required'));
    const [clusterIds, clusterRows] = await Promise.all([
      listServedClusterIds(db, org.orgId),
      listClusters(db, { orgId: org.orgId }),
    ]);
    const nameOf = new Map(clusterRows.map((c) => [c.id, c.name ?? c.id]));
    const entries = [];
    for (const cid of clusterIds) {
      const c = { id: cid, name: nameOf.get(cid) ?? cid };
      const pin = await getFrontierPin(db, org.orgId, c.id);
      const served = await getServingFrontier(db, c.id, org.orgId);
      if (!served) continue;
      const latestOrg = await getLatestFrontier(db, c.id, org.orgId);
      const newest = latestOrg ?? (await getLatestFrontier(db, c.id, null));
      let from: Frontier | null = null;
      let to: Frontier | null = null;
      let kind: 'held-back' | 'applied' = 'applied';
      if (pin && newest && newest.version > pin.frontierVersion) {
        from = served;
        to = newest;
        kind = 'held-back';
      } else if (!pin && served.parentId) {
        const { getFrontierById } = await import('@potion/db');
        from = await getFrontierById(db, served.parentId);
        to = served;
      }
      if (!from || !to || from.id === to.id) continue;
      const diff = diffFrontiers(from, to);
      entries.push({
        clusterId: c.id,
        name: c.name,
        kind,
        fromVersion: from.version,
        toVersion: to.version,
        at: to.createdAt,
        narrative: diff.narrative,
        appeared: diff.appeared.length,
        vanished: diff.vanished.length,
      });
    }
    entries.sort((a, b) => String(b.at).localeCompare(String(a.at)));
    return reply.send({ entries });
  });
}
