// F2 rig — mint the research org's serving key for the runtime-gate
// surface (POST /v1/lab/runtime/* are bearer-key routes). Idempotent by
// id: re-running rotates the key (old hash replaced).
//   DATABASE_URL=... npx tsx scripts/research-key-mint.ts
import { createHash, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';

const require_ = createRequire(new URL('../packages/db/package.json', import.meta.url));
const pg = require_('pg') as typeof import('pg');

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const url = process.env.DATABASE_URL;
if (!url) throw new Error('set DATABASE_URL');

const c = new pg.Client({ connectionString: url, ssl: url.includes('render.com') ? { rejectUnauthorized: false } : undefined });
await c.connect();
const raw = `pk_research_gate_${randomBytes(12).toString('hex')}`;
await c.query(
  `INSERT INTO api_keys (id, key_hash, name, org_id, scopes) VALUES ('key-research-gate', $1, 'research publish gate', 'org-research', 'serve')
   ON CONFLICT (id) DO UPDATE SET key_hash = EXCLUDED.key_hash, revoked_at = NULL`,
  [sha256(raw)],
);
console.log(`POTION_RESEARCH_KEY=${raw}`);
await c.end();
