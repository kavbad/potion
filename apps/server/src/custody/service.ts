// Custody service (M2 Wave 2, ROADMAP #16) — the audited crypto boundary for
// provider keys. Composes envelope.ts (AES-256-GCM envelope encryption) with
// a MasterKeyProvider and writes custody_audit rows for every sensitive op.
//
//   encryptKey(plaintext)                  → envelope for POST /api/keys
//   decryptKey(row, actor)                 → plaintext, audited ('decrypt')
//   rotateMasterKey(oldHex, newHex, actor) → re-wrap ALL custodied rows under
//                                            the new master, audited ('rotate')
//   record(...)                            → audit helper for route-level
//                                            events ('encrypt'/'revoke'/'validate')
//
// ZERO PLAINTEXT AT REST: plaintext only exists in-process between open and
// use (serving path hands it straight to the provider factory). The audit
// trail NEVER records key material — ids, versions and provenance only.
import { randomUUID } from 'node:crypto';
import {
  insertCustodyAudit,
  listCustodiedProviderKeys,
  rewrapProviderKey,
  type CustodyAction,
  type PotionDb,
  type ProviderKeyRow,
} from '@potion/db';
import { openEnvelope, rewrapEnvelope, sealEnvelope } from './envelope.js';
import type { MasterKeyProvider } from './master.js';

export interface CustodyServiceOptions {
  db: PotionDb;
  master: MasterKeyProvider;
  /** Clock override (tests). */
  now?: () => Date;
}

export class CustodyService {
  private readonly db: PotionDb;
  private readonly master: MasterKeyProvider;
  private readonly now: () => Date;

  constructor(opts: CustodyServiceOptions) {
    this.db = opts.db;
    this.master = opts.master;
    this.now = opts.now ?? (() => new Date());
  }

  /** Master-key provenance string for logs (never key material). */
  describeMaster(): string {
    return this.master.describe();
  }

  /** Encrypt a raw provider key → envelope text for provider_keys.ciphertext.
   * Pure crypto (no audit): the registering route writes the 'encrypt' audit
   * row with the row id it just minted. */
  async encryptKey(plaintext: string): Promise<string> {
    return sealEnvelope(await this.master.getMasterKey(), plaintext);
  }

  /** Decrypt a provider-key row. EVERY successful decrypt writes a
   * custody_audit 'decrypt' row (serving path included). Throws
   * CustodyDecryptError on tamper/wrong master; rows without a ciphertext
   * (legacy masked-only) throw a plain Error. */
  async decryptKey(row: ProviderKeyRow, actor: string): Promise<string> {
    if (!row.ciphertext) {
      throw new Error(
        `provider key '${row.id}' has no ciphertext (legacy masked-only row) — register a fresh key`,
      );
    }
    const plaintext = openEnvelope(await this.master.getMasterKey(), row.ciphertext);
    await this.record(row.orgId, actor, 'decrypt', row.id, {
      provider: row.provider,
      keyVersion: row.keyVersion,
      master: this.master.describe(),
    });
    return plaintext;
  }

  /** Append a custody_audit row. metadata must NEVER contain key material. */
  async record(
    orgId: string,
    actor: string,
    action: CustodyAction,
    providerKeyId: string | null,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    await insertCustodyAudit(this.db, {
      id: `ca-${randomUUID().replace(/-/g, '').slice(0, 16)}`,
      orgId,
      actor,
      action,
      providerKeyId,
      ...(metadata !== undefined ? { metadata } : {}),
    });
  }

  /**
   * Master-key rotation: re-wrap EVERY custodied (non-revoked) provider key's
   * data key under the NEW master — without ever decrypting the raw provider
   * keys (rewrapEnvelope swaps only the wrapped-data-key box). Returns the
   * number of re-wrapped rows and writes one audited 'rotate' row per key
   * plus a summary row (provider_key_id NULL).
   *
   * Ops flow: boot with the OLD POTION_MASTER_KEY, run this (CLI/route),
   * then restart with the NEW POTION_MASTER_KEY. Throws (leaving prior rows
   * re-wrapped but recoverable by re-running with swapped args) if any row's
   * envelope fails to open under the old key — that row is tampered or was
   * written under a different master.
   */
  async rotateMasterKey(oldHex: string, newHex: string, actor: string): Promise<number> {
    const oldMaster = Buffer.from(oldHex, 'hex');
    const newMaster = Buffer.from(newHex, 'hex');
    if (oldMaster.length !== 32 || newMaster.length !== 32) {
      throw new Error('rotateMasterKey expects 64-hex (32-byte) old and new master keys');
    }
    const rows = await listCustodiedProviderKeys(this.db);
    let rewrapped = 0;
    for (const row of rows) {
      // ciphertext is guaranteed non-null by listCustodiedProviderKeys.
      const next = rewrapEnvelope(oldMaster, newMaster, row.ciphertext as string);
      await rewrapProviderKey(this.db, row.id, next);
      rewrapped += 1;
      await this.record(row.orgId, actor, 'rotate', row.id, {
        kind: 'master-rewrap',
        keyVersion: row.keyVersion,
      });
    }
    // Summary row per org is overkill; one platform row on the first affected
    // org (or the default org when the sweep was empty) records the event.
    const orgId = rows[0]?.orgId ?? 'org_demo';
    await this.record(orgId, actor, 'rotate', null, {
      kind: 'master',
      rewrapped,
      master: 'rotated',
    });
    return rewrapped;
  }
}
