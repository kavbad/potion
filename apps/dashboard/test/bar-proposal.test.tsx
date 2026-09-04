// The bar proposal (S3): the learning period's output as a one-click moment.
// House idiom: SSR markup over injected state (effects skip on injection);
// the apply endpoint itself is covered by the server suite.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BarProposal } from '@/components/bar-proposal';

const PROPOSAL = {
  id: 'prop-1', clusterId: 'code-gen',
  incumbentModel: 'or-gpt-full', incumbentQuality: 0.94, incumbentCostPer1K: 8.05,
  servingModel: 'or-gpt-mini', servingQuality: 0.95, servingCostPer1K: 0.34,
  // The REAL wire shape: retention is the bootstrap verdict OBJECT. The
  // fixture was a bare number until 2026-08-25 — the fixture lie that let
  // `.toFixed` on an object crash the operator's Today in prod.
  retention: { mean: 1.01, ci95: [0.97, 1.05] as [number, number] }, suggestedFloor: 0.94, projectedSaving: 7.71, items: 40,
  status: 'proposed', appliedAt: null,
};

describe('BarProposal', () => {
  it('renders nothing without an open proposal', () => {
    expect(renderToStaticMarkup(<BarProposal initialProposals={[]} initialAdmin />)).toBe('');
  });

  it('surfaces the measured numbers and the one-click accept for admins', () => {
    const html = renderToStaticMarkup(<BarProposal initialProposals={[PROPOSAL]} initialAdmin />);
    expect(html).toContain('bar proposal · code-gen');
    expect(html).toContain('0.94 on your own work');
    expect(html).toContain('never below 0.94');
    expect(html).toContain('$0.3400/1k instead of $8.05');
    expect(html).toContain('Accept the bar');
    expect(html).toContain('40 samples');
  });

  it('a non-admin sees the proposal but not the button', () => {
    const html = renderToStaticMarkup(<BarProposal initialProposals={[PROPOSAL]} initialAdmin={false} />);
    expect(html).toContain('bar proposal');
    expect(html).not.toContain('Accept the bar');
    expect(html).toContain('An admin can accept this');
  });
});

describe('retention shapes (the 2026-08-25 prod crash class)', () => {
  it('renders the OBJECT retention verdict with its CI — never .toFixed on an object', () => {
    const html = renderToStaticMarkup(
      <BarProposal initialProposals={[PROPOSAL]} initialAdmin={true} />,
    );
    expect(html).toContain('1.01');
    expect(html).toContain('95% CI 0.97');
  });
  it('tolerates a bare-number retention (legacy) and a null retention', () => {
    const num = { ...PROPOSAL, id: 'p2', retention: 1.02 };
    expect(renderToStaticMarkup(<BarProposal initialProposals={[num]} initialAdmin={true} />)).toContain('1.02');
    const none = { ...PROPOSAL, id: 'p3', retention: null };
    expect(() => renderToStaticMarkup(<BarProposal initialProposals={[none]} initialAdmin={true} />)).not.toThrow();
  });
});
