import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  HELDOUT_PATH,
  TAXONOMY_PATH,
  loadHeldout,
  loadTaxonomy,
  type Taxonomy,
} from './taxonomy.js';

const VALID_TAXONOMY: Taxonomy = {
  version: 'test-v1',
  clusters: [
    {
      id: 'code-gen',
      name: 'Code generation',
      description: 'Write or fix code.',
      exemplars: ['Write a Python function', 'Fix the bug'],
    },
    {
      id: 'summarization',
      name: 'Summarization',
      description: 'Condense text.',
      exemplars: ['Summarize this article'],
    },
  ],
};

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'potion-cluster-test-'));
}

function writeJson(dir: string, name: string, value: unknown): string {
  const path = join(dir, name);
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value));
  return path;
}

describe('loadTaxonomy', () => {
  it('parses and validates a well-formed taxonomy file', () => {
    const path = writeJson(tempDir(), 'taxonomy.json', VALID_TAXONOMY);
    const taxonomy = loadTaxonomy(path);
    expect(taxonomy.version).toBe('test-v1');
    expect(taxonomy.clusters.map((c) => c.id)).toEqual(['code-gen', 'summarization']);
    expect(taxonomy.clusters[0]!.exemplars).toHaveLength(2);
  });

  it('throws a clear error when the file does not exist', () => {
    const missing = join(tempDir(), 'nope.json');
    expect(() => loadTaxonomy(missing)).toThrowError(/cannot read taxonomy file.*nope\.json/);
  });

  it('throws a clear error for invalid JSON', () => {
    const path = writeJson(tempDir(), 'bad.json', '{ not json');
    expect(() => loadTaxonomy(path)).toThrowError(/not valid JSON/);
  });

  it('throws a located schema error for malformed content', () => {
    const path = writeJson(tempDir(), 'schema.json', {
      version: 'v1',
      clusters: [{ id: 'code-gen', name: 'x', description: 'y', exemplars: [] }],
    });
    expect(() => loadTaxonomy(path)).toThrowError(/failed schema validation/);
    expect(() => loadTaxonomy(path)).toThrowError(/clusters\.0\.exemplars/);
  });

  it('rejects duplicate cluster ids', () => {
    const path = writeJson(tempDir(), 'dup.json', {
      version: 'v1',
      clusters: [
        { id: 'code-gen', name: 'a', description: 'a', exemplars: ['x'] },
        { id: 'code-gen', name: 'b', description: 'b', exemplars: ['y'] },
      ],
    });
    expect(() => loadTaxonomy(path)).toThrowError(/duplicate cluster id "code-gen"/);
  });

  it('rejects missing required fields', () => {
    const path = writeJson(tempDir(), 'missing.json', { clusters: [] });
    expect(() => loadTaxonomy(path)).toThrowError(/version/);
  });

  it('exposes the default data paths', () => {
    expect(TAXONOMY_PATH.replace(/\\/g, '/')).toMatch(/packages\/cluster\/data\/taxonomy\.json$/);
    expect(HELDOUT_PATH.replace(/\\/g, '/')).toMatch(/packages\/cluster\/data\/heldout\.jsonl$/);
  });
});

describe('loadHeldout', () => {
  it('parses JSONL, one object per line, ignoring blank lines', () => {
    const dir = tempDir();
    const path = join(dir, 'heldout.jsonl');
    writeFileSync(
      path,
      [
        '{"id":"h1","clusterId":"code-gen","text":"Write a function"}',
        '',
        '{"id":"h2","clusterId":"summarization","text":"Summarize this"}',
        '',
      ].join('\n'),
    );
    const examples = loadHeldout(path);
    expect(examples).toHaveLength(2);
    expect(examples[0]).toEqual({ id: 'h1', clusterId: 'code-gen', text: 'Write a function' });
  });

  it('names the file and 1-based line number on invalid JSON', () => {
    const dir = tempDir();
    const path = join(dir, 'heldout.jsonl');
    writeFileSync(path, '{"id":"h1","clusterId":"a","text":"ok"}\n{bad}\n');
    expect(() => loadHeldout(path)).toThrowError(/heldout\.jsonl:2 is not valid JSON/);
  });

  it('names the line number on schema violations', () => {
    const dir = tempDir();
    const path = join(dir, 'heldout.jsonl');
    writeFileSync(path, '{"id":"h1","clusterId":"a","text":"ok"}\n{"id":"h2","clusterId":"a"}\n');
    expect(() => loadHeldout(path)).toThrowError(/heldout\.jsonl:2 failed schema validation/);
    expect(() => loadHeldout(path)).toThrowError(/text/);
  });

  it('rejects an empty file and a missing file', () => {
    const dir = tempDir();
    const empty = join(dir, 'empty.jsonl');
    writeFileSync(empty, '\n\n');
    expect(() => loadHeldout(empty)).toThrowError(/contains no examples/);
    expect(() => loadHeldout(join(dir, 'missing.jsonl'))).toThrowError(/cannot read heldout file/);
  });
});
