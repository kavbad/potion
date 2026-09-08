// The committed classification exhibit must match the inventories it is
// generated from (G2.4). This is the ha-deploy.test.ts pattern: a repo file
// is read and asserted against code, so a fixture change without a
// regeneration fails here rather than shipping a stale security answer.
//
// Fix a failure with: pnpm --filter @potion/server tenancy-report
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ROUTE_INVENTORY } from '../src/security/route-inventory.js';
import { MOCK_ELIGIBILITY_INVENTORY } from '../src/security/mock-eligibility-inventory.js';
import { renderTenancyReport } from '../src/security/render-tenancy-report.js';

const ARTIFACT = fileURLToPath(
  new URL('../../../artifacts/tenancy-classification.md', import.meta.url),
);

describe('tenancy classification artifact', () => {
  it('is up to date with the committed inventories', () => {
    const rendered = renderTenancyReport(ROUTE_INVENTORY, MOCK_ELIGIBILITY_INVENTORY);
    const committed = readFileSync(ARTIFACT, 'utf8');
    expect(
      committed,
      'artifacts/tenancy-classification.md is stale — regenerate with ' +
        '`pnpm --filter @potion/server tenancy-report` and commit the result — the artifact IS committed (.gitignore un-ignores it), which is what lets this test catch an inventory change that never regenerated it)',
    ).toBe(rendered);
  });

  it('is deterministic (no clock, no environment) so the artifact is byte-stable', () => {
    const a = renderTenancyReport(ROUTE_INVENTORY, MOCK_ELIGIBILITY_INVENTORY);
    const b = renderTenancyReport(ROUTE_INVENTORY, MOCK_ELIGIBILITY_INVENTORY);
    expect(a).toBe(b);
    expect(a).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:/); // no timestamps
  });

  it('carries the substance a diligence reader needs', () => {
    const md = renderTenancyReport(ROUTE_INVENTORY, MOCK_ELIGIBILITY_INVENTORY);
    // Every route appears.
    for (const row of ROUTE_INVENTORY) {
      expect(md, `${row.method} ${row.path} missing from the exhibit`).toContain(row.path);
    }
    // The enforcement claim names the tests that back it.
    expect(md).toContain('tenancy-sweep.test.ts');
    expect(md).toContain('key-role-split.test.ts');
    expect(md).toContain('mock-eligibility.test.ts');
    // The posture notes a customer's security reviewer will look for.
    expect(md).toContain('POTION_SEED_DEMO');
    expect(md).toContain('POTION_SELF_SERVE');
    expect(md).toMatch(/hashed/i);
  });
});
