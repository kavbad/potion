// X1 (2026-08-28) — the `code` builtin superpower: run Python in the Potion
// sandbox with a DURABLE per-run file workspace. The sandbox is stateless
// per exec; persistence lives on the run (packages/db lab_run_files), so a
// file written in step 3 is there in step 7 and is a downloadable artifact
// at the end. Isolation is layered and stated honestly: the sandbox
// container sits on an internal-only network with no egress, runs non-root,
// and caps CPU/memory/time per exec — container isolation, not VM-grade
// multi-tenancy. `external: false` is truthful BECAUSE of the no-egress
// law: executing code that cannot reach the world is thinking, not acting.
import type { LabTool } from './loop.js';
import { clearLiveOutput, setLiveOutput } from './live-output.js';

export interface CodeWorkspace {
  list(): Promise<Array<{ name: string; size: number }>>;
  read(name: string): Promise<Buffer | null>;
  write(name: string, content: Buffer): Promise<{ ok: true } | { ok: false; reason: string }>;
}

export interface CodeToolDeps {
  sandboxUrl: string;
  workspace: CodeWorkspace;
  /** Injected for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** LIVE OUTPUT (2026-09-02): when set, in-flight sandbox stdout/stderr
   * is tailed into the live-output store under this run id so the run
   * page's now-strip can show a long computation as work, not silence.
   * The durable record is untouched — the completed step is the truth. */
  liveRunId?: string;
}

export const CODE_LIMITS = {
  EXEC_TIMEOUT_MS: 150_000, // client-side backstop over the sandbox's own wall clock
  MAX_STREAM_CHARS: 20_000, // what enters model context, further clipped from the sandbox's cap
} as const;

/** Key-shaped content is REDACTED from streams before they enter model
 * context (custody at the tool boundary). Redaction, not refusal: code that
 * prints entropy is common; code that prints a live credential must not
 * teach it to the model or the transcript. Conservative patterns only. */
export function redactKeyShapes(text: string): string {
  return text
    .replace(/\b(?:sk|pk|ghp|gho|ghs|glpat|xox[abps])[-_][A-Za-z0-9_-]{16,}\b/g, '••redacted-key-shape••')
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, '••redacted-key-shape••')
    .replace(/\bAIza[0-9A-Za-z_-]{35}\b/g, '••redacted-key-shape••')
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '••redacted-private-key••');
}

function clip(text: string): string {
  return text.length > CODE_LIMITS.MAX_STREAM_CHARS
    ? `${text.slice(0, CODE_LIMITS.MAX_STREAM_CHARS)}\n…[truncated for context at ${CODE_LIMITS.MAX_STREAM_CHARS} chars]`
    : text;
}

interface SandboxResult {
  exitCode?: number;
  timedOut?: boolean;
  stdout?: string;
  stderr?: string;
  files?: Array<{ name: string; size: number; contentBase64: string }>;
  error?: string;
}

export function buildCodeLabTools(deps: CodeToolDeps): LabTool[] {
  const fetchFn = deps.fetchImpl ?? fetch;
  // Shared executor for both sandbox tools: ship the whole workspace tree
  // in, run under the same rlimits + wall clock + no-egress law, collect
  // the produced tree back under the storage quotas.
  const execInSandbox = async (mode: 'python' | 'shell', code: string, timeoutSeconds?: number): Promise<unknown> => {
    const existing = await deps.workspace.list();
    const files: Array<{ name: string; contentBase64: string }> = [];
    for (const f of existing) {
      const content = await deps.workspace.read(f.name);
      if (content !== null) files.push({ name: f.name, contentBase64: content.toString('base64') });
    }
    // LIVE OUTPUT: tail the in-flight exec into the store every second.
    // Best-effort by design — a failed tail poll changes nothing about the
    // call, and the store entry dies in the finally either way.
    const execId = deps.liveRunId !== undefined ? `x${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}` : undefined;
    let liveTimer: ReturnType<typeof setInterval> | undefined;
    if (deps.liveRunId !== undefined && execId !== undefined) {
      const runId = deps.liveRunId;
      const startedAt = Date.now();
      const toolName = mode === 'python' ? 'run_python' : 'run_shell';
      setLiveOutput(runId, { toolName, startedAt, tail: '' });
      liveTimer = setInterval(() => {
        void (async () => {
          try {
            const r = await fetchFn(`${deps.sandboxUrl}/tail/${execId}`);
            if (!r.ok) return;
            const t = (await r.json()) as { stdout?: string; stderr?: string };
            const tail = `${t.stdout ?? ''}${t.stderr ? `\n${t.stderr}` : ''}`.slice(-4000);
            setLiveOutput(runId, { toolName, startedAt, tail: redactKeyShapes(tail) });
          } catch {
            /* the live view is a convenience; the call is the truth */
          }
        })();
      }, 1000);
    }
    try {
      let res: Response;
      try {
        const ac = new AbortController();
        const t = setTimeout(() => ac.abort(), CODE_LIMITS.EXEC_TIMEOUT_MS);
        try {
          res = await fetchFn(`${deps.sandboxUrl}/exec`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              mode,
              code,
              ...(typeof timeoutSeconds === 'number' ? { timeoutSeconds } : {}),
              ...(execId !== undefined ? { execId } : {}),
              files,
            }),
            signal: ac.signal,
          });
        } finally {
          clearTimeout(t);
        }
      } catch (e) {
        return { error: `sandbox unreachable: ${e instanceof Error ? e.message : String(e)}` };
      }
      const body = (await res.json().catch(() => null)) as SandboxResult | null;
      if (body === null) return { error: `sandbox returned unparseable output (HTTP ${res.status})` };
      if (body.error !== undefined) return { error: body.error };

      const kept: Array<{ name: string; size: number }> = [];
      const notes: string[] = [];
      for (const f of body.files ?? []) {
        const content = Buffer.from(f.contentBase64, 'base64');
        const wrote = await deps.workspace.write(f.name, content);
        if (wrote.ok) kept.push({ name: f.name, size: content.length });
        else notes.push(`'${f.name}' not kept: ${wrote.reason}`);
      }
      const workspaceNow = await deps.workspace.list();
      return {
        exitCode: body.exitCode ?? -1,
        timedOut: body.timedOut === true,
        stdout: clip(redactKeyShapes(body.stdout ?? '')),
        stderr: clip(redactKeyShapes(body.stderr ?? '')),
        filesWritten: kept,
        workspace: workspaceNow.map((w) => `${w.name} (${w.size} bytes)`),
        ...(notes.length > 0 ? { notes } : {}),
      };
    } finally {
      // The live view dies with the call, whatever the call became.
      if (liveTimer !== undefined) clearInterval(liveTimer);
      if (deps.liveRunId !== undefined) clearLiveOutput(deps.liveRunId);
    }
  };
  return [
    {
      name: 'run_python',
      description:
        'Run Python 3.12 in the Potion sandbox (pandas, numpy, openpyxl, matplotlib; no network). ' +
        'FRESH PROCESS each call — no variable or import survives from a previous call; only FILES in the working ' +
        'directory persist (existing workspace files are placed there first; files you write are kept for later ' +
        'calls and delivered as artifacts). Do the whole job in one call when you can, or write intermediate data ' +
        'to a file and reload it. Print what you need to see; write real deliverables (csv, xlsx, png, md) as files.',
      parameters: {
        type: 'object',
        properties: {
          code: { type: 'string', description: 'The Python source to execute.' },
          timeoutSeconds: { type: 'number', description: 'Wall-clock limit, 1–120 (default 30).' },
        },
        required: ['code'],
      },
      external: false,
      run: async (input: unknown): Promise<unknown> => {
        const args = (input ?? {}) as { code?: unknown; timeoutSeconds?: unknown };
        if (typeof args.code !== 'string' || args.code.trim() === '') {
          return { error: 'code (a non-empty string) is required' };
        }
        return execInSandbox('python', args.code, typeof args.timeoutSeconds === 'number' ? args.timeoutSeconds : undefined);
      },
    },
    {
      name: 'run_shell',
      // X7: THE SEALED SHELL. external:false is truthful for the same
      // reason run_python's is: the no-egress network law means this
      // terminal provably cannot phone home — a shell that cannot reach
      // the world is thinking, not acting.
      description:
        'Run a bash script in the Potion sandbox (git, node, python available; NO network). ' +
        'FRESH PROCESS each call — nothing survives except FILES in the working directory (the whole workspace tree ' +
        'is placed there first; files you write are kept). Use it to run tests, inspect the tree, and do local git ' +
        'operations on fetched repos.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The shell script to execute (bash).' },
          timeoutSeconds: { type: 'number', description: 'Wall-clock limit, 1–120 (default 30).' },
        },
        required: ['command'],
      },
      external: false,
      run: async (input: unknown): Promise<unknown> => {
        const args = (input ?? {}) as { command?: unknown; timeoutSeconds?: unknown };
        if (typeof args.command !== 'string' || args.command.trim() === '') {
          return { error: 'command (a non-empty string) is required' };
        }
        return execInSandbox('shell', args.command, typeof args.timeoutSeconds === 'number' ? args.timeoutSeconds : undefined);
      },
    },
  ];
}
