// Master-key provisioning (M2 Wave 2, ROADMAP #16) — the MasterKeyProvider
// interface is the SEAM where a cloud KMS lands later.
//
//   · EnvMasterKeyProvider (NOW): the 32-byte master key comes from the
//     POTION_MASTER_KEY env var as 64 hex chars. Suitable for prod until KMS.
//   · Dev-file fallback: when POTION_MASTER_KEY is unset and a persistent
//     dir is known (the local PGlite data dir), a random master key is
//     generated once and persisted to <dir>/.potion-master-key (mode 0600)
//     with a LOUD warning — dev ergonomics, never prod.
//   · Ephemeral fallback: in-memory PGlite (tests) gets a random per-process
//     key with a loud warning (ciphertexts are undecryptable across restarts
//     — irrelevant for in-memory dbs).
//
// TODO(cloud-KMS): implement MasterKeyProvider over AWS KMS / GCP Cloud KMS
// (CMEK). The envelope format is already KMS-shaped — w = KMS.Encrypt(dek)
// output, and unwrap maps to KMS.Decrypt — so only this file changes; the
// envelope + service + migration are KMS-ready.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MASTER_KEY_BYTES } from './envelope.js';

export interface MasterKeyProvider {
  /** The 32-byte master key. */
  getMasterKey(): Promise<Buffer>;
  /** Human-readable provenance for logs/audits (never the key itself). */
  describe(): string;
}

/** Master key from the POTION_MASTER_KEY env var (64 lowercase/uppercase
 * hex chars = 32 bytes). Throws a clear boot-time error when malformed. */
export class EnvMasterKeyProvider implements MasterKeyProvider {
  private readonly key: Buffer;

  constructor(hex: string) {
    const trimmed = hex.trim();
    if (!/^[0-9a-fA-F]{64}$/.test(trimmed)) {
      throw new Error(
        'POTION_MASTER_KEY must be 64 hex chars (32 bytes) — e.g. `openssl rand -hex 32`. ' +
          `Got ${trimmed.length} chars.`,
      );
    }
    this.key = Buffer.from(trimmed, 'hex');
  }

  getMasterKey(): Promise<Buffer> {
    return Promise.resolve(this.key);
  }

  describe(): string {
    return 'env:POTION_MASTER_KEY';
  }
}

export const DEV_MASTER_KEY_FILENAME = '.potion-master-key';

/** Dev-file provider: generate-once + persist under the PGlite data dir. */
export class DevFileMasterKeyProvider implements MasterKeyProvider {
  private readonly key: Buffer;
  readonly path: string;

  constructor(dir: string, warn: (msg: string) => void = () => {}) {
    mkdirSync(dir, { recursive: true });
    this.path = join(dir, DEV_MASTER_KEY_FILENAME);
    if (existsSync(this.path)) {
      const hex = readFileSync(this.path, 'utf8').trim();
      if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
        throw new Error(
          `dev master key file ${this.path} is corrupt (expected 64 hex chars) — delete it to regenerate (existing ciphertexts become undecryptable)`,
        );
      }
      this.key = Buffer.from(hex, 'hex');
    } else {
      this.key = randomBytes(MASTER_KEY_BYTES);
      writeFileSync(this.path, this.key.toString('hex') + '\n', { mode: 0o600 });
    }
    warn(
      `[potion custody] WARNING: POTION_MASTER_KEY not set — using a DEV-ONLY master key ` +
        `persisted at ${this.path}. NEVER rely on this in production: set POTION_MASTER_KEY ` +
        `(64 hex, \`openssl rand -hex 32\`) or wire a cloud KMS via MasterKeyProvider.`,
    );
  }

  getMasterKey(): Promise<Buffer> {
    return Promise.resolve(this.key);
  }

  describe(): string {
    return `dev-file:${this.path}`;
  }
}

/** Ephemeral provider (in-memory PGlite / tests): random per process. */
export class EphemeralMasterKeyProvider implements MasterKeyProvider {
  private readonly key = randomBytes(MASTER_KEY_BYTES);

  constructor(warn: (msg: string) => void = () => {}) {
    warn(
      `[potion custody] WARNING: POTION_MASTER_KEY not set and the db is in-memory — using an ` +
        `EPHEMERAL dev-only master key (ciphertexts die with the process). Set POTION_MASTER_KEY ` +
        `(64 hex) for anything that must survive a restart.`,
    );
  }

  getMasterKey(): Promise<Buffer> {
    return Promise.resolve(this.key);
  }

  describe(): string {
    return 'dev-ephemeral';
  }
}

/** Fixed-key provider (tests, master-rotation CLI): wraps a known hex key. */
export class StaticMasterKeyProvider implements MasterKeyProvider {
  private readonly env: EnvMasterKeyProvider;
  constructor(hex: string) {
    this.env = new EnvMasterKeyProvider(hex);
  }
  getMasterKey(): Promise<Buffer> {
    return this.env.getMasterKey();
  }
  describe(): string {
    return 'static:test';
  }
}

/**
 * Resolve the master-key provider for this boot:
 *   POTION_MASTER_KEY set → env provider (the only prod-acceptable path).
 *   else persistDir known (pglite://<dir>) → dev-file provider (loud).
 *   else (in-memory PGlite) → ephemeral provider (loud).
 */
export function createMasterKeyProvider(opts: {
  env?: NodeJS.ProcessEnv;
  persistDir?: string | null;
  warn?: (msg: string) => void;
}): MasterKeyProvider {
  const env = opts.env ?? process.env;
  const warn = opts.warn ?? ((msg: string) => console.warn(msg));
  const hex = env.POTION_MASTER_KEY;
  if (hex !== undefined && hex.trim() !== '') return new EnvMasterKeyProvider(hex);
  if (opts.persistDir) return new DevFileMasterKeyProvider(opts.persistDir, warn);
  return new EphemeralMasterKeyProvider(warn);
}
