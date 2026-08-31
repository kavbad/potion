// Policy materialization — touchpoint 2 consumed as it exists: a dial
// position becomes an org policy row that serving's X-Potion-Policy
// override resolves through its own selectPoint. Deterministic ids are
// keyed by the SPEC HASH, so a dial move (new hash) creates a NEW row and
// the superseded spec's rows are RETAINED as history — an old spec+sidecar
// pair still resolves after a move (review outcome 2). Same-spec
// re-materialization is an idempotent upsert. Policy rows are org-owned
// and cascade-covered by deleteOrgCascade like everything org-owned.
import { sha256, type Policy } from '@potion/core';
import { policies, type PotionDb } from '@potion/db';
import { and, eq } from 'drizzle-orm';

export class DialPolicyCollisionError extends Error {
  constructor(id: string, ownerOrgId: string) {
    super(
      `dial policy id '${id}' exists under another org ('${ownerOrgId}') — a 24-bit ` +
        `discriminator collision (review finding); refuse loudly, never rewrite across orgs`,
    );
    this.name = 'DialPolicyCollisionError';
  }
}

/** policies.id is a GLOBAL primary key while resolution is org-scoped —
 * without an org discriminator, two orgs dialing the SAME spec (identical
 * hash) would collide on the PK and the second org's ref would resolve to
 * nothing (build finding). The 6-char org hash disambiguates. */
function orgDiscriminator(orgId: string): string {
  return sha256(orgId).slice(0, 6);
}

export function dialPolicyId(orgId: string, harnessHash: string, slot: 'brain' | 'tools' | 'judge'): string {
  return `pol-lab-${orgDiscriminator(orgId)}-${harnessHash.slice(0, 12)}-${slot}`;
}

export function dialPolicyName(orgId: string, harnessHash: string, slot: 'brain' | 'tools' | 'judge'): string {
  return `lab-${orgDiscriminator(orgId)}-${harnessHash.slice(0, 12)}-${slot}`;
}

export async function materializeDialPolicy(
  db: PotionDb,
  opts: { orgId: string; harnessHash: string; slot: 'brain' | 'tools' | 'judge'; policy: Policy },
): Promise<{ id: string; name: string }> {
  const id = dialPolicyId(opts.orgId, opts.harnessHash, opts.slot);
  const name = dialPolicyName(opts.orgId, opts.harnessHash, opts.slot);
  await db
    .insert(policies)
    .values({ id, orgId: opts.orgId, name, config: opts.policy })
    .onConflictDoUpdate({
      target: policies.id,
      set: { name, config: opts.policy },
      // The update only applies to OUR OWN row — a cross-org discriminator
      // collision must never rewrite another org's policy.
      setWhere: eq(policies.orgId, opts.orgId),
    });
  // Post-check: the row we now resolve must be OURS. A collision (24-bit
  // discriminator) surfaces as a loud typed error, never a silent no-op.
  const rows = await db.select().from(policies).where(and(eq(policies.id, id)));
  const row = rows[0];
  if (row === undefined || row.orgId !== opts.orgId) {
    throw new DialPolicyCollisionError(id, row?.orgId ?? '<missing>');
  }
  return { id, name };
}
