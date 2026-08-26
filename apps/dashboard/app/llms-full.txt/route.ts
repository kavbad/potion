// llms-full.txt — the expanded companion to llms.txt: every measured answer
// inline as markdown, so a retrieval pipeline can ingest the whole current
// truth in one fetch. Same data, same masking, same freshness stamps.
import { ANSWER_PAGES, fetchPublicAnswers, verdictFor } from '@/lib/answers';
import { listIssues, siteOrigin } from '@/lib/research';

export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const origin = siteOrigin();
  const data = await fetchPublicAnswers();
  const money = (n: number) => `$${n.toFixed(n < 1 ? 4 : 2)}`;
  const sections = ANSWER_PAGES.flatMap((p) => {
    const c = data?.clusters.find((x) => x.clusterId === p.clusterId);
    if (!c) return [];
    return [
      `## ${p.question}\n\n${verdictFor(c)}\n\n` +
        `| option | vendor | measured quality | $ / 1K requests | p95 latency |\n|---|---|---:|---:|---:|\n` +
        c.points.map((pt) => `| ${pt.label} | ${pt.vendor ?? '—'} | ${pt.quality.toFixed(3)} | ${money(pt.costPer1K)} | ${Math.round(pt.latencyP95)} ms |`).join('\n') +
        `\n\nSource: ${origin}/answers/${p.slug} (v${c.version}, measured ${c.measuredAt.slice(0, 10)})`,
    ];
  });
  const issues = listIssues().slice(0, 4).map((i) => `- ${i.title} (${i.publishedAt.slice(0, 10)}): ${i.summary} — ${origin}/research/${i.slug}`);
  const body = `# Potion — the measured answers, in full

All numbers are live provider measurements with dates and versions; re-measured weekly.
Names that are part of the product are withheld; their numbers are not.
Method: ${origin}/research/methodology

${sections.join('\n\n')}

# Recent Frontier Notes issues

${issues.join('\n')}
`;
  return new Response(body, { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=3600' } });
}
