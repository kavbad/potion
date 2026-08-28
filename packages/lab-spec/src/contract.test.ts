// Contract parsing units — deterministic (replay derives the same verdict
// from recorded text), fence-tolerant, strict beyond that.
import { describe, expect, it } from 'vitest';
import { parseBrief } from './contract.js';

const GOOD = {
  headline: [{ claim: 'Northwind cut Pro 20%', sourceUrl: 'https://northwind.example/pricing', entity: 'Northwind' }],
  byEntity: [{ entity: 'Northwind', items: [{ note: 'Pro $49→$39', sourceUrl: 'https://northwind.example/pricing' }] }],
  quiet: ['Fabrikam'],
  coverage: { checked: 6, note: 'TechCrunch feed was unreachable' },
};

describe('parseBrief', () => {
  it('accepts a bare JSON object', () => {
    const r = parseBrief(JSON.stringify(GOOD));
    expect(r.ok).toBe(true);
  });
  it('accepts a fenced block and text around one object', () => {
    expect(parseBrief('```json\n' + JSON.stringify(GOOD) + '\n```').ok).toBe(true);
    expect(parseBrief('Here is the brief:\n' + JSON.stringify(GOOD) + '\nDone.').ok).toBe(true);
  });
  it('a headline claim WITHOUT a source is refused with a pathed issue', () => {
    const bad = { ...GOOD, headline: [{ claim: 'trust me' }] };
    const r = parseBrief(JSON.stringify(bad));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.some((i) => i.includes('sourceUrl'))).toBe(true);
  });
  it('an empty headline is valid — nothing act-now is a legitimate day', () => {
    const r = parseBrief(JSON.stringify({ ...GOOD, headline: [] }));
    expect(r.ok).toBe(true);
  });
  it('prose with no object is refused, not crashed', () => {
    const r = parseBrief('I checked everything and it all looks fine!');
    expect(r.ok).toBe(false);
  });
  it('unknown fields are refused (strict)', () => {
    const r = parseBrief(JSON.stringify({ ...GOOD, vibe: 'good' }));
    expect(r.ok).toBe(false);
  });
});
