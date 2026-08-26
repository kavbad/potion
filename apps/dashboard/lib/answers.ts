// The measured answers (Answer Engine C1, 2026-08-25) — Frontier Notes'
// reference section. Data comes from GET /api/public/answers (live-only,
// redaction-swept server-side); everything hand-written lives HERE, because
// the 2026 scaled-content rule is explicit: programmatic pages survive on
// unique structured data PLUS human framing. One intro and three durable
// FAQs per workload, written once, never number-specific (numbers regenerate
// from measurements; prose must stay true across regenerations).

export interface PublicAnswerPoint {
  label: string;
  vendor: string | null;
  masked: boolean;
  kind: 'model' | 'combination';
  quality: number;
  costPer1K: number;
  latencyP95: number;
}
export interface PublicAnswerCluster {
  clusterId: string;
  name: string;
  version: number;
  measuredAt: string;
  points: PublicAnswerPoint[];
}
export interface PublicAnswers {
  clusters: PublicAnswerCluster[];
  pricesVersion: string;
  generatedAt: string;
}

const API = process.env.POTION_API_URL ?? 'http://localhost:3000';

export async function fetchPublicAnswers(): Promise<PublicAnswers | null> {
  try {
    const res = await fetch(`${API}/api/public/answers`, { next: { revalidate: 300 } });
    if (!res.ok) return null;
    return (await res.json()) as PublicAnswers;
  } catch {
    return null;
  }
}

export interface AnswerPageContent {
  /** SEO slug (the URL) — question-shaped, stable forever. */
  slug: string;
  clusterId: string;
  /** The H1, phrased as the question people actually ask. */
  question: string;
  short: string;
  /** Hand-written intro — what this workload is, why model choice matters here. */
  intro: string;
  faqs: Array<{ q: string; a: string }>;
}

export const ANSWER_PAGES: AnswerPageContent[] = [
  {
    slug: 'classification',
    clusterId: 'classification',
    question: 'What is the best model for text classification?',
    short: 'classification',
    intro:
      'Classification — routing tickets, labeling intents, applying rules to text — is the workload where model choice matters most and is judged least. The task has a right answer, so quality is measurable exactly, and the measured gap between the cheapest adequate model and a frontier model is routinely the widest of any workload. Paying frontier prices here is the most common form of silent AI overspend.',
    faqs: [
      { q: 'Do I need a frontier model for classification?', a: 'Usually not. On measured classification suites, small models regularly match frontier models within the confidence interval. The honest answer depends on your label set and edge cases — which is why these numbers are re-measured weekly rather than asserted once.' },
      { q: 'How is classification quality measured here?', a: 'Deterministically: each suite item has a known correct label, and a model scores by exact agreement — no LLM judge anywhere in the loop. Scores carry sample sizes and 95% intervals.' },
      { q: 'What if my labels are domain-specific?', a: 'Generic benchmarks are a prior, not a verdict. Potion measures consenting customers’ own traffic during a learning period and re-verifies the pick on their labels before it guarantees anything.' },
    ],
  },
  {
    slug: 'data-extraction',
    clusterId: 'extraction',
    question: 'What is the best model for data extraction?',
    short: 'extraction',
    intro:
      'Extraction — pulling fields out of documents, emails, and records into structured JSON — is scored field-by-field against known references, so the numbers below are deterministic, not judged. It is also the workload where reference-free LLM judging fails measurably (judges cannot see omissions), which is why extraction claims anywhere should be treated with suspicion unless the scoring method is stated.',
    faqs: [
      { q: 'How is extraction quality measured?', a: 'Field-match against a known reference: every extracted field either matches or it does not, with fractional credit per document. No judge model is involved; a missing field cannot hide.' },
      { q: 'Can a small model really do production extraction?', a: 'On measured suites, the gap between the best cheap model and the best frontier model is often inside the confidence interval. Real documents are messier than any suite — which is why the measured answer is a starting point and customer-traffic verification is the finish line.' },
      { q: 'What about PDFs, scans, and images?', a: 'Vision extraction is measured separately, on rendered documents. The frontier below is text extraction; vision numbers appear in the weekly issues as they are re-measured.' },
    ],
  },
  {
    slug: 'code-generation',
    clusterId: 'code-gen',
    question: 'What is the best model for code generation?',
    short: 'code generation',
    intro:
      'Code generation is the easiest workload to measure honestly — generated code either passes executable tests or it does not — and the hardest to generalize about, because "coding" spans one-shot functions to repository-scale agents. The frontier below is measured by executing every answer against held-out test suites: fractional credit per test, no judge, references gated on passing their own tests.',
    faqs: [
      { q: 'How is code quality scored?', a: 'By execution: generated code runs in a sandbox against multiple tests per item, with fractional credit. A plausible-looking answer that fails its tests scores what it earned.' },
      { q: 'Does the ranking hold for large codebases and agents?', a: 'Not automatically. These suites measure self-contained generation; repository-scale and multi-step work are measured separately (see the journey suite in the methodology). A model can excel here and lag there.' },
      { q: 'Why do saturated scores get flagged?', a: 'When multiple models ace a suite repeatedly, the suite has stopped discriminating — a saturation alarm triggers hardening rather than letting a perfect score masquerade as proof of superiority. A 42/42 is reported as a lower bound, not certainty.' },
    ],
  },
  {
    slug: 'code-review',
    clusterId: 'code-review',
    question: 'What is the best model for code review?',
    short: 'code review',
    intro:
      'Code review asks a model to find what is wrong with working-looking code — a fundamentally harder measurement problem than generation, because a review is only as good as the defects it catches. The measured suite scores reviews against known injected defects with executable checks wherever the fix can be run.',
    faqs: [
      { q: 'How is review quality measured?', a: 'Against known defects: items carry deliberately introduced bugs, and a review scores on whether the correction actually repairs them — executed where possible, never style-judged.' },
      { q: 'Is the cheapest reviewer good enough for CI?', a: 'The measured gap on this workload is narrower than on classification — read the interval, not just the point. For gating merges, the honest configuration is a quality floor set from your own traffic, not a benchmark number.' },
      { q: 'Can review be combined with generation?', a: 'Potion measured multi-model combinations extensively and published the negative: for measured task shapes at current prices, combinations are dominated by the best single model. The write-up is in the research archive.' },
    ],
  },
  {
    slug: 'summarization',
    clusterId: 'summarization',
    question: 'What is the best model for summarization?',
    short: 'summarization',
    intro:
      'Summarization quality is subjective at the margins, which makes it exactly the workload where judge-based scores need calibration receipts. The measured suite anchors judging against references and calibrates judges against tasks with deterministic truth, publishing the correlation rather than asking for trust.',
    faqs: [
      { q: 'Can summarization quality be measured at all?', a: 'Yes, carefully: reference-anchored judging (the judge sees a reference summary) calibrates near-perfectly against deterministic truth; reference-free judging does not, and is not used for these numbers.' },
      { q: 'Do I need a frontier model to summarize?', a: 'For routine document and thread summarization, measured mid-tier models are frequently within the interval of frontier ones. Long, dense, or high-stakes material shifts the answer — measure on your own traffic before trusting anyone’s general number.' },
      { q: 'What matters more, model or prompt?', a: 'Both, but the frontier is measured with each model given the same instruction under the same scoring — the ranking isolates the model. Your prompt can move absolute quality; it rarely reorders a wide measured gap.' },
    ],
  },
  {
    slug: 'rewriting',
    clusterId: 'rewrite-edit',
    question: 'What is the best model for rewriting and editing text?',
    short: 'rewriting and editing',
    intro:
      'Rewrite-and-edit work — tone changes, tightening, constraint-preserving edits — punishes models that "improve" text by discarding requirements. The measured suite scores whether stated constraints survive the edit, which is where cheap and expensive models genuinely separate.',
    faqs: [
      { q: 'What does quality mean for a rewrite?', a: 'Constraint survival: the edit is scored on preserving required facts, references, and instructions while making the requested change — checked against the item’s stated requirements.' },
      { q: 'Why do models fail rewrites?', a: 'The measured failure mode is silent constraint-dropping: the output reads better and quietly loses a requirement. This also erodes across multi-step pipelines, which is why journeys are measured end-to-end separately.' },
      { q: 'Is this the same as creative writing?', a: 'No — creative work is measured on its own suite with judge calibration. Rewriting is closer to extraction: there is a checkable contract.' },
    ],
  },
  {
    slug: 'rag-answers',
    clusterId: 'rag-answer',
    question: 'What is the best model for RAG answers?',
    short: 'RAG answering',
    intro:
      'In retrieval-augmented answering, the model’s job narrows to faithful synthesis over supplied context — a different skill from open-ended knowledge, and one where paying for a frontier model’s world knowledge is often paying twice. The measured suite scores answers against references derived from the supplied documents.',
    faqs: [
      { q: 'Does a bigger model help when the context contains the answer?', a: 'Less than expected: the measured gap narrows sharply when answers must come from supplied context. Faithfulness, not knowledge, dominates — and is measurable.' },
      { q: 'How is faithfulness measured?', a: 'Against document-derived references: an answer scores on agreement with what the supplied context supports, so a fluent hallucination scores as the miss it is.' },
      { q: 'Should retrieval and answering use the same model?', a: 'They are different workloads; route them separately. Embedding and answering frontiers are measured independently.' },
    ],
  },
  {
    slug: 'reasoning',
    clusterId: 'multi-step-reasoning',
    question: 'When do you need a reasoning model?',
    short: 'multi-step reasoning',
    intro:
      'Multi-step reasoning is the workload frontier pricing was built on — and the one where the "do I need it" question has a measurable answer. The suite scores multi-step problems with deterministic ends, so a model’s reasoning is graded on reaching the right result, not on showing appealing work.',
    faqs: [
      { q: 'When is a reasoning model worth it?', a: 'When the measured gap on your problem class exceeds the interval — which happens on genuinely multi-step, error-compounding work, and largely does not on retrieval, extraction, or classification dressed up as reasoning.' },
      { q: 'How is reasoning scored without a judge?', a: 'By final-answer correctness on problems with known results, plus journey-grain suites where each step feeds the next and only the end artifact is scored.' },
      { q: 'Do reasoning tokens change the cost math?', a: 'Substantially — reasoning models spend hidden tokens, so their cost per request is measured from real usage, not list price per token. The frontier below prices what requests actually cost.' },
    ],
  },
  {
    slug: 'creative-writing',
    clusterId: 'creative',
    question: 'What is the best model for creative writing?',
    short: 'creative writing',
    intro:
      'Creative work is where measurement is hardest and overclaiming easiest. These numbers come from judge-scored suites whose judges are themselves calibrated against tasks with deterministic truth — and the calibration results are published, including the failures.',
    faqs: [
      { q: 'Can creative quality be measured honestly?', a: 'Within limits, and the limits are stated: calibrated judges, rubric-hashed scoring, intervals on every number. Where judging is unreliable, the methodology says so rather than shipping a confident number.' },
      { q: 'Why does the ranking differ from vibes online?', a: 'Public sentiment measures memorable peaks; suites measure consistency across many briefs under one rubric. Both are real; only one has intervals.' },
      { q: 'Should chat products route creative work separately?', a: 'Yes — it is one of the clearest cases for per-workload routing, since the best creative model is rarely the best extraction or classification model, and is rarely priced like them.' },
    ],
  },
  {
    slug: 'tool-use',
    clusterId: 'agentic-tool-use',
    question: 'What is the best model for tool calling?',
    short: 'tool calling',
    intro:
      'Agent stacks live or die on tool calls: the right function, the right arguments, the discipline not to invent either. The measured suite scores tool-call validity deterministically. Whole-journey agent completion — plan, call, read, recover — is measured separately, because call-level scores can all look healthy while the journey fails.',
    faqs: [
      { q: 'How is tool calling measured?', a: 'Deterministically: full credit for the expected tool with the expected arguments, partial for the right tool misconfigured, zero for prose or a wrong tool. No judge.' },
      { q: 'Is the best chat model also the best agent model?', a: 'Measurably not always — function-calling reliability separates from prose quality, which is why agents deserve a routed pick rather than inheriting the chat default.' },
      { q: 'What about the whole agent journey?', a: 'End-to-end journeys (multi-step, output feeding the next step, only the final artifact scored) are a separate instrument — the methodology page describes it, and journey results appear in the weekly issues.' },
    ],
  },
];

export function answerPageBySlug(slug: string): AnswerPageContent | null {
  return ANSWER_PAGES.find((p) => p.slug === slug) ?? null;
}

export function answerPageByCluster(clusterId: string): AnswerPageContent | null {
  return ANSWER_PAGES.find((p) => p.clusterId === clusterId) ?? null;
}

/** The generated, dated, extractable verdict — the sentence an engine can lift. */
export function verdictFor(c: PublicAnswerCluster): string {
  const points = c.points;
  const top = points.reduce((m, p) => Math.max(m, p.quality), 0);
  const qualifying = points.filter((p) => p.quality >= top * 0.9);
  const cheapest = qualifying.reduce((b, p) => (p.costPer1K < b.costPer1K ? p : b), qualifying[0]!);
  const priciest = points.reduce((b, p) => (p.costPer1K > b.costPer1K ? p : b), points[0]!);
  const date = new Date(c.measuredAt).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const spread = cheapest.costPer1K > 0 ? priciest.costPer1K / cheapest.costPer1K : null;
  const who = cheapest.masked ? "Potion's routed pick (name withheld)" : cheapest.label;
  return (
    `As of ${date}, the cheapest live-measured option within 90% of top quality on ${c.name.toLowerCase()} is ` +
    `${who} at $${cheapest.costPer1K.toFixed(cheapest.costPer1K < 1 ? 4 : 2)} per 1,000 requests — ` +
    `${cheapest.quality.toFixed(3)} measured quality vs ${top.toFixed(3)} at the top` +
    (spread && spread >= 2 ? `, with a ${spread.toFixed(0)}× price spread across the measured frontier` : '') +
    ` (frontier v${c.version}).`
  );
}
