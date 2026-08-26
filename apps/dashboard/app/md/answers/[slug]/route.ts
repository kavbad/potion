// Markdown mirror of one measured-answer page (Answer Engine C1): the same
// data the HTML page renders, as clean text/markdown for retrieval
// pipelines. Content parity with /answers/[slug] is the contract — both
// render from the same fetch + the same hand-written dict.
import { answerPageBySlug, fetchPublicAnswers, verdictFor } from '@/lib/answers';
import { siteOrigin } from '@/lib/research';

export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }): Promise<Response> {
  const { slug } = await params;
  const page = answerPageBySlug(slug);
  const data = page ? await fetchPublicAnswers() : null;
  const cluster = data?.clusters.find((c) => c.clusterId === page?.clusterId) ?? null;
  if (!page || !cluster) return new Response('not measured yet\n', { status: 404, headers: { 'content-type': 'text/plain' } });
  const origin = siteOrigin();
  const money = (n: number) => `$${n.toFixed(n < 1 ? 4 : 2)}`;
  const body = `# ${page.question}

${verdictFor(cluster)}

${page.intro}

## The measured frontier (v${cluster.version}, measured ${cluster.measuredAt.slice(0, 10)})

| option | vendor | measured quality | $ / 1K requests | p95 latency |
|---|---|---:|---:|---:|
${cluster.points.map((p) => `| ${p.label} | ${p.vendor ?? '—'} | ${p.quality.toFixed(3)} | ${money(p.costPer1K)} | ${Math.round(p.latencyP95)} ms |`).join('\n')}

Live provider measurements only; names that are part of the product are withheld, their numbers are not.

${page.faqs.map((f) => `## ${f.q}\n\n${f.a}`).join('\n\n')}

---
Method: ${origin}/research/methodology · HTML: ${origin}/answers/${page.slug} · Frontier Notes: ${origin}/research
`;
  return new Response(body, { headers: { 'content-type': 'text/markdown; charset=utf-8', 'cache-control': 'public, max-age=900' } });
}
