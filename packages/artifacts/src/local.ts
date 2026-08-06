// Local-directory artifact store: keys map to files under a root dir.
// Keys are sanitized — no absolute paths, no '..' escapes, no backslashes.
import { createWriteStream } from 'node:fs';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import type { ArtifactStore } from './index.js';

/** Resolve a key to a path INSIDE root, or throw on traversal attempts. */
export function safeKeyPath(root: string, key: string): string {
  if (key.length === 0) throw new Error('artifact key must not be empty');
  if (path.isAbsolute(key) || key.includes('\\')) {
    throw new Error(`artifact key '${key}' must be a relative posix-style path`);
  }
  const resolved = path.resolve(root, key);
  const rel = path.relative(root, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`artifact key '${key}' escapes the artifact dir`);
  }
  return resolved;
}

export function localArtifactStore(opts: { dir?: string; prefix?: string } = {}): ArtifactStore {
  const root = path.resolve(opts.dir ?? './artifacts');
  const prefix = opts.prefix ?? '';
  const pathFor = (key: string) => safeKeyPath(root, `${prefix}${key}`);
  return {
    async put(key, body) {
      const filePath = pathFor(key);
      await mkdir(path.dirname(filePath), { recursive: true });
      if (Buffer.isBuffer(body)) {
        await writeFile(filePath, body);
      } else {
        await pipeline(body, createWriteStream(filePath));
      }
    },
    async getUrl(key) {
      return `file://${pathFor(key)}`;
    },
    async exists(key) {
      try {
        await access(pathFor(key));
        return true;
      } catch (error) {
        // Traversal/config errors are loud; only a genuine miss is false.
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
      }
    },
  };
}
