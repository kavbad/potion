// X1 (2026-08-28) — the per-run file workspace. Code-produced files persist
// here across steps and legs (the sandbox itself is stateless per exec),
// and at completion they ARE the run's artifacts. Caps enforced HERE, not
// trusted from callers: per-file and per-run byte totals, and a file count
// ceiling — a workspace that cannot overflow quietly.
import { createHash } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import type { PotionDb } from '../db.js';
import { labRunFiles } from '../schema.js';

// X7 (2026-08-30): repo-scale quotas — the workspace went from sixteen
// flat files to a directory TREE (dev hands need a filesystem). Paths are
// validated HERE, at the storage boundary; the sandbox re-validates on its
// side (defense in depth, not trust).
export const RUN_FILE_LIMITS = {
  MAX_FILES: 400,
  MAX_FILE_BYTES: 8 * 1024 * 1024,
  MAX_TOTAL_BYTES: 64 * 1024 * 1024,
  MAX_PATH_CHARS: 240,
  MAX_PATH_SEGMENTS: 12,
} as const;

const SEGMENT_RE = /^[A-Za-z0-9._-]{1,120}$/;

/** Workspace paths: relative, '/'-separated trees. Dotfiles are allowed
 * (dev repos need .gitignore and friends); traversal ('.', '..'), '.git'
 * (commits leave through the governed PR gate, never as loose objects),
 * empty segments, and hostile charsets are not. */
export function validRunFilePath(name: string): { ok: true } | { ok: false; reason: string } {
  if (name.length === 0 || name.length > RUN_FILE_LIMITS.MAX_PATH_CHARS) {
    return { ok: false, reason: `path must be 1-${RUN_FILE_LIMITS.MAX_PATH_CHARS} chars` };
  }
  if (name.startsWith('/') || name.endsWith('/')) return { ok: false, reason: 'path must be relative (no leading/trailing slash)' };
  const segments = name.split('/');
  if (segments.length > RUN_FILE_LIMITS.MAX_PATH_SEGMENTS) {
    return { ok: false, reason: `at most ${RUN_FILE_LIMITS.MAX_PATH_SEGMENTS} path segments` };
  }
  for (const seg of segments) {
    if (seg === '.' || seg === '..') return { ok: false, reason: 'traversal segments are refused' };
    if (seg === '.git') return { ok: false, reason: "'.git' is refused — commits leave through the governed PR gate" };
    if (!SEGMENT_RE.test(seg)) return { ok: false, reason: `refused path segment '${seg.slice(0, 40)}'` };
  }
  return { ok: true };
}

export interface RunFileMeta {
  name: string;
  mime: string;
  size: number;
  sha256: string;
  updatedAt: Date;
}

const MIME_BY_EXT: Record<string, string> = {
  csv: 'text/csv',
  json: 'application/json',
  md: 'text/markdown',
  txt: 'text/plain',
  html: 'text/html',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

export function mimeForName(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  return MIME_BY_EXT[ext] ?? 'application/octet-stream';
}

export type UpsertRunFileResult =
  | { ok: true; meta: RunFileMeta }
  | { ok: false; reason: string };

export async function upsertLabRunFile(
  db: PotionDb,
  input: { orgId: string; runId: string; name: string; content: Buffer },
): Promise<UpsertRunFileResult> {
  const pathVerdict = validRunFilePath(input.name);
  if (!pathVerdict.ok) return { ok: false, reason: pathVerdict.reason };
  if (input.content.length > RUN_FILE_LIMITS.MAX_FILE_BYTES) {
    return { ok: false, reason: `'${input.name}' is ${input.content.length} bytes — the per-file cap is ${RUN_FILE_LIMITS.MAX_FILE_BYTES}` };
  }
  const existing = await listLabRunFiles(db, input.orgId, input.runId);
  const replacing = existing.find((f) => f.name === input.name);
  const count = existing.length + (replacing === undefined ? 1 : 0);
  if (count > RUN_FILE_LIMITS.MAX_FILES) {
    return { ok: false, reason: `the workspace holds ${existing.length} files — the cap is ${RUN_FILE_LIMITS.MAX_FILES}` };
  }
  const total =
    existing.reduce((a, f) => a + f.size, 0) - (replacing?.size ?? 0) + input.content.length;
  if (total > RUN_FILE_LIMITS.MAX_TOTAL_BYTES) {
    return { ok: false, reason: `the workspace would hold ${total} bytes — the cap is ${RUN_FILE_LIMITS.MAX_TOTAL_BYTES}` };
  }
  const sha = createHash('sha256').update(input.content).digest('hex');
  const mime = mimeForName(input.name);
  await db
    .insert(labRunFiles)
    .values({
      orgId: input.orgId,
      runId: input.runId,
      name: input.name,
      mime,
      size: input.content.length,
      sha256: sha,
      content: input.content,
    })
    .onConflictDoUpdate({
      target: [labRunFiles.orgId, labRunFiles.runId, labRunFiles.name],
      set: { mime, size: input.content.length, sha256: sha, content: input.content, updatedAt: sql`now()` },
    });
  return { ok: true, meta: { name: input.name, mime, size: input.content.length, sha256: sha, updatedAt: new Date() } };
}

export async function listLabRunFiles(db: PotionDb, orgId: string, runId: string): Promise<RunFileMeta[]> {
  const rows = await db
    .select({
      name: labRunFiles.name,
      mime: labRunFiles.mime,
      size: labRunFiles.size,
      sha256: labRunFiles.sha256,
      updatedAt: labRunFiles.updatedAt,
    })
    .from(labRunFiles)
    .where(and(eq(labRunFiles.orgId, orgId), eq(labRunFiles.runId, runId)))
    .orderBy(labRunFiles.name);
  return rows;
}

export async function getLabRunFile(
  db: PotionDb,
  orgId: string,
  runId: string,
  name: string,
): Promise<{ meta: RunFileMeta; content: Buffer } | null> {
  const rows = await db
    .select()
    .from(labRunFiles)
    .where(and(eq(labRunFiles.orgId, orgId), eq(labRunFiles.runId, runId), eq(labRunFiles.name, name)))
    .limit(1);
  const r = rows[0];
  if (!r) return null;
  return {
    meta: { name: r.name, mime: r.mime, size: r.size, sha256: r.sha256, updatedAt: r.updatedAt },
    content: Buffer.from(r.content),
  };
}
