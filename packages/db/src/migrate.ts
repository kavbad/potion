// Migration runner (SPEC §7): executes the SQL files under packages/db/drizzle/
// in lexical order. Files use drizzle-kit's `--> statement-breakpoint`
// separator; every statement is idempotent (CREATE ... IF NOT EXISTS) so boot
// can safely re-run them.
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import type { PotionDb } from './db.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../drizzle', import.meta.url));

export function listMigrationFiles(dir: string = MIGRATIONS_DIR): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

export function splitStatements(sqlText: string): string[] {
  return sqlText
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !/^(--[^\n]*\n?)*$/.test(s));
}

export async function migrate(db: PotionDb): Promise<string[]> {
  const applied: string[] = [];
  for (const file of listMigrationFiles()) {
    const text = readFileSync(`${MIGRATIONS_DIR}/${file}`, 'utf8');
    for (const statement of splitStatements(text)) {
      await db.execute(sql.raw(statement));
    }
    applied.push(file);
  }
  return applied;
}
