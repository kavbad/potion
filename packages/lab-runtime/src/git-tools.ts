// X7 (2026-08-30) — the GOVERNED GIT superpower. Two hands, two laws:
//   · repo_fetch (READ): pull a repository SNAPSHOT into the run's
//     workspace tree — GitHub's tarball endpoint, anonymous for public
//     repos, or through the org's github grant when custody holds one
//     (the token is opened per call and never enters model context).
//     Fetching source is observation.
//   · github_pr (ACT): propose the workspace's changes back — a branch, a
//     commit per file, a pull request — through the GitHub API, every
//     call gated at the pore. Commits LEAVE through this gate only; the
//     workspace never holds loose .git objects (storage refuses them).
// The fetch happens in the WORKER process (it has egress); the sandbox
// stays sealed. Tarballs are unpacked with a small in-process reader under
// the same storage quotas as every workspace write.
import { gunzipSync } from 'node:zlib';
import type { LabTool } from './loop.js';
import type { CodeWorkspace } from './code-tools.js';

export interface GitToolDeps {
  workspace: CodeWorkspace;
  /** Opens the org's github connector grant (custody); null = not connected. */
  githubToken: () => Promise<string | null>;
  /** Injected for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export const GIT_LIMITS = {
  MAX_TARBALL_BYTES: 48 * 1024 * 1024,
  MAX_ENTRIES: 400,
  MAX_PR_FILES: 40,
  FETCH_TIMEOUT_MS: 60_000,
  /** Fetched trees land under this prefix so repo files never collide with
   * the run's own artifacts. */
  REPO_PREFIX: 'repo/',
} as const;

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function parseRepoInput(raw: string): { owner: string; repo: string } | null {
  let candidate = raw.trim();
  const m = /^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/.*)?$/.exec(candidate);
  if (m !== null) candidate = `${m[1]}/${m[2]}`;
  if (!REPO_RE.test(candidate)) return null;
  const [owner, repo] = candidate.split('/');
  return { owner: owner!, repo: repo! };
}

/** Minimal ustar reader — enough for GitHub's tarballs. Returns regular
 * files only (symlinks, devices, and hostile paths are skipped, counted). */
export function readTarEntries(tar: Buffer): { files: Array<{ path: string; content: Buffer }>; skipped: number } {
  const files: Array<{ path: string; content: Buffer }> = [];
  let skipped = 0;
  let off = 0;
  while (off + 512 <= tar.length) {
    const header = tar.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break;
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '');
    const sizeOctal = header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim();
    const size = parseInt(sizeOctal || '0', 8);
    const type = String.fromCharCode(header[156]!);
    const full = prefix !== '' ? `${prefix}/${name}` : name;
    const dataStart = off + 512;
    const dataEnd = dataStart + size;
    off = dataStart + Math.ceil(size / 512) * 512;
    if (Number.isNaN(size) || dataEnd > tar.length) break;
    if (type !== '0' && type !== '\0') {
      if (type !== '5') skipped += 1; // directories are structure, not skips
      continue;
    }
    files.push({ path: full, content: Buffer.from(tar.subarray(dataStart, dataEnd)) });
  }
  return { files, skipped };
}

interface GithubJson {
  [k: string]: unknown;
}

export function buildGitLabTools(deps: GitToolDeps): LabTool[] {
  const fetchFn = deps.fetchImpl ?? fetch;

  const gh = async (path: string, token: string, init?: RequestInit): Promise<{ status: number; body: GithubJson }> => {
    const res = await fetchFn(`https://api.github.com${path}`, {
      ...init,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'user-agent': 'potion-worker',
        ...(init?.body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      signal: AbortSignal.timeout(GIT_LIMITS.FETCH_TIMEOUT_MS),
    });
    const body = (await res.json().catch(() => ({}))) as GithubJson;
    return { status: res.status, body };
  };

  return [
    {
      name: 'repo_fetch',
      description:
        'Fetch a GitHub repository snapshot into the run workspace under repo/ (owner/name or a github.com URL; optional ref = branch, tag, or SHA). ' +
        'Public repos work as-is; private ones need the org’s GitHub connection. The snapshot has no .git — run tests and edit files with run_shell/run_python; propose changes back with github_pr.',
      parameters: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'owner/name, or a github.com URL.' },
          ref: { type: 'string', description: 'Branch, tag, or commit SHA (default: the default branch).' },
        },
        required: ['repo'],
      },
      external: false,
      run: async (input: unknown): Promise<unknown> => {
        const i = (input ?? {}) as { repo?: unknown; ref?: unknown };
        if (typeof i.repo !== 'string') return { error: 'repo is required (owner/name or a github.com URL)' };
        const parsed = parseRepoInput(i.repo);
        if (parsed === null) return { error: `could not parse '${i.repo.slice(0, 80)}' as a GitHub repo` };
        const ref = typeof i.ref === 'string' && i.ref.trim() !== '' ? i.ref.trim().slice(0, 120) : 'HEAD';
        const token = await deps.githubToken();
        const url = `https://codeload.github.com/${parsed.owner}/${parsed.repo}/tar.gz/${encodeURIComponent(ref)}`;
        let res: Response;
        try {
          res = await fetchFn(url, {
            headers: {
              'user-agent': 'potion-worker',
              ...(token !== null ? { authorization: `Bearer ${token}` } : {}),
            },
            signal: AbortSignal.timeout(GIT_LIMITS.FETCH_TIMEOUT_MS),
          });
        } catch (e) {
          return { error: `fetch failed: ${e instanceof Error ? e.name : 'error'}` };
        }
        if (!res.ok) {
          return {
            error:
              res.status === 404 && token === null
                ? 'repository not found — if it is private, connect GitHub on the worker page first'
                : `GitHub returned ${res.status} for ${parsed.owner}/${parsed.repo}@${ref}`,
          };
        }
        const gz = Buffer.from(await res.arrayBuffer());
        if (gz.length > GIT_LIMITS.MAX_TARBALL_BYTES) {
          return { error: `repository tarball is ${gz.length} bytes — the cap is ${GIT_LIMITS.MAX_TARBALL_BYTES}` };
        }
        let tar: Buffer;
        try {
          tar = gunzipSync(gz, { maxOutputLength: GIT_LIMITS.MAX_TARBALL_BYTES * 4 });
        } catch {
          return { error: 'the response was not a valid tarball' };
        }
        const { files, skipped } = readTarEntries(tar);
        let wrote = 0;
        const notes: string[] = [];
        for (const f of files) {
          if (wrote >= GIT_LIMITS.MAX_ENTRIES) {
            notes.push(`stopped at ${GIT_LIMITS.MAX_ENTRIES} files — the repo is larger than the workspace`);
            break;
          }
          // Strip the tarball's top-level '<repo>-<ref>/' directory.
          const rel = f.path.split('/').slice(1).join('/');
          if (rel === '') continue;
          const result = await deps.workspace.write(`${GIT_LIMITS.REPO_PREFIX}${rel}`, f.content);
          if (result.ok) wrote += 1;
          else if (notes.length < 10) notes.push(`'${rel}' not kept: ${result.reason}`);
        }
        return {
          ok: true,
          repo: `${parsed.owner}/${parsed.repo}`,
          ref,
          filesWritten: wrote,
          ...(skipped > 0 ? { skippedSpecialEntries: skipped } : {}),
          ...(notes.length > 0 ? { notes } : {}),
          hint: `the tree is under ${GIT_LIMITS.REPO_PREFIX} — run_shell can now test and edit it`,
        };
      },
    },
    {
      name: 'github_pr',
      description:
        'Propose the workspace’s changes as a GitHub pull request: creates a branch from the base, commits the named workspace files (paths under repo/ map to the repository root), and opens the PR. ' +
        'This is an external action — it asks the operator first until it earns autonomy. Requires the org’s GitHub connection.',
      parameters: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'owner/name.' },
          branch: { type: 'string', description: 'The new branch name for the proposal.' },
          title: { type: 'string', description: 'PR title.' },
          body: { type: 'string', description: 'PR description — say what changed and why.' },
          paths: { type: 'array', items: { type: 'string' }, description: 'Workspace paths (under repo/) to commit.' },
          baseBranch: { type: 'string', description: 'Base branch (default: the repo default).' },
        },
        required: ['repo', 'branch', 'title', 'paths'],
      },
      // THE LAW: a PR is an outward act — the pore gates every one.
      external: true,
      // W0 approval-rendering law: the human sees every material parameter —
      // repo, branch, title, and the FULL file list (a PR's meaning is which
      // files it touches; a truncated list would change what was approved).
      describeAction: (input: unknown): string | null => {
        const i = (input ?? {}) as { repo?: unknown; branch?: unknown; title?: unknown; paths?: unknown; baseBranch?: unknown };
        if (typeof i.repo !== 'string' || typeof i.branch !== 'string' || typeof i.title !== 'string' || !Array.isArray(i.paths)) return null;
        const paths = i.paths.filter((x): x is string => typeof x === 'string');
        return (
          `open a pull request on ${i.repo}` +
          `${typeof i.baseBranch === 'string' ? ` (into ${i.baseBranch})` : ''}` +
          ` from new branch '${i.branch}', titled \u201c${i.title}\u201d, committing ${paths.length} file(s): ${paths.join(', ')}`
        );
      },
      run: async (input: unknown): Promise<unknown> => {
        const i = (input ?? {}) as { repo?: unknown; branch?: unknown; title?: unknown; body?: unknown; paths?: unknown; baseBranch?: unknown };
        if (typeof i.repo !== 'string' || typeof i.branch !== 'string' || typeof i.title !== 'string' || !Array.isArray(i.paths)) {
          return { error: 'repo, branch, title and paths are required' };
        }
        const parsed = parseRepoInput(i.repo);
        if (parsed === null) return { error: `could not parse '${String(i.repo).slice(0, 80)}' as a GitHub repo` };
        if (i.paths.length === 0 || i.paths.length > GIT_LIMITS.MAX_PR_FILES) {
          return { error: `paths must name 1-${GIT_LIMITS.MAX_PR_FILES} workspace files` };
        }
        if (!/^[A-Za-z0-9._/-]{1,120}$/.test(i.branch)) return { error: 'refused branch name' };
        const token = await deps.githubToken();
        if (token === null) return { error: 'GitHub is not connected — connect it on the worker page first' };
        const repoPath = `/repos/${parsed.owner}/${parsed.repo}`;

        const repoInfo = await gh(repoPath, token);
        if (repoInfo.status !== 200) return { error: `GitHub returned ${repoInfo.status} reading the repository` };
        const base = typeof i.baseBranch === 'string' && i.baseBranch !== '' ? i.baseBranch : String(repoInfo.body.default_branch ?? 'main');

        const baseRef = await gh(`${repoPath}/git/ref/heads/${encodeURIComponent(base)}`, token);
        if (baseRef.status !== 200) return { error: `GitHub returned ${baseRef.status} reading base branch '${base}'` };
        const baseSha = String((baseRef.body.object as GithubJson | undefined)?.sha ?? '');
        if (baseSha === '') return { error: 'could not resolve the base branch SHA' };

        const mkBranch = await gh(`${repoPath}/git/refs`, token, {
          method: 'POST',
          body: JSON.stringify({ ref: `refs/heads/${i.branch}`, sha: baseSha }),
        });
        if (mkBranch.status !== 201 && mkBranch.status !== 422) {
          return { error: `GitHub returned ${mkBranch.status} creating branch '${i.branch}'` };
        }

        const committed: string[] = [];
        for (const p of i.paths as unknown[]) {
          if (typeof p !== 'string') return { error: 'paths must be strings' };
          const content = await deps.workspace.read(p);
          if (content === null) return { error: `workspace file '${p}' does not exist — nothing was committed for it` };
          const target = p.startsWith(GIT_LIMITS.REPO_PREFIX) ? p.slice(GIT_LIMITS.REPO_PREFIX.length) : p;
          // The Contents API needs the current file SHA for updates.
          const existing = await gh(`${repoPath}/contents/${target}?ref=${encodeURIComponent(i.branch)}`, token);
          const sha = existing.status === 200 ? String(existing.body.sha ?? '') : undefined;
          const put = await gh(`${repoPath}/contents/${target}`, token, {
            method: 'PUT',
            body: JSON.stringify({
              message: `${i.title} — ${target}`,
              content: content.toString('base64'),
              branch: i.branch,
              ...(sha !== undefined && sha !== '' ? { sha } : {}),
            }),
          });
          if (put.status !== 200 && put.status !== 201) {
            return { error: `GitHub returned ${put.status} committing '${target}' (${committed.length} files committed before it)` };
          }
          committed.push(target);
        }

        const pr = await gh(`${repoPath}/pulls`, token, {
          method: 'POST',
          body: JSON.stringify({
            title: i.title,
            head: i.branch,
            base,
            body: typeof i.body === 'string' ? i.body : '',
          }),
        });
        if (pr.status !== 201) return { error: `GitHub returned ${pr.status} opening the pull request (branch '${i.branch}' holds the ${committed.length} commits)` };
        return {
          ok: true,
          prUrl: String(pr.body.html_url ?? ''),
          prNumber: pr.body.number ?? null,
          branch: i.branch,
          base,
          filesCommitted: committed,
        };
      },
    },
  ];
}
