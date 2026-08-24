import type { MetadataRoute } from 'next';
import { listIssues, siteOrigin } from '@/lib/research';

export const dynamic = 'force-dynamic';

export default function sitemap(): MetadataRoute.Sitemap {
  const origin = siteOrigin();
  const issues = listIssues();
  return [
    { url: `${origin}/home`, changeFrequency: 'weekly', priority: 1 },
    { url: `${origin}/docs`, changeFrequency: 'monthly', priority: 0.7 },
    { url: `${origin}/terms`, changeFrequency: 'yearly', priority: 0.3 },
    { url: `${origin}/privacy`, changeFrequency: 'yearly', priority: 0.3 },
    { url: `${origin}/status`, changeFrequency: 'always' as const, priority: 0.4 },
    { url: `${origin}/research`, changeFrequency: 'weekly', priority: 0.9, lastModified: issues[0]?.publishedAt },
    ...issues.map((i) => ({ url: `${origin}/research/${i.slug}`, lastModified: i.publishedAt, changeFrequency: 'never' as const, priority: 0.8 })),
  ];
}
