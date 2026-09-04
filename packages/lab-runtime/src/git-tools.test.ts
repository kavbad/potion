// X7 — the governed git's laws at the tool layer (scripted GitHub; the
// live path lights up with the org's github grant):
//   · repo_fetch is a READ; github_pr is an ACT (external: true) — THE law;
//   · tarballs unpack under repo/ through the storage quotas; special
//     entries are skipped and counted;
//   · the PR choreography commits exactly the named files and refuses
//     typed without a grant;
//   · hostile inputs (bad repo strings, bad branch names) refuse typed.
import { describe, expect, it } from 'vitest';
import { gzipSync } from 'node:zlib';
import { buildGitLabTools, parseRepoInput, readTarEntries, GIT_LIMITS } from './git-tools.js';
import type { CodeWorkspace } from './code-tools.js';

function tarOf(entries: Array<{ path: string; content?: string; type?: string }>): Buffer {
  const blocks: Buffer[] = [];
  for (const e of entries) {
    const content = Buffer.from(e.content ?? '', 'utf8');
    const header = Buffer.alloc(512);
    header.write(e.path, 0, 'utf8');
    header.write('0000644\0', 100, 'utf8');
    header.write('0000000\0', 108, 'utf8');
    header.write('0000000\0', 116, 'utf8');
    header.write(`${content.length.toString(8).padStart(11, '0')}\0`, 124, 'utf8');
    header.write('00000000000\0', 136, 'utf8');
    header.write('        ', 148, 'utf8'); // checksum spaces
    header.write(e.type ?? '0', 156, 'utf8');
    header.write('ustar\0', 257, 'utf8');
    let sum = 0;
    for (const b of header) sum += b;
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'utf8');
    blocks.push(header);
    if ((e.type ?? '0') === '0' && content.length > 0) {
      const padded = Buffer.alloc(Math.ceil(content.length / 512) * 512);
      content.copy(padded);
      blocks.push(padded);
    }
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

function memWorkspace(): CodeWorkspace & { files: Map<string, Buffer> } {
  const files = new Map<string, Buffer>();
  return {
    files,
    list: async () => [...files.entries()].map(([name, c]) => ({ name, size: c.length })),
    read: async (name) => files.get(name) ?? null,
    write: async (name, content) => {
      files.set(name, content);
      return { ok: true };
    },
  };
}

describe('parseRepoInput', () => {
  it('accepts owner/name and github URLs; refuses garbage', () => {
    expect(parseRepoInput('acme/api')).toEqual({ owner: 'acme', repo: 'api' });
    expect(parseRepoInput('https://github.com/acme/api')).toEqual({ owner: 'acme', repo: 'api' });
    expect(parseRepoInput('https://github.com/acme/api.git')).toEqual({ owner: 'acme', repo: 'api' });
    expect(parseRepoInput('https://github.com/acme/api/tree/main/src')).toEqual({ owner: 'acme', repo: 'api' });
    expect(parseRepoInput('https://evil.example/acme/api')).toBeNull();
    expect(parseRepoInput('acme/api/extra')).toBeNull();
    expect(parseRepoInput('../../etc')).toBeNull();
  });
});

describe('readTarEntries', () => {
  it('reads regular files, skips symlinks/devices, tolerates dirs', () => {
    const tar = tarOf([
      { path: 'api-main/', type: '5' },
      { path: 'api-main/src/index.js', content: 'console.log(1)\n' },
      { path: 'api-main/evil', type: '2' }, // symlink
      { path: 'api-main/.gitignore', content: 'node_modules\n' },
    ]);
    const { files, skipped } = readTarEntries(tar);
    expect(files.map((f) => f.path)).toEqual(['api-main/src/index.js', 'api-main/.gitignore']);
    expect(files[0]!.content.toString()).toBe('console.log(1)\n');
    expect(skipped).toBe(1);
  });
});

describe('the law', () => {
  it('repo_fetch is a read; github_pr is an act', () => {
    const tools = buildGitLabTools({ workspace: memWorkspace(), githubToken: async () => null });
    const byName = new Map(tools.map((t) => [t.name, t]));
    expect(byName.get('repo_fetch')!.external).toBe(false);
    expect(byName.get('github_pr')!.external).toBe(true);
  });
});

describe('repo_fetch', () => {
  it('unpacks the tarball under repo/ with the top directory stripped', async () => {
    const tgz = gzipSync(tarOf([
      { path: 'api-abc123/', type: '5' },
      { path: 'api-abc123/src/index.js', content: 'ok\n' },
      { path: 'api-abc123/README.md', content: '# api\n' },
    ]));
    const ws = memWorkspace();
    const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
      expect(String(input)).toBe('https://codeload.github.com/acme/api/tar.gz/main');
      return new Response(new Uint8Array(tgz), { status: 200 });
    }) as typeof fetch;
    const tools = buildGitLabTools({ workspace: ws, githubToken: async () => null, fetchImpl });
    const res = (await tools[0]!.run({ repo: 'acme/api', ref: 'main' })) as { ok: boolean; filesWritten: number };
    expect(res.ok).toBe(true);
    expect(res.filesWritten).toBe(2);
    expect([...ws.files.keys()].sort()).toEqual(['repo/README.md', 'repo/src/index.js']);
  });

  it('a 404 without a grant explains the private-repo path', async () => {
    const fetchImpl = (async () => new Response('', { status: 404 })) as typeof fetch;
    const tools = buildGitLabTools({ workspace: memWorkspace(), githubToken: async () => null, fetchImpl });
    const res = (await tools[0]!.run({ repo: 'acme/secret' })) as { error: string };
    expect(res.error).toContain('connect GitHub');
  });

  it('a grant token rides the fetch as Authorization', async () => {
    let auth: string | null = null;
    const tgz = gzipSync(tarOf([{ path: 'x-1/a.txt', content: 'x' }]));
    const fetchImpl = (async (_i: Parameters<typeof fetch>[0], init?: RequestInit) => {
      auth = (init?.headers as Record<string, string>)?.authorization ?? null;
      return new Response(new Uint8Array(tgz), { status: 200 });
    }) as typeof fetch;
    const tools = buildGitLabTools({ workspace: memWorkspace(), githubToken: async () => 'gho_customtoken12345678', fetchImpl });
    await tools[0]!.run({ repo: 'acme/x' });
    expect(auth).toBe('Bearer gho_customtoken12345678');
  });
});

describe('github_pr', () => {
  it('refuses typed without a grant — nothing leaves', async () => {
    const tools = buildGitLabTools({ workspace: memWorkspace(), githubToken: async () => null });
    const res = (await tools[1]!.run({ repo: 'acme/api', branch: 'b', title: 't', paths: ['repo/a.txt'] })) as { error: string };
    expect(res.error).toContain('GitHub is not connected');
  });

  it('runs the choreography: base ref → branch → contents per file → PR', async () => {
    const ws = memWorkspace();
    ws.files.set('repo/src/index.js', Buffer.from('fixed\n'));
    const seen: string[] = [];
    const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(input);
      seen.push(`${init?.method ?? 'GET'} ${url.replace('https://api.github.com', '')}`);
      if (url.endsWith('/repos/acme/api')) return new Response(JSON.stringify({ default_branch: 'main' }), { status: 200 });
      if (url.includes('/git/ref/heads/main')) return new Response(JSON.stringify({ object: { sha: 'basesha' } }), { status: 200 });
      if (url.endsWith('/git/refs')) return new Response(JSON.stringify({}), { status: 201 });
      if (url.includes('/contents/src/index.js?ref=')) return new Response(JSON.stringify({ sha: 'oldsha' }), { status: 200 });
      if (url.includes('/contents/src/index.js')) {
        const body = JSON.parse(String(init?.body)) as { branch: string; sha?: string };
        expect(body.branch).toBe('potion/fix');
        expect(body.sha).toBe('oldsha');
        return new Response(JSON.stringify({}), { status: 200 });
      }
      if (url.endsWith('/pulls')) return new Response(JSON.stringify({ html_url: 'https://github.com/acme/api/pull/7', number: 7 }), { status: 201 });
      return new Response(JSON.stringify({}), { status: 500 });
    }) as typeof fetch;
    const tools = buildGitLabTools({ workspace: ws, githubToken: async () => 'gho_tok1234567890abcd', fetchImpl });
    const res = (await tools[1]!.run({ repo: 'acme/api', branch: 'potion/fix', title: 'Fix tests', paths: ['repo/src/index.js'] })) as { ok: boolean; prNumber: number; filesCommitted: string[] };
    expect(res.ok).toBe(true);
    expect(res.prNumber).toBe(7);
    expect(res.filesCommitted).toEqual(['src/index.js']);
    expect(seen.some((x) => x.startsWith('POST') && x.endsWith('/pulls'))).toBe(true);
  });

  it('a missing workspace file aborts before anything is committed for it', async () => {
    const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.endsWith('/repos/acme/api')) return new Response(JSON.stringify({ default_branch: 'main' }), { status: 200 });
      if (url.includes('/git/ref/')) return new Response(JSON.stringify({ object: { sha: 's' } }), { status: 200 });
      if (url.endsWith('/git/refs')) return new Response(JSON.stringify({}), { status: 201 });
      return new Response(JSON.stringify({}), { status: 500 });
    }) as typeof fetch;
    const tools = buildGitLabTools({ workspace: memWorkspace(), githubToken: async () => 'gho_tok1234567890abcd', fetchImpl });
    const res = (await tools[1]!.run({ repo: 'acme/api', branch: 'b', title: 't', paths: ['repo/nope.txt'] })) as { error: string };
    expect(res.error).toContain("'repo/nope.txt' does not exist");
  });

  it('caps and hostile branch names refuse typed', async () => {
    const tools = buildGitLabTools({ workspace: memWorkspace(), githubToken: async () => 'gho_tok1234567890abcd' });
    expect(((await tools[1]!.run({ repo: 'acme/api', branch: 'b', title: 't', paths: [] })) as { error: string }).error).toContain(`1-${GIT_LIMITS.MAX_PR_FILES}`);
    expect(((await tools[1]!.run({ repo: 'acme/api', branch: 'b;rm -rf', title: 't', paths: ['x'] })) as { error: string }).error).toContain('refused branch name');
  });
});
