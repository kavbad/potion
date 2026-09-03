// F0 rig — create the Potion Research org + ops user + member session on
// prod (docs/RESEARCH-FLEET.md R5: the fleet lives in a real org).
// Idempotent: org/user/membership upsert; a NEW session token mints each
// run (old ones stay valid until expiry). Prints the raw token ONCE —
// export it as POTION_LAB_SESSION for delta-hire and the weekly script.
//   DATABASE_URL=... npx tsx scripts/research-org-rig.ts
import { createHash, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';

// pg is not hoisted at the repo root (pnpm strict layout) — resolve it
// through @potion/db, which depends on it.
const require_ = createRequire(new URL('../packages/db/package.json', import.meta.url));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const pg = require_('pg') as typeof import('pg');

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const url = process.env.DATABASE_URL;
if (!url) throw new Error('set DATABASE_URL');

const c = new pg.Client({ connectionString: url, ssl: url.includes('render.com') ? { rejectUnauthorized: false } : undefined });
await c.connect();
await c.query(`INSERT INTO orgs (id, name) VALUES ('org-research', 'Potion Research') ON CONFLICT (id) DO NOTHING`);
await c.query(`INSERT INTO users (id, email, name) VALUES ('user-research-ops', 'research-ops@withpotion.com', 'Research Ops') ON CONFLICT (id) DO NOTHING`);
await c.query(`INSERT INTO memberships (org_id, user_id, role) VALUES ('org-research', 'user-research-ops', 'admin') ON CONFLICT DO NOTHING`);
const raw = `ps_research_${randomBytes(16).toString('hex')}`;
await c.query(
  `INSERT INTO sessions (id, user_id, token_hash, org_id, expires_at) VALUES ($1, 'user-research-ops', $2, 'org-research', now() + interval '180 days')`,
  [`sess-research-${randomBytes(4).toString('hex')}`, sha256(raw)],
);
const check = await c.query(`SELECT o.id, o.name, m.role FROM orgs o JOIN memberships m ON m.org_id = o.id WHERE o.id = 'org-research'`);
console.log(JSON.stringify(check.rows));
console.log(`POTION_LAB_SESSION=${raw}`);
await c.end();
