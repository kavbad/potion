// The CTA registry (docs/RESEARCH-WRITING.md E7): every research CTA
// resolves to a surface that is LIVE — Scribe/authors never invent a
// target, and a dead flow never gets a link. Add an entry only after
// driving the surface.
export interface ResearchCta {
  /** The reader question this CTA answers. */
  question: string;
  label: string;
  href: string;
}

export const RESEARCH_CTAS: Record<string, ResearchCta> = {
  'workload-test': {
    question: 'What does this look like on my workload?',
    label: 'Measure this on your workload →',
    href: '/try',
  },
  docs: {
    question: 'How does routing between measured models work?',
    label: 'Read how routing works →',
    href: '/docs',
  },
};

/** The default CTA for a weekly Frontier Notes issue. */
export const DEFAULT_ISSUE_CTA = RESEARCH_CTAS['workload-test']!;
