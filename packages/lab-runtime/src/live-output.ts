// LIVE OUTPUT (2026-09-02, Live views #2) — the ephemeral now of a running
// sandbox call, keyed by runId. The durable record stays the completed tool
// step; this map exists so the run page can show a long computation as
// WORK instead of silence. In-process only (the lab worker and the API
// routes share one process); entries die with their call, and a stale
// entry can never outlive its run by more than the sweep below.

export interface LiveOutput {
  toolName: string;
  startedAt: number;
  /** Combined stdout+stderr tail, already capped by the sandbox. */
  tail: string;
}

const store = new Map<string, LiveOutput>();
/** Backstop against a leaked entry (a crashed leg mid-call): reads ignore
 * anything older than this, and writes sweep it. */
const STALE_MS = 5 * 60_000;

export function setLiveOutput(runId: string, v: LiveOutput): void {
  for (const [k, e] of store) if (Date.now() - e.startedAt > STALE_MS) store.delete(k);
  store.set(runId, v);
}

export function clearLiveOutput(runId: string): void {
  store.delete(runId);
}

export function getLiveOutput(runId: string): LiveOutput | null {
  const e = store.get(runId) ?? null;
  if (e === null || Date.now() - e.startedAt > STALE_MS) return null;
  return e;
}
