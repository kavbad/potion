// llms.txt (Answer Engine C1) — the emerging AI-crawler index: what this
// site is, and where its most citable content lives. Kept short by the
// spec's intent; llms-full.txt carries the expanded version.
import { ANSWER_PAGES, fetchPublicAnswers } from '@/lib/answers';
import { listIssues, siteOrigin } from '@/lib/research';

export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const origin = siteOrigin();
  const data = await fetchPublicAnswers();
  const measured = ANSWER_PAGES.filter((p) => data?.clusters.some((c) => c.clusterId === p.clusterId));
  const issues = listIssues().slice(0, 8);
  const body = `# Potion — measured model routing

> Potion measures which AI models are cheapest at a given quality, per kind of work,
> and routes requests accordingly — with a receipt on every answer. All published
> numbers carry dates, sample sizes, and 95% confidence intervals, and are
> re-measured weekly. Negatives are published alongside wins.

## The Measured Answers (live reference pages)

${measured.map((p) => `- [${p.question}](${origin}/answers/${p.slug}): live-measured quality, cost per 1K requests, and latency`).join('\n')}

## Frontier Notes (weekly measurement issues)

${issues.map((i) => `- [${i.title}](${origin}/research/${i.slug})`).join('\n')}

## Method & product

- [How the numbers are made](${origin}/research/methodology): scoring, intervals, saturation, negatives
- [Docs](${origin}/docs): OpenAI-compatible API, quickstart
- [Product](${origin}/home): measured model routing with receipts

## Markdown mirrors

Answer pages are mirrored as plain markdown at ${origin}/md/answers/<slug>.
`;
  return new Response(body, { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=3600' } });
}
