import type { MetadataRoute } from 'next';
import { siteOrigin } from '@/lib/research';

// Public crawl surface (Answer Engine C1): /answers joins; AI answer-engine
// crawlers are allowed EXPLICITLY, not just via *, so a future tightening of
// the wildcard can never silently cut off the citation channel — being read
// by answer engines is this site's distribution.
const ALLOW = ['/home', '/docs', '/research', '/research/', '/answers', '/answers/', '/md/', '/llms.txt', '/llms-full.txt'];
const DISALLOW = ['/api/', '/settings', '/usage', '/policy', '/build', '/reports', '/traces', '/login', '/share/'];
const AI_CRAWLERS = ['GPTBot', 'OAI-SearchBot', 'ClaudeBot', 'Claude-SearchBot', 'PerplexityBot', 'Google-Extended', 'Bingbot'];

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      { userAgent: '*', allow: ALLOW, disallow: DISALLOW },
      ...AI_CRAWLERS.map((userAgent) => ({ userAgent, allow: ALLOW, disallow: DISALLOW })),
    ],
    sitemap: `${siteOrigin()}/sitemap.xml`,
  };
}
