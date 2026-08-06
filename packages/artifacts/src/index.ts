// Artifact store (SPEC §12.2): binary-safe object storage for harness/sweep
// JSON artifacts. Two backends behind one interface:
//   · local — a directory on disk (default ./artifacts). Keeps M2 behavior:
//     when no store is configured, nothing changes (callers only write
//     through a store "when configured").
//   · s3    — any S3-compatible object store (MinIO ok) via
//     @aws-sdk/client-s3 with forcePathStyle. Config by env:
//     S3_ENDPOINT / S3_BUCKET / S3_ACCESS_KEY / S3_SECRET_KEY [/ S3_REGION].
import { localArtifactStore } from './local.js';
import { s3ArtifactStore, type S3ClientLike } from './s3.js';

export interface ArtifactStore {
  put(key: string, body: Buffer | NodeJS.ReadableStream): Promise<void>;
  getUrl(key: string): Promise<string>;
  exists(key: string): Promise<boolean>;
}

export type ArtifactStoreKind = 'local' | 's3';

export interface ArtifactStoreOptions {
  /** local: target directory (default './artifacts'). */
  dir?: string;
  /** s3: bucket (default S3_BUCKET env). */
  bucket?: string;
  /** Key prefix applied to every key (both kinds), e.g. 'evals/'. */
  prefix?: string;
  /** s3: endpoint URL (default S3_ENDPOINT env; MinIO-compatible). */
  endpoint?: string;
  /** s3 test seam: a hand stub / aws-sdk-client-mock S3 client. */
  client?: S3ClientLike;
}

export function createArtifactStore(
  kind: ArtifactStoreKind,
  opts: ArtifactStoreOptions = {},
): ArtifactStore {
  switch (kind) {
    case 'local':
      return localArtifactStore({ ...(opts.dir !== undefined ? { dir: opts.dir } : {}), ...(opts.prefix !== undefined ? { prefix: opts.prefix } : {}) });
    case 's3':
      return s3ArtifactStore(opts);
  }
}

export { localArtifactStore } from './local.js';
export { s3ArtifactStore, type S3ClientLike } from './s3.js';
