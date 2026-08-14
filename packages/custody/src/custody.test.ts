// Custody module tests (M2 Wave 2, ROADMAP #16) — the crypto + at-rest proof:
//   · AES-256-GCM envelope round-trip (per-key data key wrapped by master)
//   · tamper DETECTION (GCM auth tag): flipped bit / wrong master → throw
//   · master-key rotation re-wraps every custodied row (raw keys untouched)
//   · every decrypt writes a custody_audit row
//   · ZERO PLAINTEXT AT REST: the raw key substring never appears anywhere in
//     the on-disk PGlite data directory
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  createDb,
  getProviderKeyById,
  insertProviderKey,
  listCustodyAudit,
  migrate,
  type DbHandle,
} from '@potion/db';
import { sha256 } from '@potion/core';
import {
  CustodyDecryptError,
  CustodyService,
  StaticMasterKeyProvider,
  createMasterKeyProvider,
  openEnvelope,
  rewrapEnvelope,
  sealEnvelope,
} from './index.js';

const MASTER_A = randomBytes(32).toString('hex');
const MASTER_B = randomBytes(32).toString('hex');

const RAW_KEY = 'sk-ant-CANARY-3f9d1c7b2e48a6f05d1c9b7e3a5f2d4c';

describe('envelope crypto (AES-256-GCM)', () => {
  const master = Buffer.from(MASTER_A, 'hex');

  it('round-trips: seal → open returns the exact plaintext', () => {
    const envelope = sealEnvelope(master, RAW_KEY);
    expect(openEnvelope(master, envelope)).toBe(RAW_KEY);
  });

  it('is probabilistic: two seals of the same plaintext differ (random IVs + data keys)', () => {
    expect(sealEnvelope(master, RAW_KEY)).not.toBe(sealEnvelope(master, RAW_KEY));
  });

  it('contains NO plaintext substring anywhere in the envelope', () => {
    const envelope = sealEnvelope(master, RAW_KEY);
    expect(envelope).not.toContain('CANARY');
    // … also not in the decoded JSON payload
    const decoded = Buffer.from(envelope.slice('v1.'.length), 'base64url').toString('utf8');
    expect(decoded).not.toContain('CANARY');
  });

  it('detects tampering: a flipped ciphertext byte fails GCM auth', () => {
    const envelope = sealEnvelope(master, RAW_KEY);
    const payload = JSON.parse(
      Buffer.from(envelope.slice('v1.'.length), 'base64url').toString('utf8'),
    ) as { w: { ct: string }; c: { iv: string; tag: string; ct: string } };
    // flip one byte in the CONTENT ciphertext
    const ct = Buffer.from(payload.c.ct, 'base64url');
    ct[0] = (ct[0] ?? 0) ^ 0xff;
    payload.c.ct = ct.toString('base64url');
    const tampered = 'v1.' + Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    expect(() => openEnvelope(master, tampered)).toThrow(CustodyDecryptError);
  });

  it('detects tampering: a flipped WRAPPED-data-key byte fails GCM auth', () => {
    const envelope = sealEnvelope(master, RAW_KEY);
    const payload = JSON.parse(
      Buffer.from(envelope.slice('v1.'.length), 'base64url').toString('utf8'),
    ) as { w: { iv: string; tag: string; ct: string }; c: unknown };
    const ct = Buffer.from(payload.w.ct, 'base64url');
    ct[0] = (ct[0] ?? 0) ^ 0x01;
    payload.w.ct = ct.toString('base64url');
    const tampered = 'v1.' + Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    expect(() => openEnvelope(master, tampered)).toThrow(CustodyDecryptError);
  });

  it('rejects a wrong master key and malformed envelopes', () => {
    const envelope = sealEnvelope(master, RAW_KEY);
    expect(() => openEnvelope(Buffer.from(MASTER_B, 'hex'), envelope)).toThrow(CustodyDecryptError);
    expect(() => openEnvelope(master, 'v1.not-json!!!')).toThrow(CustodyDecryptError);
    expect(() => openEnvelope(master, 'garbage')).toThrow(CustodyDecryptError);
  });

  it('rewrap swaps the master without exposing the plaintext', () => {
    const envelope = sealEnvelope(master, RAW_KEY);
    const rewrapped = rewrapEnvelope(master, Buffer.from(MASTER_B, 'hex'), envelope);
    expect(openEnvelope(Buffer.from(MASTER_B, 'hex'), rewrapped)).toBe(RAW_KEY);
    expect(() => openEnvelope(master, rewrapped)).toThrow(CustodyDecryptError);
  });
});

describe('MasterKeyProvider resolution', () => {
  it('env provider: 64-hex POTION_MASTER_KEY; malformed fails loudly', () => {
    const p = createMasterKeyProvider({ env: { POTION_MASTER_KEY: MASTER_A }, warn: () => {} });
    expect(p.describe()).toBe('env:POTION_MASTER_KEY');
    expect(() => createMasterKeyProvider({ env: { POTION_MASTER_KEY: 'abc' } })).toThrow(
      /64 hex/,
    );
  });

  it('dev fallback: persists a generated master in the given dir with a loud warning', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'potion-master-'));
    const warnings: string[] = [];
    const p1 = createMasterKeyProvider({ env: {}, persistDir: dir, warn: (m) => warnings.push(m) });
    expect(warnings.some((w) => w.includes('WARNING'))).toBe(true);
    expect(p1.describe()).toContain('dev-file');
    // second boot reuses the SAME persisted key
    const p2 = createMasterKeyProvider({ env: {}, persistDir: dir, warn: () => {} });
    const [a, b] = await Promise.all([p1.getMasterKey(), p2.getMasterKey()]);
    expect(a.equals(b)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it('ephemeral fallback warns loudly when no dir is known', () => {
    const warnings: string[] = [];
    createMasterKeyProvider({ env: {}, warn: (m) => warnings.push(m) });
    expect(warnings.some((w) => w.includes('EPHEMERAL'))).toBe(true);
  });
});

describe('CustodyService (db-backed)', () => {
  let handle: DbHandle;
  let custody: CustodyService;
  const db = () => handle.db;

  beforeAll(async () => {
    handle = await createDb();
    await migrate(db());
    custody = new CustodyService({ db: db(), master: new StaticMasterKeyProvider(MASTER_A) });
  }, 60_000);

  afterAll(async () => {
    await handle.close();
  });

  it('encryptKey → decryptKey round-trips AND every decrypt writes a custody_audit row', async () => {
    const ciphertext = await custody.encryptKey(RAW_KEY);
    await insertProviderKey(db(), {
      id: 'pvk-custody-1',
      orgId: 'org_demo',
      provider: 'anthropic',
      name: 'custody test',
      maskedKey: 'sk-…d4c',
      keyHash: sha256(RAW_KEY),
      ciphertext,
    });
    const row = (await getProviderKeyById(db(), 'org_demo', 'pvk-custody-1'))!;
    expect(await custody.decryptKey(row, 'system:serve')).toBe(RAW_KEY);
    expect(await custody.decryptKey(row, 'usr_admin')).toBe(RAW_KEY);
    const audit = await listCustodyAudit(db(), 'org_demo', 'pvk-custody-1');
    expect(audit).toHaveLength(2);
    expect(audit.map((a) => a.action)).toEqual(['decrypt', 'decrypt']);
    expect(audit.map((a) => a.actor).sort()).toEqual(['system:serve', 'usr_admin']);
    // the audit trail NEVER carries key material
    expect(JSON.stringify(audit)).not.toContain('CANARY');
  });

  it('rotateMasterKey re-wraps ALL custodied rows: new master opens, old fails, audit written', async () => {
    const ciphertext = await custody.encryptKey('sk-openai-SECOND-KEY-1111222233334444');
    await insertProviderKey(db(), {
      id: 'pvk-custody-2',
      orgId: 'org_demo',
      provider: 'openai',
      name: 'rotation test',
      maskedKey: 'sk-…4444',
      keyHash: sha256('sk-openai-SECOND-KEY-1111222233334444'),
      ciphertext,
    });

    const rotated = await custody.rotateMasterKey(MASTER_A, MASTER_B, 'system:master-rotation');
    expect(rotated).toBe(2); // both custodied rows re-wrapped

    const underB = new CustodyService({ db: db(), master: new StaticMasterKeyProvider(MASTER_B) });
    const r1 = (await getProviderKeyById(db(), 'org_demo', 'pvk-custody-1'))!;
    const r2 = (await getProviderKeyById(db(), 'org_demo', 'pvk-custody-2'))!;
    expect(await underB.decryptKey(r1, 'test')).toBe(RAW_KEY);
    expect(await underB.decryptKey(r2, 'test')).toBe('sk-openai-SECOND-KEY-1111222233334444');
    // old master can no longer open anything
    await expect(custody.decryptKey(r1, 'test')).rejects.toThrow(CustodyDecryptError);

    const audit = await listCustodyAudit(db(), 'org_demo');
    const rotates = audit.filter((a) => a.action === 'rotate');
    expect(rotates.length).toBeGreaterThanOrEqual(3); // 2 per-key + 1 summary
    expect(rotates.some((a) => a.providerKeyId === null)).toBe(true); // summary row
  });

  it('legacy masked-only rows (ciphertext NULL) refuse to decrypt with a clear error', async () => {
    await insertProviderKey(db(), {
      id: 'pvk-legacy',
      orgId: 'org_demo',
      provider: 'google',
      name: 'legacy',
      maskedKey: 'AI…zzzz',
      keyHash: sha256('legacy-raw-key-material'),
    });
    const row = (await getProviderKeyById(db(), 'org_demo', 'pvk-legacy'))!;
    await expect(custody.decryptKey(row, 'test')).rejects.toThrow(/no ciphertext/);
  });
});

describe('ZERO PLAINTEXT AT REST (on-disk PGlite scan)', () => {
  it('the raw key substring appears NOWHERE in the PGlite data directory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'potion-atrest-'));
    const handle = await createDb(`pglite://${dir}`);
    try {
      await migrate(handle.db);
      const custody = new CustodyService({
        db: handle.db,
        master: new StaticMasterKeyProvider(MASTER_A),
      });
      const ciphertext = await custody.encryptKey(RAW_KEY);
      await insertProviderKey(handle.db, {
        id: 'pvk-atrest',
        orgId: 'org_demo',
        provider: 'anthropic',
        name: 'at-rest canary',
        maskedKey: 'sk-…d4c',
        keyHash: sha256(RAW_KEY),
        ciphertext,
      });
      // sanity: the row round-trips through the db
      const row = (await getProviderKeyById(handle.db, 'org_demo', 'pvk-atrest'))!;
      expect(await custody.decryptKey(row, 'test')).toBe(RAW_KEY);
    } finally {
      await handle.close();
    }

    // Recursively scan EVERY byte of the data directory for plaintext
    // fragments of the raw key (full key, distinctive token, prefix).
    const needles = [RAW_KEY, 'CANARY-3f9d1c7b', 'sk-ant-CANARY'].map((s) => Buffer.from(s, 'utf8'));
    const files: string[] = [];
    const walk = (d: string): void => {
      for (const name of readdirSync(d)) {
        const p = join(d, name);
        if (statSync(p).isDirectory()) walk(p);
        else files.push(p);
      }
    };
    walk(dir);
    expect(files.length).toBeGreaterThan(0);
    let hits = 0;
    for (const f of files) {
      const content = readFileSync(f);
      for (const needle of needles) {
        if (content.includes(needle)) hits += 1;
      }
    }
    expect(hits).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  }, 60_000);
});
