import type { MetadataRoute } from 'next';
import { ANSWER_PAGES, fetchPublicAnswers } from '@/lib/answers';
import { listIssues, siteOrigin } from '@/lib/research';

export const dynamic = 'force-dynamic';

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const origin = siteOrigin();
  const issues = listIssues();
  // Answers pages carry lastModified from their MEASUREMENT date — honest
  // freshness, never fake-fresh (Answer Engine C1).
  const answers = await fetchPublicAnswers();
  const measured = ANSWER_PAGES.flatMap((p) => {
    const c = answers?.clusters.find((x) => x.clusterId === p.clusterId);
    return c ? [{ url: `${origin}/answers/${p.slug}`, lastModified: c.measuredAt, changeFrequency: 'weekly' as const, priority: 0.9 }] : [];
  });
  return [
    { url: `${origin}/home`, changeFrequency: 'weekly', priority: 1 },
    { url: `${origin}/docs`, changeFrequency: 'monthly', priority: 0.7 },
    { url: `${origin}/terms`, changeFrequency: 'yearly', priority: 0.3 },
    { url: `${origin}/privacy`, changeFrequency: 'yearly', priority: 0.3 },
    { url: `${origin}/status`, changeFrequency: 'always' as const, priority: 0.4 },
    { url: `${origin}/research`, changeFrequency: 'weekly', priority: 0.9, lastModified: issues[0]?.publishedAt },
    { url: `${origin}/research/methodology`, changeFrequency: 'monthly', priority: 0.8 },
    ...(measured.length > 0 ? [{ url: `${origin}/answers`, changeFrequency: 'weekly' as const, priority: 0.9, lastModified: answers?.generatedAt }] : []),
    ...measured,
    ...issues.map((i) => ({ url: `${origin}/research/${i.slug}`, lastModified: i.publishedAt, changeFrequency: 'never' as const, priority: 0.8 })),
  ];
}
