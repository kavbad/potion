// PUBLIC measured-answers payload (Answer Engine C1, 2026-08-25):
//   GET /api/public/answers — the platform frontiers, shaped for the public
//   /answers pages (Frontier Notes' reference section). No session: the
//   /api/public/* prefix is auth-exempt (auth.ts).
//
// REDACTION IS THE POINT OF THIS FILE. Public SEO pages are the maximum
// blast radius surface, so:
//   · LIVE points only — SIMULATED numbers never masquerade as measurements
//     on a public page (a cluster with <2 live points is omitted entirely:
//     one point is not a comparison, and thin pages are noindexed upstream).
//   · Embargoed models (NEVER_NAME) and ALL combination strategies are
//     masked to a label; members, mechanisms, hashes, and evidence never
//     leave. What a combination achieves is public; how it works is not.
//   · Fail closed: the serialized payload is swept with findLeaks before it
//     is sent. A leak is a 500, never a partial response.
import type { FastifyInstance } from 'fastify';
import { loadTaxonomy } from '@potion/cluster';
import { loadCurrentFrontier } from '@potion/pareto';
import type { StrategyConfig } from '@potion/core';
import { sha256 } from '@potion/core';
import { findLeaks } from '@potion/workers';
import type { PotionContext } from '../context.js';

export interface PublicAnswerPoint {
  label: string;
  vendor: string | null;
  /** true = name withheld (embargoed model or combination strategy). */
  masked: boolean;
  kind: 'model' | 'combination';
  /** URL-stable model slug (C2): version-date suffixes stripped so a model
   * refresh never churns a comparison URL. null when masked. */
  slug: string | null;
  quality: number;
  costPer1K: number;
  latencyP95: number;
}

/** Per-model public pricing + everywhere it appears on a live frontier (C2). */
export interface PublicModelEntry {
  slug: string;
  label: string;
  vendor: string | null;
  inputPer1M: number;
  outputPer1M: number;
  appearances: Array<{ clusterId: string; clusterName: string; quality: number; costPer1K: number; latencyP95: number }>;
}

export interface PublicAnswerCluster {
  clusterId: string;
  name: string;
  version: number;
  measuredAt: string;
  points: PublicAnswerPoint[];
}

/** Stable public slug for a model display name: lowercase, dots→dashes,
 *  trailing version-date segments stripped ("gpt-4.1-mini-2025-04-14" →
 *  "gpt-4-1-mini"; "claude-haiku-4-5-20251001" → "claude-haiku-4-5"). */
export function modelSlug(label: string): string {
  return label
    .toLowerCase()
    .replace(/-20\d{2}-\d{2}-\d{2}$/, '')
    .replace(/-20\d{6}$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function hitsEmbargo(s: string): boolean {
  const low = s.toLowerCase();
  return findLeaks(low).length > 0;
}

/**
 * The price-table version, as the public is allowed to see it.
 *
 * WHY THIS EXISTS (2026-09-05 outage). Every other string in this payload is
 * either a masked label or a number; `pricesVersion` was the one field that
 * went out verbatim, unswept. The live registry's version had grown into a
 * list of 333 model aliases (see nextPricesVersion in @potion/pareto), one of
 * which `research:scan` had discovered as a sibling of the withheld winner.
 * The sweep at the end of this route did its job and refused the payload —
 * correctly — and this endpoint 500'd for every caller until the field
 * stopped carrying identities.
 *
 * WHAT CONSUMERS NEED from this field is identity, not inventory: "is this
 * the same catalog I saw last time?" — the daily note diffs exactly that. So
 * publish the readable head plus a digest of the WHOLE internal version. The
 * digest changes whenever the catalog changes, which preserves change
 * detection, and it reveals nothing.
 *
 * The head is the first two segments (the committed seed, e.g.
 * "2026-08-04-or2+tranche-2026-08-19") kept only for readability — and it is
 * swept before use, so a seed that ever carried an embargoed name is dropped
 * rather than published. Correctness never depends on that heuristic; the
 * digest alone is a complete identifier.
 */
export function publicPricesVersion(internal: string): string {
  const digest = sha256(internal).slice(0, 10);
  const head = internal.split('+').slice(0, 2).join('+');
  return head.length > 0 && !hitsEmbargo(head) ? `${head}+r${digest}` : `r${digest}`;
}

/** Public display for one frontier point — masked unless it is a plain,
 *  non-embargoed single model with a price-table identity. */
export function publicPointLabel(
  config: StrategyConfig,
  prices: { entries: Array<{ alias: string; model: string }> },
): Pick<PublicAnswerPoint, 'label' | 'vendor' | 'masked' | 'kind'> {
  if (config.type !== 'single') {
    return { label: 'Potion combination (composition withheld)', vendor: null, masked: true, kind: 'combination' };
  }
  const alias = config.model;
  const entry = prices.entries.find((e) => e.alias === alias || e.model === alias);
  const display = entry?.model ?? alias;
  if (hitsEmbargo(alias) || hitsEmbargo(display)) {
    return { label: "Potion's routed pick (name withheld)", vendor: null, masked: true, kind: 'model' };
  }
  // openrouter slugs are 'vendor/name'; provider-native models keep vendor null.
  const slash = display.indexOf('/');
  return slash > 0
    ? { label: display.slice(slash + 1), vendor: display.slice(0, slash), masked: false, kind: 'model' }
    : { label: display, vendor: null, masked: false, kind: 'model' };
}

export function registerPublicAnswersRoutes(app: FastifyInstance, ctx: PotionContext): void {
  app.get('/api/public/answers', async (_req, reply) => {
    const clusters: PublicAnswerCluster[] = [];
    for (const c of loadTaxonomy().clusters) {
      const frontier = await loadCurrentFrontier(ctx.db.db, c.id).catch(() => null);
      if (!frontier) continue;
      const live = frontier.points.filter((p) => p.providerMode === 'live');
      if (live.length < 2) continue;
      clusters.push({
        clusterId: c.id,
        name: c.name,
        version: frontier.version,
        measuredAt: frontier.createdAt,
        points: live
          .map((p) => {
            const named = publicPointLabel(p.strategyConfig as StrategyConfig, ctx.prices);
            return {
            ...named,
            slug: named.masked ? null : modelSlug(named.label),
            // Rounded for publication — full-precision floats serialize as
            // 16+ digit runs, which (a) claim precision the measurement does
            // not have and (b) trip the redaction sweep's hash pattern. The
            // sweep firing on raw floats is what caught this.
            quality: Math.round(p.quality * 10000) / 10000,
            costPer1K: Math.round(p.costPer1K * 1e6) / 1e6,
            latencyP95: Math.round(p.latencyP95),
            };
          })
          .sort((a, b) => a.costPer1K - b.costPer1K),
      });
    }
    // C2: the per-model view — every UNMASKED model on any included
    // frontier, with its list prices and everywhere it appears. Same embargo
    // rules; the sweep below covers this section too.
    const models = new Map<string, PublicModelEntry>();
    for (const c of clusters) {
      for (const pt of c.points) {
        if (pt.masked || pt.slug === null) continue;
        let entry = models.get(pt.slug);
        if (!entry) {
          const priced = ctx.prices.entries.find((e) => modelSlug(e.model) === pt.slug && !hitsEmbargo(e.alias) && !hitsEmbargo(e.model));
          if (!priced) continue;
          entry = { slug: pt.slug, label: pt.label, vendor: pt.vendor, inputPer1M: priced.inputPer1M, outputPer1M: priced.outputPer1M, appearances: [] };
          models.set(pt.slug, entry);
        }
        entry.appearances.push({ clusterId: c.clusterId, clusterName: c.name, quality: pt.quality, costPer1K: pt.costPer1K, latencyP95: pt.latencyP95 });
      }
    }
    const payload = {
      clusters,
      models: [...models.values()].sort((a, b) => a.slug.localeCompare(b.slug)),
      // NEVER ctx.prices.version raw — see publicPricesVersion above.
      pricesVersion: publicPricesVersion(ctx.prices.version),
      generatedAt: new Date().toISOString(),
    };
    // The belt: nothing embargoed leaves this route, or nothing leaves at all.
    const leaks = findLeaks(JSON.stringify(payload));
    if (leaks.length > 0) {
      // Private log carries the WHY so the refusal is diagnosable; the
      // response stays a bare 500 — fail closed, explain nothing publicly.
      app.log.error(
        { leaks: leaks.slice(0, 6).map((l) => ({ kind: l.kind, why: l.why, offset: l.offset })) },
        'public-answers: payload failed the redaction sweep',
      );
      reply.code(500);
      return reply.send({ error: { message: 'public payload failed the redaction sweep', type: 'server_error' } });
    }
    reply.header('cache-control', 'public, max-age=300, s-maxage=900');
    return reply.send(payload);
  });
}
