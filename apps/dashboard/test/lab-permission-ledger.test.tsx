// L-G3 ledger tests (house idiom: SSR markup over injected state). The
// contract on the surface: three groups, no trust score anywhere, evidence
// behind every line, never-graduates rendered as refusal.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LabPermissionLedger, type LedgerResponse } from '@/components/lab-permission-ledger';

const ev = (n: number, approved: number, rejected = 0, edited = 0) => ({ n, approved, edited, rejected, lastAt: '2026-08-26T00:00:00Z' });
const LEDGER: LedgerResponse = {
  grants: [
    { id: 'g1', actionClass: 'crm:lookup', riskTier: 'reversible-read', state: 'autonomous', auditRate: 0.05, stateReason: null, grantedAt: '2026-08-26T00:00:00Z', revokedAt: null, evidence: ev(30, 30) },
    { id: 'g2', actionClass: 'email:send', riskTier: 'reversible-act', state: 'supervised', auditRate: 1, stateReason: null, grantedAt: null, revokedAt: null, evidence: ev(3, 2, 1) },
    { id: 'g3', actionClass: 'payments:wire', riskTier: 'never-graduates', state: 'supervised', auditRate: 1, stateReason: null, grantedAt: null, revokedAt: null, evidence: ev(40, 40) },
  ],
  observedUngranted: [],
};

describe('LabPermissionLedger', () => {
  it('renders the three groups with evidence lines and the audit rate — and no scalar trust number', () => {
    const html = renderToStaticMarkup(
      <LabPermissionLedger harnessHash="h" role="viewer" initialLedger={LEDGER} initialProposals={[]} />,
    );
    expect(html).toContain('Can act alone');
    expect(html).toContain('Asks first');
    expect(html).toContain('crm:lookup');
    expect(html).toContain('30 observed');
    expect(html).toContain('audit 5%');
    expect(html).toContain('never graduates');
    expect(html).toContain('there is no trust score');
    expect(html).not.toMatch(/trust:?\s*\d/i);
  });

  it('proposals render the grant button for admins and only a note for viewers', () => {
    const proposals = [{ grantId: 'g2', actionClass: 'email:send', decision: { why: '80 observed, lower bound cleared' } }];
    const admin = renderToStaticMarkup(
      <LabPermissionLedger harnessHash="h" role="admin" initialLedger={LEDGER} initialProposals={proposals} />,
    );
    expect(admin).toContain('Grant autonomy');
    const viewer = renderToStaticMarkup(
      <LabPermissionLedger harnessHash="h" role="viewer" initialLedger={LEDGER} initialProposals={proposals} />,
    );
    expect(viewer).toContain('an admin can grant this');
    expect(viewer).not.toContain('Grant autonomy');
  });

  it('day-2 honesty: an empty autonomous group says autonomy is earned, not missing', () => {
    const empty: LedgerResponse = { grants: [LEDGER.grants[1]!], observedUngranted: [] };
    const html = renderToStaticMarkup(
      <LabPermissionLedger harnessHash="h" role="viewer" initialLedger={empty} initialProposals={[]} />,
    );
    expect(html).toContain('autonomy is earned per action class');
  });
});
