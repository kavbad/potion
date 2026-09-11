// Frontier Notes — read issues from the notes directory (docs/FRONTIER-NOTES.md).
// Production mounts /opt/potion/research/notes read-only at /research/notes;
// locally FRONTIER_NOTES_DIR points wherever the weekly script wrote. Only
// published issues are served; held issues are invisible here by design.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface IssueFaq { q: string; a: string }
/**
 * A published claim that was wrong, and what replaced it.
 *
 * The author page has always promised readers that "every correction will be
 * listed here, permanently" — and that sentence was hardcoded next to no data,
 * so it would have gone on saying "no corrections on record" through any
 * number of them. The first real correction (2026-09-10, an item count
 * published as a model count) is what turned a decorative promise into a
 * false one. This is the field that backs it.
 */
export interface IssueCorrection {
  /** ISO instant the correction was made — not when the error was published. */
  at: string;
  was: string;
  now: string;
  /** Why it happened, in the author's own accounting. */
  why?: string;
}
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
  /** 'daily' = a short event note (C3): body paragraphs, no FactSheet. */
  kind?: 'weekly' | 'daily';
  body?: string;
  agenda?: { id: string; kind: string; clusterId: string; demandQuery: string; score: number; claimKey?: string };
  plain: string; lede: string; frontierNote: string; auditionNote: string; mixingNote: string; takeaway: string; method: string;
  faq: IssueFaq[]; facts: FactSheet | null; status: 'published' | 'held'; heldReason?: string;
  writer: { model: string; costUsd: number; receipt?: { cluster: string; strategy8: string; policy: string; provenance: string; promptTokens: number; completionTokens: number }; runId?: string; verifiedBy?: { runId: string; costUsd: number } } | null;
  publishGate?: { decision: 'allow' | 'hold' | 'blocked'; audit?: boolean; runId: string; actionId: string; argsHash: string; priorResolution?: boolean };
  /** Corrections to this issue, oldest first. Absent = none, which is a
   *  different fact from an empty array and is rendered the same way. */
  corrections?: IssueCorrection[];
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
/** THE PUBLIC ORIGIN — where the site IS, which is not where the app is
 *  DEPLOYED. This used to read POTION_APP_URL, and on the production box that
 *  is `https://app.withpotion.com`, deliberately: the Google OAuth redirect
 *  URI derives from it and must match what is registered at Google (see
 *  apps/server/src/oidc.ts and boot-report.ts). So every canonical, every
 *  sitemap <loc>, the RSS feed and llms.txt were advertising a host that
 *  301s to withpotion.com — a sitemap of redirects, and split authority.
 *
 *  Retiring POTION_APP_URL here rather than repointing it: repointing would
 *  have fixed the sitemap and broken sign-in. Override with POTION_PUBLIC_URL
 *  where the public host genuinely differs (a staging domain). */
export function siteOrigin(): string {
  return (process.env.POTION_PUBLIC_URL ?? 'https://withpotion.com').replace(/\/$/, '');
}

/**
 * Every correction on an author's published issues, newest first.
 *
 * Derived, like every other countable on an author page: an author cannot
 * have a clean record because nobody wrote a correction down, only because
 * the corpus holds none.
 */
export function correctionsForByline(byline: string): Array<IssueCorrection & { slug: string; title: string }> {
  const name = byline.trim().toLowerCase();
  return listIssues()
    .filter((i) => i.byline.trim().toLowerCase() === name)
    .flatMap((i) => (i.corrections ?? []).map((c) => ({ ...c, slug: i.slug, title: i.title })))
    .sort((a, b) => (a.at < b.at ? 1 : -1));
}
