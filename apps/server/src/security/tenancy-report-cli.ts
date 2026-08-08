// Regenerate the committed tenancy classification exhibit (G2.4):
//   pnpm --filter @potion/server tenancy-report
//
// Pure: reads the two inventories, renders, writes. No db, no network.
// The companion test (apps/server/test/tenancy-report.test.ts) fails when
// the committed artifact drifts from the inventories.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ROUTE_INVENTORY } from './route-inventory.js';
import { MOCK_ELIGIBILITY_INVENTORY } from './mock-eligibility-inventory.js';
import { renderTenancyReport } from './render-tenancy-report.js';

const OUT = fileURLToPath(new URL('../../../../artifacts/tenancy-classification.md', import.meta.url));

const markdown = renderTenancyReport(ROUTE_INVENTORY, MOCK_ELIGIBILITY_INVENTORY);
writeFileSync(OUT, markdown, 'utf8');
console.error(`tenancy classification written: ${OUT} (${ROUTE_INVENTORY.length} routes)`);
