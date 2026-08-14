// Envelope encryption (M2 Wave 2, ROADMAP #16) — AES-256-GCM via node:crypto.
//
// Every provider key gets its OWN random 32-byte data key. The raw key is
// encrypted with the data key; the data key is wrapped (encrypted) with the
// master key. The envelope serializes to a single self-describing text value
// for provider_keys.ciphertext:
//
//   v1.<base64url(JSON)>
//   JSON: { w: {iv, tag, ct},  // data key wrapped under the master key
//           c: {iv, tag, ct} } // raw key encrypted under the data key
//
// GCM's 16-byte auth tag gives tamper DETECTION for free: any flipped bit in
// iv/ct/tag (or a wrong master key) fails auth on open — there is no
// "garbage plaintext" path. Random 12-byte IVs per operation make two
// encryptions of the same key incomparable.
//
// ZERO PLAINTEXT AT REST: only this envelope ever touches the db column; the
// data key and raw key exist only in process memory for the duration of one
// encrypt/decrypt call.
import { createCipheriv, createDecipheriv, randomBytes, type CipherGCMTypes } from 'node:crypto';

const ALGO: CipherGCMTypes = 'aes-256-gcm';
const IV_BYTES = 12; // GCM-standard 96-bit nonce
export const DATA_KEY_BYTES = 32; // AES-256
export const MASTER_KEY_BYTES = 32;

const ENVELOPE_PREFIX = 'v1.';

interface GcmBox {
  iv: string; // base64url
  tag: string; // base64url
  ct: string; // base64url
}

interface EnvelopeV1 {
  w: GcmBox; // wrapped data key (under the master key)
  c: GcmBox; // ciphertext of the raw provider key (under the data key)
}

/** Thrown on ANY decrypt failure (tamper, wrong key, malformed envelope) —
 * GCM auth errors are deliberately indistinguishable from each other. */
export class CustodyDecryptError extends Error {
  constructor(message = 'custody decrypt failed — envelope tampered, malformed, or wrong master key') {
    super(message);
    this.name = 'CustodyDecryptError';
  }
}

function b64u(buf: Buffer): string {
  return buf.toString('base64url');
}

function unb64u(s: string): Buffer {
  return Buffer.from(s, 'base64url');
}

function gcmSeal(key: Buffer, plaintext: Buffer): GcmBox {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { iv: b64u(iv), tag: b64u(cipher.getAuthTag()), ct: b64u(ct) };
}

function gcmOpen(key: Buffer, box: GcmBox): Buffer {
  try {
    const decipher = createDecipheriv(ALGO, key, unb64u(box.iv));
    decipher.setAuthTag(unb64u(box.tag));
    return Buffer.concat([decipher.update(unb64u(box.ct)), decipher.final()]);
  } catch {
    throw new CustodyDecryptError();
  }
}

export function generateDataKey(): Buffer {
  return randomBytes(DATA_KEY_BYTES);
}

/** Encrypt `plaintext` under a fresh random data key wrapped by `masterKey`.
 * Returns the serializable envelope text (safe for the ciphertext column). */
export function sealEnvelope(masterKey: Buffer, plaintext: string, dataKey?: Buffer): string {
  const dek = dataKey ?? generateDataKey();
  const envelope: EnvelopeV1 = {
    w: gcmSeal(masterKey, dek),
    c: gcmSeal(dek, Buffer.from(plaintext, 'utf8')),
  };
  return ENVELOPE_PREFIX + b64u(Buffer.from(JSON.stringify(envelope), 'utf8'));
}

/** Decrypt an envelope produced by sealEnvelope. Throws CustodyDecryptError
 * on tamper / wrong master key / malformed input. */
export function openEnvelope(masterKey: Buffer, envelopeText: string): string {
  let envelope: EnvelopeV1;
  try {
    if (!envelopeText.startsWith(ENVELOPE_PREFIX)) throw new Error('bad prefix');
    envelope = JSON.parse(Buffer.from(envelopeText.slice(ENVELOPE_PREFIX.length), 'base64url').toString('utf8')) as EnvelopeV1;
    if (!envelope.w || !envelope.c) throw new Error('bad shape');
  } catch {
    throw new CustodyDecryptError('custody decrypt failed — malformed envelope');
  }
  const dek = gcmOpen(masterKey, envelope.w);
  return gcmOpen(dek, envelope.c).toString('utf8');
}

/** Unwrap the data key from an envelope (used by master-key rotation). */
export function unwrapDataKey(masterKey: Buffer, envelopeText: string): Buffer {
  let envelope: EnvelopeV1;
  try {
    envelope = JSON.parse(Buffer.from(envelopeText.slice(ENVELOPE_PREFIX.length), 'base64url').toString('utf8')) as EnvelopeV1;
  } catch {
    throw new CustodyDecryptError('custody decrypt failed — malformed envelope');
  }
  return gcmOpen(masterKey, envelope.w);
}

/** Re-wrap an envelope's data key under a NEW master key WITHOUT ever
 * decrypting the raw provider key (the wrapped-data-key box is swapped; the
 * content box is carried over verbatim). */
export function rewrapEnvelope(oldMaster: Buffer, newMaster: Buffer, envelopeText: string): string {
  let envelope: EnvelopeV1;
  try {
    envelope = JSON.parse(Buffer.from(envelopeText.slice(ENVELOPE_PREFIX.length), 'base64url').toString('utf8')) as EnvelopeV1;
  } catch {
    throw new CustodyDecryptError('custody decrypt failed — malformed envelope');
  }
  const dek = gcmOpen(oldMaster, envelope.w);
  const next: EnvelopeV1 = { w: gcmSeal(newMaster, dek), c: envelope.c };
  return ENVELOPE_PREFIX + b64u(Buffer.from(JSON.stringify(next), 'utf8'));
}
