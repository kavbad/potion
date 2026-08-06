// Guarantee presentation tests (M3 #22, SPEC §12.5): badge-label +
// breach-selection logic, breach badge SSR markup, and the incidents table
// render (kind / cluster / rolling quality / resolve action gating).
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// The resolve button is a client island using next/navigation's useRouter —
// stub the app-router context for SSR markup tests (the hook value is never
// exercised here; clicks are a browser concern).
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }));
import { GuaranteeBadge } from '../components/guarantee-badge';
import { IncidentsTable } from '../components/incidents-table';
import { activeBreachForCluster, breachBadgeLabel, collectIncidents } from '../lib/guarantee';
import type { GuaranteeStatusDto, IncidentDto } from '../lib/types';

const ROLLBACK: IncidentDto = {
  id: 'inc-rb',
  kind: 'rollback',
  detail: {
    clusterId: 'code-gen',
    fromStrategy: 'aaaa1111bbbb',
    toStrategy: 'cccc2222dddd',
    toFrontierVersion: 1,
    rollingQuality: 0.42,
    minQuality: 0.8,
    windowMin: 15,
    samples: 7,
  },
  createdAt: '2026-08-04T12:00:00.000Z',
  resolvedAt: null,
};

const ALERT: IncidentDto = {
  id: 'inc-alert',
  kind: 'quality_breach',
  detail: { clusterId: 'extraction', fromStrategy: 'eeee3333', rollingQuality: 0.3 },
  createdAt: '2026-08-04T11:00:00.000Z',
  resolvedAt: null,
};

const RESOLVED: IncidentDto = { ...ROLLBACK, id: 'inc-old', resolvedAt: '2026-08-04T12:30:00.000Z' };

const STATUS: GuaranteeStatusDto = {
  orgId: 'org_demo',
  policies: [
    {
      policyId: 'pol-1',
      guarantee: { minQuality: 0.8, windowMin: 15, sampleRate: 0.2, action: 'rollback' },
      rollingQuality: 0.42,
      samples: 7,
      // the API repeats the same list under every policy → dedupe target
      breaches: [ROLLBACK, ALERT, RESOLVED],
    },
    {
      policyId: 'pol-2',
      guarantee: { minQuality: 0.9, windowMin: 30, sampleRate: 1, action: 'alert' },
      rollingQuality: 0.9,
      samples: 12,
      breaches: [ROLLBACK, ALERT, RESOLVED],
    },
  ],
};

describe('collectIncidents', () => {
  it('dedupes the per-policy repetition by incident id', () => {
    expect(collectIncidents(STATUS).map((i) => i.id)).toEqual(['inc-rb', 'inc-alert', 'inc-old']);
    expect(collectIncidents(null)).toEqual([]);
    expect(collectIncidents({ orgId: 'o', policies: [] })).toEqual([]);
  });
});

describe('activeBreachForCluster', () => {
  it('picks the unresolved rollback for the viewed cluster', () => {
    expect(activeBreachForCluster(STATUS, 'code-gen')?.id).toBe('inc-rb');
  });

  it('falls back to the alert when no rollback targets the cluster', () => {
    expect(activeBreachForCluster(STATUS, 'extraction')?.id).toBe('inc-alert');
  });

  it('ignores resolved incidents and clean clusters / null status', () => {
    expect(activeBreachForCluster({ ...STATUS, policies: [{ ...STATUS.policies[0]!, breaches: [RESOLVED] }] }, 'code-gen')).toBeNull();
    expect(activeBreachForCluster(STATUS, 'general')).toBeNull();
    expect(activeBreachForCluster(null, 'code-gen')).toBeNull();
  });
});

describe('breachBadgeLabel', () => {
  it('rollback → rolled back to <hash8>; alert → GUARANTEE ALERT', () => {
    expect(breachBadgeLabel(ROLLBACK)).toBe('GUARANTEE BREACH — rolled back to cccc2222');
    expect(breachBadgeLabel(ALERT)).toBe('GUARANTEE ALERT');
  });
});

describe('GuaranteeBadge (SSR)', () => {
  it('renders the amber rollback badge with the target hash', () => {
    const html = renderToStaticMarkup(<GuaranteeBadge incident={ROLLBACK} />);
    expect(html).toContain('GUARANTEE BREACH — rolled back to cccc2222');
    expect(html).toContain('amber');
    expect(html).toContain('0.42'); // title carries rolling quality context
  });

  it('renders the alert variant', () => {
    expect(renderToStaticMarkup(<GuaranteeBadge incident={ALERT} />)).toContain('GUARANTEE ALERT');
  });
});

describe('IncidentsTable (SSR)', () => {
  it('renders kind, cluster, move, rolling quality and time', () => {
    const html = renderToStaticMarkup(
      <IncidentsTable incidents={[ROLLBACK, ALERT]} isAdmin={false} />,
    );
    expect(html).toContain('rollback');
    expect(html).toContain('alert');
    expect(html).toContain('code-gen');
    expect(html).toContain('aaaa1111 → cccc2222');
    expect(html).toContain('0.42');
    expect(html).toContain('open'); // non-admin sees an "open" marker
    expect(html).not.toContain('Resolve'); // no action without admin
  });

  it('admins get the resolve action for open incidents; resolved rows show the timestamp', () => {
    const html = renderToStaticMarkup(
      <IncidentsTable incidents={[ROLLBACK, RESOLVED]} isAdmin={true} />,
    );
    expect(html).toContain('Resolve');
    expect(html).toContain('resolved');
  });

  it('empty state renders the guarantee explainer', () => {
    const html = renderToStaticMarkup(<IncidentsTable incidents={[]} isAdmin={true} />);
    expect(html).toContain('No guarantee incidents');
  });
});
