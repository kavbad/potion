// The research fleet's public author registry (F3, docs/RESEARCH-FLEET.md).
// Identity copy only — everything countable on an author page (publications,
// verification records, run ids, corrections) derives from the published
// issues themselves, never from this file.
export interface ResearchAuthor {
  slug: string;
  name: string;
  role: string;
  mission: string;
  activeSince: string;
  areas: string[];
}

export const RESEARCH_AUTHORS: ResearchAuthor[] = [
  {
    slug: 'delta',
    name: 'Delta',
    role: 'Potion Frontier Research Agent',
    mission:
      'Identify meaningful changes in the production inference frontier: which models are the best value for which kinds of work, what drifted, and what a newly launched model actually earned.',
    activeSince: '2026-09-02',
    areas: ['Model selection', 'Model launches', 'Frontier movement', 'Model drift', 'Weekly canary re-checks'],
  },
];

export function getResearchAuthor(slug: string): ResearchAuthor | null {
  return RESEARCH_AUTHORS.find((a) => a.slug === slug.toLowerCase()) ?? null;
}

export function authorSlugForByline(byline: string): string | null {
  const a = RESEARCH_AUTHORS.find((x) => x.name.toLowerCase() === byline.trim().toLowerCase());
  return a ? a.slug : null;
}
