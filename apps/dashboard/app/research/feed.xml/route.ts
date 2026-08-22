import { listIssues, RESEARCH_TAGLINE, RESEARCH_TITLE, siteOrigin } from '@/lib/research';

export const dynamic = 'force-dynamic';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export async function GET() {
  const origin = siteOrigin();
  const items = listIssues()
    .map(
      (i) => `<item><title>${esc(i.title)}</title><link>${origin}/research/${i.slug}</link><guid isPermaLink="true">${origin}/research/${i.slug}</guid><pubDate>${new Date(i.publishedAt).toUTCString()}</pubDate><description>${esc(i.summary)}</description></item>`,
    )
    .join('');
  const xml = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>${esc(RESEARCH_TITLE)}</title><link>${origin}/research</link><description>${esc(RESEARCH_TAGLINE)}</description><language>en</language>${items}</channel></rss>`;
  return new Response(xml, { headers: { 'content-type': 'application/rss+xml; charset=utf-8', 'cache-control': 'public, max-age=600' } });
}
