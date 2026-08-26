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
  retention: 1.01, suggestedFloor: 0.94, projectedSaving: 7.71, items: 40,
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
