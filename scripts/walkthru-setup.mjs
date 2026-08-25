// Brand-new-org walkthrough (house rule: walk every journey as a fresh org
// before calling anything done). Runs inside the prod server container.
//   node /tmp/walkthru.mjs setup    → creates org+admin+session, prints token line
//   node /tmp/walkthru.mjs teardown → cascade-deletes the org
import { randomUUID, createHash } from 'node:crypto';

const db = await import('file:///app/node_modules/@potion/db/dist/index.js');
const ORG = 'org-walkthru';
const handle = await db.createDb(process.env.DATABASE_URL);
const d = handle.db;
const mode = process.argv[2] ?? 'setup';

if (mode === 'teardown') {
  const report = await db.deleteOrgCascade(d, ORG);
  console.log('teardown:', JSON.stringify(report.deleted ?? report).slice(0, 400));
  await handle.close?.();
  process.exit(0);
}

await db.createOrg(d, { id: ORG, name: 'Walkthrough Partners Inc' });
await db.createUser(d, { id: 'usr-walkthru', email: 'engineer@walkthrough-partners.test', name: 'Walk Engineer' });
await db.createMembership(d, { orgId: ORG, userId: 'usr-walkthru', role: 'admin' });
const raw = `ps_${randomUUID().replace(/-/g, '')}`;
await db.createSession(d, {
  id: `ses-${randomUUID().slice(0, 8)}`,
  userId: 'usr-walkthru',
  tokenHash: createHash('sha256').update(raw).digest('hex'),
  orgId: ORG,
  expiresAt: new Date(Date.now() + 2 * 3600 * 1000),
});
console.log('setup ok: org-walkthru, admin session (2h)');
console.log(`SESSTOKEN=${raw}`);
await handle.close?.();
