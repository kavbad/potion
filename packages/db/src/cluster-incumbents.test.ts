// Cluster-incumbent designation lifecycle (G2.1, migration 0025): at most
// one ACTIVE per (org, cluster), redesignation supersedes transactionally,
// unknown strategy hashes refuse (a designation pointing at nothing renders
// verdicts unexplainable), no cross-org visibility, and history keeps
// superseded rows with reasons (visible rigor).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  activeIncumbent,
  createDb,
  createOrg,
  designateIncumbent,
  listIncumbents,
  migrate,
  upsertStrategyConfig,
  type DbHandle,
} from './index.js';

let handle: DbHandle;
const db = () => handle.db;

const ORG = 'org_inc';
const OTHER_ORG = 'org_other';
const CLUSTER = 'agent-abc123-coding';
const HASH_A = 'sha-strategy-a';
const HASH_B = 'sha-strategy-b';

beforeEach(async () => {
  handle = await createDb();
  await migrate(handle.db);
  await createOrg(db(), { id: ORG, name: 'Incumbents' });
  await createOrg(db(), { id: OTHER_ORG, name: 'Other' });
  for (const hash of [HASH_A, HASH_B]) {
    // The designation only needs the hash to RESOLVE to a real config row; the
    // config's shape is never asserted on here, so the simplest valid
    // StrategyConfig variant is the honest fixture.
    await upsertStrategyConfig(db(), hash, { type: 'single', model: 'mock-cheap' });
  }
});

afterEach(async () => {
  await handle.close();
});

describe('designation lifecycle', () => {
  it('designates, then redesignation supersedes the prior active with a reason', async () => {
    const first = await designateIncumbent(db(), ORG, CLUSTER, HASH_A);
    expect(first.status).toBe('active');
    expect((await activeIncumbent(db(), ORG, CLUSTER))?.strategyHash).toBe(HASH_A);

    const second = await designateIncumbent(db(), ORG, CLUSTER, HASH_B);
    expect(second.status).toBe('active');
    expect(second.id).not.toBe(first.id);

    const active = await activeIncumbent(db(), ORG, CLUSTER);
    expect(active?.strategyHash).toBe(HASH_B);

    const history = await listIncumbents(db(), ORG, CLUSTER);
    expect(history).toHaveLength(2);
    const superseded = history.find((r) => r.id === first.id)!;
    expect(superseded.status).toBe('superseded');
    expect(superseded.statusReason).toContain(HASH_B);
  });

  it('re-designating the current incumbent is an idempotent no-op', async () => {
    const first = await designateIncumbent(db(), ORG, CLUSTER, HASH_A);
    const again = await designateIncumbent(db(), ORG, CLUSTER, HASH_A);
    expect(again.id).toBe(first.id);
    expect(await listIncumbents(db(), ORG, CLUSTER)).toHaveLength(1);
  });

  it('refuses an unknown strategy hash', async () => {
    await expect(designateIncumbent(db(), ORG, CLUSTER, 'sha-nope')).rejects.toThrow(
      /not found.*unknown incumbent/,
    );
    expect(await activeIncumbent(db(), ORG, CLUSTER)).toBeNull();
  });

  it('designations are org-scoped: same cluster, independent incumbents', async () => {
    await designateIncumbent(db(), ORG, CLUSTER, HASH_A);
    await designateIncumbent(db(), OTHER_ORG, CLUSTER, HASH_B);
    expect((await activeIncumbent(db(), ORG, CLUSTER))?.strategyHash).toBe(HASH_A);
    expect((await activeIncumbent(db(), OTHER_ORG, CLUSTER))?.strategyHash).toBe(HASH_B);
    expect(await listIncumbents(db(), ORG)).toHaveLength(1);
  });

  it('undesignated cluster reads null — never an inferred baseline', async () => {
    expect(await activeIncumbent(db(), ORG, 'agent-abc123-untouched')).toBeNull();
  });
});
