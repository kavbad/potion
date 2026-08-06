// Artifact store tests (SPEC §12.2): local round-trip against a tmp dir;
// s3 against a hand-stubbed client (no network, no MinIO container).
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { afterEach, describe, expect, it } from 'vitest';
import { createArtifactStore } from './index.js';
import type { S3ClientLike } from './s3.js';

const tmpDirs: string[] = [];
function tmpDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'potion-artifacts-'));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

describe('local artifact store', () => {
  it('put/getUrl/exists round-trip with Buffer', async () => {
    const dir = tmpDir();
    const store = createArtifactStore('local', { dir });
    const key = 'eval/run-abc.json';
    expect(await store.exists(key)).toBe(false);
    await store.put(key, Buffer.from(JSON.stringify({ ok: true })));
    expect(await store.exists(key)).toBe(true);
    const url = await store.getUrl(key);
    expect(url.startsWith('file://')).toBe(true);
    expect(url).toContain(dir);
    const content = JSON.parse(readFileSync(path.join(dir, key), 'utf8'));
    expect(content).toEqual({ ok: true });
  });

  it('put accepts a Readable stream and applies prefix', async () => {
    const dir = tmpDir();
    const store = createArtifactStore('local', { dir, prefix: 'sweeps/' });
    await store.put('s1.json', Readable.from([Buffer.from('{"a":1}')]));
    expect(readFileSync(path.join(dir, 'sweeps', 's1.json'), 'utf8')).toBe('{"a":1}');
    expect(await store.exists('s1.json')).toBe(true);
  });

  it('rejects keys that escape the artifact dir', async () => {
    const store = createArtifactStore('local', { dir: tmpDir() });
    await expect(store.put('../evil.json', Buffer.from('x'))).rejects.toThrow(/escapes|relative/);
    await expect(store.exists('/abs/path.json')).rejects.toThrow(/relative/);
  });
});

describe('s3 artifact store (stubbed client)', () => {
  /** Hand stub: records sends; emulates HeadObject over an in-memory map. */
  function stubClient() {
    const objects = new Map<string, unknown>();
    const sent: unknown[] = [];
    const client: S3ClientLike = {
      async send(command: unknown) {
        sent.push(command);
        if (command instanceof PutObjectCommand) {
          objects.set(String(command.input.Key), command.input.Body);
          return { ETag: '"stub"' };
        }
        if (command instanceof HeadObjectCommand) {
          if (!objects.has(String(command.input.Key))) {
            const err = new Error('NotFound') as Error & { name: string };
            err.name = 'NotFound';
            throw err;
          }
          return { ContentLength: 1 };
        }
        throw new Error('unexpected command');
      },
    };
    return { client, sent, objects };
  }

  it('put/exists/getUrl round-trip via stub, env-driven config', async () => {
    const { client, sent } = stubClient();
    // env provides endpoint/bucket (as in docker-compose minio) and is read at
    // construction; opts.bucket/opts.endpoint would override it.
    process.env.S3_ENDPOINT = 'http://localhost:9000';
    process.env.S3_BUCKET = 'potion-artifacts';
    try {
      const store = createArtifactStore('s3', { client });
      await store.put('run-1.json', Buffer.from('{"runId":"run-1"}'));
      expect(await store.exists('run-1.json')).toBe(true);
      expect(await store.exists('missing.json')).toBe(false);
      expect(await store.getUrl('run-1.json')).toBe(
        'http://localhost:9000/potion-artifacts/run-1.json',
      );
    } finally {
      delete process.env.S3_ENDPOINT;
      delete process.env.S3_BUCKET;
    }
    const put = sent.find((c) => c instanceof PutObjectCommand) as PutObjectCommand;
    expect(put.input.Bucket).toBe('potion-artifacts');
    expect(put.input.Key).toBe('run-1.json');
  });

  it('prefix is applied to keys; missing bucket is a typed config error', async () => {
    const { client, sent } = stubClient();
    const store = createArtifactStore('s3', {
      client,
      bucket: 'b',
      endpoint: 'http://minio:9000/',
      prefix: 'p/',
    });
    await store.put('k.json', Buffer.from('x'));
    const put = sent[0] as PutObjectCommand;
    expect(put.input.Key).toBe('p/k.json');
    expect(await store.getUrl('k.json')).toBe('http://minio:9000/b/p/k.json');
    const savedBucket = process.env.S3_BUCKET;
    delete process.env.S3_BUCKET;
    try {
      expect(() => createArtifactStore('s3', { client })).toThrow(/S3_BUCKET|bucket/);
    } finally {
      if (savedBucket !== undefined) process.env.S3_BUCKET = savedBucket;
    }
  });
});
