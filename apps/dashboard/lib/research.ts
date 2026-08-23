// Frontier Notes — read issues from the notes directory (docs/FRONTIER-NOTES.md).
// Production mounts /opt/potion/research/notes read-only at /research/notes;
// locally FRONTIER_NOTES_DIR points wherever the weekly script wrote. Only
// published issues are served; held issues are invisible here by design.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface IssueFaq { q: string; a: string }
export interface ClusterFact { clusterId: string; family: string; pick: string; storedQuality: number; storedCi95: number; observedMean: number | null; n: number; verdict: 'ok' | 'drift' | 'inconclusive' }
export interface AuditionFact { alias: string; clusterId: string; lane: string; outcome: string }
export interface MixingFact { clusterId?: string; family: string; kind: string; meanQuality: number; qualityDeltaVsBestSingle: number; costSaving: number; n: number; vague: boolean; costBand: string }
export interface FactSheet {
  week: string; at: string; frontier: ClusterFact[]; auditions: AuditionFact[]; mixing: MixingFact[];
  numbers: { canaries: number; clustersHeld: number; clustersMoved: number; inconclusive: number; itemsGraded: number; candidatesScreened: number; candidatesMeasured: number; spendUsd: number };
  caveats: string[];
}
/** Mirrors packages/workers/src/frontier-notes/types.ts Issue — kept local so the dashboard never bundles workers. */
export interface Issue {
  slug: string; week: string; title: string; summary: string; publishedAt: string; byline: string;
  plain: string; lede: string; frontierNote: string; auditionNote: string; mixingNote: string; takeaway: string; method: string;
  faq: IssueFaq[]; facts: FactSheet; status: 'published' | 'held'; heldReason?: string;
  writer: { model: string; costUsd: number; receipt?: { cluster: string; strategy8: string; policy: string; provenance: string; promptTokens: number; completionTokens: number } } | null;
}

function dirs(): string[] {
  const env = process.env.FRONTIER_NOTES_DIR;
  const list = env ? env.split(':') : ['/research/notes'];
  return list.filter((d) => d && existsSync(d));
}

export function listIssues(): Issue[] {
  const out: Issue[] = [];
  const seen = new Set<string>();
  for (const dir of dirs()) {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const issue = JSON.parse(readFileSync(join(dir, f), 'utf8')) as Issue;
        if (issue.status !== 'published' || seen.has(issue.week)) continue;
        seen.add(issue.week);
        out.push(issue);
      } catch {
        /* a half-written file is not an issue */
      }
    }
  }
  return out.sort((a, b) => (a.week < b.week ? 1 : -1));
}

export function getIssue(slug: string): Issue | null {
  const issues = listIssues();
  // exact first; then by week prefix, so every address an issue has ever
  // had (the old title-derived slugs) still resolves to it
  return issues.find((i) => i.slug === slug) ?? issues.find((i) => slug.toLowerCase().startsWith(i.week.toLowerCase())) ?? null;
}

export const RESEARCH_TITLE = 'Frontier Notes';
export const RESEARCH_TAGLINE = 'Weekly measurements of which AI models are cheapest at a given quality, and what routing between them saves.';
export function siteOrigin(): string {
  return (process.env.POTION_APP_URL ?? 'https://app.withpotion.com').replace(/\/$/, '');
}
