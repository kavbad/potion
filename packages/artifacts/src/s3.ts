// S3-compatible artifact store (MinIO ok): forcePathStyle, env-driven config.
//   S3_ENDPOINT   e.g. http://localhost:9000 (docker-compose minio)
//   S3_BUCKET     e.g. potion-artifacts
//   S3_ACCESS_KEY / S3_SECRET_KEY
//   S3_REGION     optional (default us-east-1)
import {
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type PutObjectCommandInput,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import type { ArtifactStore, ArtifactStoreOptions } from './index.js';

/** Minimal structural client type — satisfied by S3Client and by hand stubs /
 * aws-sdk-client-mock in tests. */
export interface S3ClientLike {
  send(command: unknown): Promise<unknown>;
}

export interface S3StoreEnv {
  S3_ENDPOINT?: string | undefined;
  S3_BUCKET?: string | undefined;
  S3_ACCESS_KEY?: string | undefined;
  S3_SECRET_KEY?: string | undefined;
  S3_REGION?: string | undefined;
}

/** True for S3 "not found" errors across SDK/MinIO variants. */
function isNotFound(error: unknown): boolean {
  const e = error as { name?: string; $metadata?: { httpStatusCode?: number }; Code?: string };
  return (
    e?.name === 'NotFound' ||
    e?.name === 'NoSuchKey' ||
    e?.Code === 'NoSuchKey' ||
    e?.$metadata?.httpStatusCode === 404
  );
}

export function s3ArtifactStore(
  opts: ArtifactStoreOptions = {},
  env: S3StoreEnv = process.env,
): ArtifactStore {
  const bucket = opts.bucket ?? env.S3_BUCKET;
  if (!bucket) {
    throw new Error("artifact store 's3' requires opts.bucket or S3_BUCKET env");
  }
  const endpoint = opts.endpoint ?? env.S3_ENDPOINT;
  const prefix = opts.prefix ?? '';
  const client: S3ClientLike =
    opts.client ??
    new S3Client({
      region: env.S3_REGION ?? 'us-east-1',
      forcePathStyle: true, // MinIO-compatible
      ...(endpoint !== undefined ? { endpoint } : {}),
      credentials: {
        accessKeyId: env.S3_ACCESS_KEY ?? '',
        secretAccessKey: env.S3_SECRET_KEY ?? '',
      },
    } as S3ClientConfig);

  const fullKey = (key: string) => `${prefix}${key}`;

  return {
    async put(key, body) {
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: fullKey(key),
          // NodeJS.ReadableStream (spec type) is structurally wider than the
          // SDK's node Readable — runtime-compatible, so narrow via cast.
          Body: body as NonNullable<PutObjectCommandInput['Body']>,
        }),
      );
    },
    async getUrl(key) {
      // Path-style URL (matches forcePathStyle). Public-readability depends on
      // bucket policy; for the default AWS endpoint an s3:// URI is returned.
      if (endpoint) {
        return `${endpoint.replace(/\/$/, '')}/${bucket}/${fullKey(key)}`;
      }
      return `s3://${bucket}/${fullKey(key)}`;
    },
    async exists(key) {
      try {
        await client.send(new HeadObjectCommand({ Bucket: bucket, Key: fullKey(key) }));
        return true;
      } catch (error) {
        if (isNotFound(error)) return false;
        throw error;
      }
    },
  };
}
