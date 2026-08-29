// X1 — the code tool's laws: workspace round-trip, cap refusals surfaced as
// notes (never silent), key-shape redaction before context, sandbox errors
// as typed tool errors.
import { describe, expect, it } from 'vitest';
import { buildCodeLabTools, redactKeyShapes, type CodeWorkspace } from './code-tools.js';

function memWorkspace(seed: Record<string, Buffer> = {}, opts: { refuse?: string } = {}): CodeWorkspace & { store: Map<string, Buffer> } {
  const store = new Map(Object.entries(seed));
  return {
    store,
    list: async () => [...store.entries()].map(([name, b]) => ({ name, size: b.length })),
    read: async (name) => store.get(name) ?? null,
    write: async (name, content) => {
      if (opts.refuse === name) return { ok: false, reason: 'per-file cap' };
      store.set(name, content);
      return { ok: true };
    },
  };
}

function sandboxResponding(result: unknown, status = 200): typeof fetch {
  return (async (_url: unknown, init?: RequestInit) => {
    (sandboxResponding as unknown as { lastBody: unknown }).lastBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify(result), { status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
}

describe('run_python', () => {
  it('ships the workspace in, keeps produced files, reports the workspace after', async () => {
    const ws = memWorkspace({ 'in.csv': Buffer.from('a,b\n1,2\n') });
    const fetchImpl = sandboxResponding({
      exitCode: 0, stdout: 'done', stderr: '',
      files: [{ name: 'out.xlsx', size: 4, contentBase64: Buffer.from('XLSX').toString('base64') }],
    });
    const [tool] = buildCodeLabTools({ sandboxUrl: 'http://sb', workspace: ws, fetchImpl });
    const out = (await tool!.run({ code: 'print(1)' })) as { filesWritten: unknown[]; workspace: string[] };
    const sent = (sandboxResponding as unknown as { lastBody: { files: Array<{ name: string }> } }).lastBody;
    expect(sent.files[0]!.name).toBe('in.csv');
    expect(out.filesWritten).toEqual([{ name: 'out.xlsx', size: 4 }]);
    expect(ws.store.has('out.xlsx')).toBe(true);
    expect(out.workspace.join(' ')).toContain('out.xlsx');
  });

  it('a cap refusal becomes a NOTE, never a silent drop', async () => {
    const ws = memWorkspace({}, { refuse: 'big.bin' });
    const fetchImpl = sandboxResponding({
      exitCode: 0, stdout: '', stderr: '',
      files: [{ name: 'big.bin', size: 3, contentBase64: Buffer.from('abc').toString('base64') }],
    });
    const [tool] = buildCodeLabTools({ sandboxUrl: 'http://sb', workspace: ws, fetchImpl });
    const out = (await tool!.run({ code: 'x' })) as { notes?: string[] };
    expect(out.notes?.[0]).toContain('big.bin');
    expect(out.notes?.[0]).toContain('per-file cap');
  });

  it('key-shaped stdout is redacted before it enters context', async () => {
    const fetchImpl = sandboxResponding({ exitCode: 0, stdout: `token sk-${'a'.repeat(40)} leaked`, stderr: '' });
    const [tool] = buildCodeLabTools({ sandboxUrl: 'http://sb', workspace: memWorkspace(), fetchImpl });
    const out = (await tool!.run({ code: 'x' })) as { stdout: string };
    expect(out.stdout).toContain('••redacted-key-shape••');
    expect(out.stdout).not.toContain('sk-aaaa');
  });

  it('sandbox errors surface as typed tool errors', async () => {
    const fetchImpl = sandboxResponding({ error: 'code exceeds 262144 bytes' }, 400);
    const [tool] = buildCodeLabTools({ sandboxUrl: 'http://sb', workspace: memWorkspace(), fetchImpl });
    const out = (await tool!.run({ code: 'x' })) as { error: string };
    expect(out.error).toContain('exceeds');
  });
});

describe('redactKeyShapes', () => {
  it('covers the conservative families and leaves prose alone', () => {
    expect(redactKeyShapes('AKIAABCDEFGHIJKLMNOP is an aws key')).toContain('••redacted-key-shape••');
    expect(redactKeyShapes('plain text with numbers 12345')).toBe('plain text with numbers 12345');
  });
});
