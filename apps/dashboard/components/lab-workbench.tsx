'use client';
// THE WORKBENCH (2026-09-02) — the live artifact pane on the run page.
// The feed answers "what is it doing"; the bench answers "what do I have".
// Every file the worker holds is a tab; the spreadsheet renders as a real
// grid, the chart as the image, and when a file's CONTENT changes (sha
// moved on the polling DTO — a size-equal rewrite still counts) the tab
// flashes and the active view refetches. Nothing here is staged: the pane
// is a rendering of the same durable workspace record replay reads.
//
// Renderers stay lazy — SheetJS loads only when an xlsx tab is opened, so
// runs without spreadsheets never pay for it.
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CARD } from './lab-bench';
import {
  diffBenchFiles,
  elapsedLabel,
  orderBenchFiles,
  parseCsv,
  renderKindFor,
  type BenchFile,
} from '@/lib/workbench';

const EYEBROW = 'font-mono text-[12px] uppercase tracking-[0.13em] text-faint';
/** Past this many files the bench would be a tab soup — the tree-aware
 * FilesCard (repo runs) serves better; the console decides. */
export const BENCH_MAX_TABS = 16;

interface SheetGrid {
  sheets: Array<{ name: string; rows: string[][]; truncated: boolean }>;
}

type Rendered =
  | { kind: 'sheet'; grid: SheetGrid }
  | { kind: 'csv'; rows: string[][]; truncated: boolean }
  | { kind: 'image'; url: string }
  | { kind: 'text'; text: string; truncated: boolean }
  | { kind: 'binary' }
  | { kind: 'error'; message: string };

const TEXT_CAP = 20_000;
const GRID_ROW_CAP = 200;
/** A wide export (the operator's first real file: 2,636 rows x 158
 * columns) rendered whole is 31k table cells — enough to freeze the tab.
 * The bench is a PREVIEW; download is the full artifact. */
const GRID_COL_CAP = 24;

async function renderFile(runId: string, f: BenchFile): Promise<Rendered> {
  // EVERYTHING here can throw (a 3MB styles-heavy export took the first
  // real user file down) — and an unhandled rejection used to leave the
  // pane saying "loading…" forever. One catch, an honest error card.
  try {
    const kind = renderKindFor(f);
    if (kind === 'binary') return { kind: 'binary' };
    const res = await fetch(`/api/lab/runs/${runId}/files/${encodeURIComponent(f.name)}`);
    if (!res.ok) return { kind: 'error', message: `could not load (${res.status})` };
    if (kind === 'image') {
      const blob = await res.blob();
      return { kind: 'image', url: URL.createObjectURL(blob) };
    }
    if (kind === 'sheet') {
      const buf = await res.arrayBuffer();
      const XLSX = await import('xlsx');
      // sheetRows caps the PARSE, not just the render — a 2,636-row
      // workbook parses ~10x faster and bounded when only the preview's
      // rows are materialized.
      const wb = XLSX.read(buf, { type: 'array', sheetRows: GRID_ROW_CAP + 1 });
      const sheets = wb.SheetNames.map((name) => {
        const ws = wb.Sheets[name]!;
        const all = XLSX.utils.sheet_to_json<string[]>(ws, { header: 1, raw: false, defval: '' }) as string[][];
        return { name, rows: all.slice(0, GRID_ROW_CAP), truncated: all.length > GRID_ROW_CAP };
      });
      return { kind: 'sheet', grid: { sheets } };
    }
    const text = await res.text();
    if (kind === 'csv') {
      const { rows, truncated } = parseCsv(text, GRID_ROW_CAP);
      return { kind: 'csv', rows, truncated };
    }
    return { kind: 'text', text: text.slice(0, TEXT_CAP), truncated: text.length > TEXT_CAP };
  } catch (e) {
    return { kind: 'error', message: `could not render ${f.name}: ${e instanceof Error ? e.message : 'parse failed'} — use download` };
  }
}

const Grid = memo(function Grid({ rows, truncated }: { rows: string[][]; truncated: boolean }) {
  if (rows.length === 0) return <p className="py-4 font-mono text-[12px] text-faint">empty</p>;
  const wide = Math.max(...rows.map((r) => r.length)) > GRID_COL_CAP;
  const shown = wide ? rows.map((r) => r.slice(0, GRID_COL_CAP)) : rows;
  const header = shown[0]!;
  const notes = [
    ...(truncated ? [`first ${GRID_ROW_CAP} rows`] : []),
    ...(wide ? [`first ${GRID_COL_CAP} columns`] : []),
  ];
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse font-mono text-[12px]">
        <thead>
          <tr>
            {header.map((c, i) => (
              <th key={i} className="border border-line bg-[#f4f2ec] px-2 py-1 text-left font-medium text-soft">{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {shown.slice(1).map((r, ri) => (
            <tr key={ri}>
              {r.map((c, ci) => (
                <td key={ci} className="border border-line px-2 py-1 text-ink">{c}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {notes.length > 0 ? <p className="mt-1 font-mono text-[12px] text-faint">{notes.join(' · ')} — download for the rest</p> : null}
    </div>
  );
});

export function LabWorkbench({
  runId,
  files,
  live,
  nowTitle,
  nowAt,
}: {
  runId: string;
  files: BenchFile[];
  /** True while the run can still change the workspace. */
  live: boolean;
  /** The newest visible step's narrated title — the now-strip's verb. */
  nowTitle: string | null;
  nowAt: string | null;
}) {
  const ordered = useMemo(() => orderBenchFiles(files), [files]);
  const [active, setActive] = useState<string | null>(null);
  const [view, setView] = useState<Rendered | null>(null);
  const [sheetIdx, setSheetIdx] = useState(0);
  const [flash, setFlash] = useState<Set<string>>(new Set());
  const [versions, setVersions] = useState<Map<string, number>>(new Map());
  const [nowTick, setNowTick] = useState(Date.now());
  const shas = useRef<Map<string, string>>(new Map());

  const activeName = active ?? ordered[0]?.name ?? null;
  const activeFile = ordered.find((f) => f.name === activeName) ?? null;
  // THE STABLE KEY (2026-09-02, the operator's 3MB file): the render effect
  // must depend on CONTENT identity, not the object — the 1.5s poll
  // recreates the files array every tick, and an object-keyed effect
  // re-fired each tick, running the previous cleanup and marking the
  // in-flight render stale. Any file slower than one poll interval to
  // parse had its result silently DISCARDED — eternal "loading…". Small
  // files always won that race, so it looked like the bench worked.
  const activeKey = activeFile === null ? null : `${activeFile.name}:${activeFile.sha256}`;

  // Content-hash change detection over the polling DTO — flash changed
  // tabs, bump their observed version, refresh the open view.
  useEffect(() => {
    const { changed, added } = diffBenchFiles(shas.current, files);
    if (changed.length > 0 || added.length > 0) {
      setVersions((prev) => {
        const next = new Map(prev);
        for (const n of changed) next.set(n, (next.get(n) ?? 1) + 1);
        for (const n of added) next.set(n, next.get(n) ?? 1);
        return next;
      });
      if (changed.length > 0) {
        setFlash(new Set(changed));
        const t = setTimeout(() => setFlash(new Set()), 2500);
        for (const f of files) shas.current.set(f.name, f.sha256);
        return () => clearTimeout(t);
      }
    }
    for (const f of files) shas.current.set(f.name, f.sha256);
  }, [files]);

  // Render the active tab; re-runs ONLY when the content key moves (a tab
  // switch or a rewrite), so the poll can never invalidate an in-flight
  // render of unchanged content.
  const fileForKey = useRef(activeFile);
  fileForKey.current = activeFile;
  useEffect(() => {
    if (activeKey === null) return;
    const f = fileForKey.current;
    if (f === null) return;
    let stale = false;
    setSheetIdx(0);
    setView(null);
    void renderFile(runId, f).then((r) => {
      if (!stale) setView(r);
    });
    return () => { stale = true; };
  }, [runId, activeKey]);

  // The now-strip's elapsed clock.
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(t);
  }, [live]);

  // LIVE OUTPUT (Live views #2): while the run can still act, poll the
  // in-flight sandbox tail — a 90-second computation reads as WORK, line
  // by line, instead of silence then a wall. Ephemeral by design; the
  // durable step record lands in the feed when the call completes.
  const [liveOut, setLiveOut] = useState<{ toolName: string; tail: string } | null>(null);
  useEffect(() => {
    if (!live) {
      setLiveOut(null);
      return;
    }
    let stale = false;
    const poll = async () => {
      try {
        const res = await fetch(`/api/lab/runs/${runId}/live`);
        if (!res.ok || stale) return;
        const b = (await res.json()) as { idle?: boolean; toolName?: string; tail?: string };
        setLiveOut(b.idle === true || b.toolName === undefined ? null : { toolName: b.toolName, tail: b.tail ?? '' });
      } catch {
        /* the live view is a convenience */
      }
    };
    void poll();
    const t = setInterval(() => void poll(), 1500);
    return () => { stale = true; clearInterval(t); };
  }, [live, runId]);

  const pick = useCallback((name: string) => {
    // Same-tab re-picks change no key — leave the rendered view alone.
    setActive(name);
  }, []);

  if (ordered.length === 0) return null;

  return (
    <section className={`${CARD} mt-4 px-5 py-4`} data-testid="workbench">
      <div className="flex items-baseline justify-between gap-4">
        <div className={EYEBROW}>the bench · what the worker holds</div>
        {live && nowTitle !== null ? (
          <div className="flex items-center gap-2 font-mono text-[12px] text-soft" data-testid="now-strip">
            <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-accent" />
            {nowTitle}
            {/* elapsed since a live step — SSR's clock reading differs from
                hydration's; the 1s tick corrects it right after mount. */}
            {nowAt !== null ? <span className="text-faint" suppressHydrationWarning>{`· ${elapsedLabel(nowAt, nowTick)}`}</span> : null}
          </div>
        ) : null}
      </div>

      {liveOut !== null ? (
        <div className="mt-3 border border-[#2c2c2a] bg-[#1b1b19] px-3 py-2" data-testid="live-output">
          <div className="font-mono text-[11px] uppercase tracking-[0.12em] text-[#8a8a84]">
            {liveOut.toolName} · live output
          </div>
          <pre className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap font-mono text-[12px] leading-relaxed text-[#d6d4cc]">
            {liveOut.tail === '' ? '…' : liveOut.tail.split('\n').slice(-14).join('\n')}
          </pre>
        </div>
      ) : null}

      <div className="mt-3 flex flex-wrap gap-1.5" role="tablist">
        {ordered.map((f) => {
          const isActive = f.name === activeName;
          const v = versions.get(f.name) ?? 1;
          const flashing = flash.has(f.name);
          return (
            <button
              key={f.name}
              role="tab"
              aria-selected={isActive}
              onClick={() => pick(f.name)}
              className={`border px-2.5 py-1 font-mono text-[12px] transition-colors ${
                isActive ? 'border-[#c4bfb2] bg-white text-ink' : 'border-line text-soft hover:border-[#c4bfb2]'
              } ${flashing ? 'border-accent text-accent' : ''}`}
              data-testid={`bench-tab-${f.name}`}
            >
              {f.name === 'browser/screen.jpg' ? 'browser screen' : f.name.replace(/^deliverables\//, '')}
              {v > 1 ? <span className="ml-1.5 text-accent">v{v}</span> : null}
            </button>
          );
        })}
      </div>

      <div className="mt-3 max-h-[420px] overflow-y-auto border border-line bg-white p-3">
        {activeFile === null ? null : view === null ? (
          <p className="py-4 font-mono text-[12px] text-faint">loading {activeFile.name}…</p>
        ) : view.kind === 'sheet' ? (
          <div>
            {view.grid.sheets.length > 1 ? (
              <div className="mb-2 flex gap-3 font-mono text-[12px]">
                {view.grid.sheets.map((s, i) => (
                  <button
                    key={s.name}
                    onClick={() => setSheetIdx(i)}
                    className={i === sheetIdx ? 'border-b-2 border-[#a8a29e] pb-0.5 text-ink' : 'text-faint hover:text-soft'}
                  >
                    {s.name}
                  </button>
                ))}
              </div>
            ) : null}
            {view.grid.sheets[sheetIdx] !== undefined ? (
              <Grid rows={view.grid.sheets[sheetIdx]!.rows} truncated={view.grid.sheets[sheetIdx]!.truncated} />
            ) : null}
          </div>
        ) : view.kind === 'csv' ? (
          <Grid rows={view.rows} truncated={view.truncated} />
        ) : view.kind === 'image' ? (
          // next/image cannot take object URLs — the blob preview is a plain img
          <img src={view.url} alt={activeFile.name} className="max-w-full" />
        ) : view.kind === 'text' ? (
          <pre className="whitespace-pre-wrap font-mono text-[12px] leading-relaxed text-ink">
            {view.text}
            {view.truncated ? '\n… (download for the rest)' : ''}
          </pre>
        ) : view.kind === 'error' ? (
          <p className="py-4 font-mono text-[12px] text-warn">{view.message}</p>
        ) : (
          <p className="py-4 font-mono text-[12px] text-faint">binary file — use the download link</p>
        )}
      </div>

      {activeFile !== null ? (
        <div className="mt-2 flex items-center justify-between font-mono text-[12px] text-faint">
          <span>
            {activeFile.name} · {activeFile.size.toLocaleString('en-US')} bytes
            {(versions.get(activeFile.name) ?? 1) > 1 ? ` · rewritten ${(versions.get(activeFile.name) ?? 1) - 1}× while you watched` : ''}
          </span>
          <a
            href={`/api/lab/runs/${runId}/files/${encodeURIComponent(activeFile.name)}`}
            className="text-soft underline decoration-line underline-offset-2 hover:text-accent"
            download
          >
            download
          </a>
        </div>
      ) : null}
    </section>
  );
}
