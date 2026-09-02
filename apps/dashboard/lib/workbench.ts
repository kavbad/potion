// THE WORKBENCH (2026-09-02) — pure helpers for the live artifact pane on
// the run page. The bench renders the run's workspace AS IT CHANGES: every
// judgment here derives from the polling DTO's own fields (name, mime,
// size, sha256) — the same durable record replay reads, so the pane can
// never claim progress the record doesn't hold.

export interface BenchFile {
  name: string;
  mime: string;
  size: number;
  sha256: string;
}

export type BenchRenderKind = 'sheet' | 'csv' | 'image' | 'text' | 'binary';

/** How to render a workspace file, by extension first (the sandbox writes
 * real extensions), mime as the fallback. */
export function renderKindFor(f: { name: string; mime: string }): BenchRenderKind {
  const ext = f.name.toLowerCase().split('.').pop() ?? '';
  if (ext === 'xlsx' || ext === 'xls') return 'sheet';
  if (ext === 'csv' || ext === 'tsv') return 'csv';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext)) return 'image';
  if (['txt', 'md', 'json', 'log', 'yml', 'yaml', 'toml', 'html', 'py', 'sh', 'js', 'ts'].includes(ext)) return 'text';
  if (f.mime.startsWith('image/')) return 'image';
  if (f.mime.startsWith('text/') || f.mime === 'application/json') return 'text';
  return 'binary';
}

/** Tab order: the run's MADE artifacts lead (deliverables/ first, then
 * other roots), inputs and deep trees trail. Alphabetical within a band. */
export function orderBenchFiles<T extends { name: string }>(files: readonly T[]): T[] {
  const band = (n: string): number => {
    if (n.startsWith('deliverables/')) return 0;
    if (!n.includes('/')) return 1;
    return 2;
  };
  return [...files].sort((a, b) => band(a.name) - band(b.name) || a.name.localeCompare(b.name));
}

export interface BenchChange {
  /** Names whose CONTENT changed since the previous poll (sha moved). */
  changed: string[];
  /** Names that appeared this poll. */
  added: string[];
}

/** Diff two polls of the files DTO by content hash — a size-equal rewrite
 * still counts (the sandbox collection lesson: names lie, content doesn't). */
export function diffBenchFiles(
  prev: ReadonlyMap<string, string>,
  now: readonly BenchFile[],
): BenchChange {
  const changed: string[] = [];
  const added: string[] = [];
  for (const f of now) {
    const before = prev.get(f.name);
    if (before === undefined) added.push(f.name);
    else if (before !== f.sha256) changed.push(f.name);
  }
  return { changed, added };
}

/** Parse CSV/TSV with quote handling — enough for the sandbox's own
 * outputs, capped so a huge file never freezes the pane. */
export function parseCsv(text: string, maxRows = 200): { rows: string[][]; truncated: boolean } {
  const delim = text.includes('\t') && !text.split('\n', 2)[0]?.includes(',') ? '\t' : ',';
  const rows: string[][] = [];
  let cell = '';
  let row: string[] = [];
  let quoted = false;
  let truncated = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; }
        else quoted = false;
      } else cell += ch;
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === delim) {
      row.push(cell); cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((c) => c !== '')) rows.push(row);
      row = [];
      if (rows.length >= maxRows) { truncated = true; break; }
    } else cell += ch;
  }
  if (!truncated && (cell !== '' || row.length > 0)) {
    row.push(cell);
    if (row.some((c) => c !== '')) rows.push(row);
  }
  return { rows, truncated };
}

/** "0:14"-style elapsed clock for the now-strip. */
export function elapsedLabel(fromIso: string, now: number): string {
  const s = Math.max(0, Math.floor((now - new Date(fromIso).getTime()) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
