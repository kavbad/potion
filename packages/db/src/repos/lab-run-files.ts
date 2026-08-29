// X1 (2026-08-28) — the per-run file workspace. Code-produced files persist
// here across steps and legs (the sandbox itself is stateless per exec),
// and at completion they ARE the run's artifacts. Caps enforced HERE, not
// trusted from callers: per-file and per-run byte totals, and a file count
// ceiling — a workspace that cannot overflow quietly.
import { createHash } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import type { PotionDb } from '../db.js';
import { labRunFiles } from '../schema.js';

export const RUN_FILE_LIMITS = {
  MAX_FILES: 16,
  MAX_FILE_BYTES: 8 * 1024 * 1024,
  MAX_TOTAL_BYTES: 20 * 1024 * 1024,
} as const;

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
