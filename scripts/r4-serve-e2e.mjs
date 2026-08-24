// exec-pick promotion check c (2026-08-24): can the SERVING PATH execute an
// ensemble end to end? Runs INSIDE the prod server container against prod
// Postgres, on a throwaway org with an ORG-SCOPED frontier — the platform
// chain is never touched, and the org is deleted by the caller afterwards.
//
//   docker cp → /tmp/r4e2e.mjs, then:
//   docker compose exec -T server node /tmp/r4e2e.mjs setup   → prints key id + raw key
//   (curl from outside, then)
//   docker compose exec -T server node /tmp/r4e2e.mjs teardown
import { randomUUID, createHash } from 'node:crypto';

const db = await import('file:///app/node_modules/@potion/db/dist/index.js');
const pareto = await import('file:///app/node_modules/@potion/pareto/dist/index.js');
const core = await import('file:///app/node_modules/@potion/core/dist/index.js');

const ORG = 'org-execpick-e2e';
const handle = await db.createDb(process.env.DATABASE_URL);
const d = handle.db;
const mode = process.argv[2] ?? 'setup';

if (mode === 'teardown') {
  const report = await db.deleteOrgCascade(d, ORG);
  console.log('teardown:', JSON.stringify(report).slice(0, 300));
  await handle.close?.();
  process.exit(0);
}

const WINNER = {
  type: 'ensemble',
  models: ['or-solar-pro4', 'or-gemini-flash'],
  fusion: { method: 'exec-pick', testWriter: { model: 'or-gpt-mini' }, judge: { model: 'or-gpt-mini' } },
};
const SOLAR = { type: 'single', model: 'or-solar-pro4' };

await db.createOrg(d, { id: ORG, name: 'exec-pick e2e (throwaway)' });
await db.insertPolicy(d, {
  id: 'pol-execpick-e2e',
  orgId: ORG,
  name: 'floor 0.995 (e2e)',
  config: { type: 'min_cost', qualityFloor: 0.995 },
});
const raw = `pk_${randomUUID().replace(/-/g, '')}`;
await db.insertApiKey(d, {
  id: 'key-execpick-e2e',
  keyHash: createHash('sha256').update(raw).digest('hex'),
  name: 'e2e',
  orgId: ORG,
  scopes: 'serve',
  policyId: 'pol-execpick-e2e',
});
const points = [
  {
    clusterId: 'code-gen',
    strategyHash: core.strategyHash(WINNER),
    strategyConfig: WINNER,
    quality: 0.9967,
    costPer1K: 1.711,
    latencyP95: 15001,
    providerMode: 'live',
  },
  {
    clusterId: 'code-gen',
    strategyHash: core.strategyHash(SOLAR),
    strategyConfig: SOLAR,
    quality: 0.9804,
    costPer1K: 0.0231,
    latencyP95: 15693,
    providerMode: 'live',
  },
];
const fr = await pareto.saveFrontier(d, 'code-gen', points, 'import', 'e2e-canary', { orgId: ORG });
console.log(`setup ok: org ${ORG}, frontier v${fr.version} (${fr.points.length} points), key id key-execpick-e2e`);
console.log(`RAWKEY=${raw}`);
await handle.close?.();
