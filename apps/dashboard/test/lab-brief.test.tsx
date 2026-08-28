// BriefView renders the contract's shape faithfully: claims with their
// sources, quiet stated not implied, partial coverage in warning ink.
// House idiom: SSR markup assertions (renderToStaticMarkup).
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BriefView } from '@/components/lab-brief';

const BRIEF = {
  headline: [{ claim: 'Northwind cut Pro 20%', sourceUrl: 'https://northwind.example/pricing', entity: 'Northwind' }],
  byEntity: [{ entity: 'Northwind', items: [{ note: 'Pro $49→$39', sourceUrl: 'https://northwind.example/pricing' }] }],
  quiet: ['Fabrikam'],
  coverage: { checked: 6, note: 'TechCrunch feed was unreachable' },
};

describe('BriefView', () => {
  it('renders headline claims WITH their source links, coverage, and quiet', () => {
    const html = renderToStaticMarkup(<BriefView brief={BRIEF} />);
    expect(html).toContain('Northwind cut Pro 20%');
    expect(html).toContain('href="https://northwind.example/pricing"');
    expect(html).toContain('6 sources checked');
    expect(html).toContain('TechCrunch feed was unreachable');
    expect(html).toContain('quiet: Fabrikam');
  });
  it('an empty headline is a stated quiet day, never a blank', () => {
    const html = renderToStaticMarkup(<BriefView brief={{ ...BRIEF, headline: [] }} />);
    expect(html).toContain('brief-quiet-day');
    expect(html).toContain('Nothing act-now today');
  });
});
