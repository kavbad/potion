import type { MetadataRoute } from 'next';
import { siteOrigin } from '@/lib/research';

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: '*', allow: ['/home', '/docs', '/research', '/research/'], disallow: ['/api/', '/settings', '/usage', '/policy', '/build', '/reports', '/traces', '/login', '/share/'] }],
    sitemap: `${siteOrigin()}/sitemap.xml`,
  };
}
