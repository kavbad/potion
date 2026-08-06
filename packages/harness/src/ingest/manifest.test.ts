// SuiteManifest schema tests (ROADMAP M1a): valid manifests parse; every
// provenance/format requirement rejects with a clear error.
import { describe, expect, it } from 'vitest';
import {
  SuiteManifestSchema,
  crossCheckItem,
  scoringRequiresReference,
} from './manifest.js';

const VALID_ITEM = {
  id: 'he-js-01',
  clusterId: 'code-gen',
  prompt: [{ role: 'user', content: 'EVAL: he-js-01\nImplement `f`.' }],
  reference: 'function f() { return 1; }',
  scoring: { kind: 'code-exec', language: 'javascript', tests: "test('x', () => assert(f() === 1));" },
};

const VALID_MANIFEST = {
  suiteId: 'code-gen-humaneval-js-v1',
  clusterId: 'code-gen',
  version: '1.0.0',
  source: {
    kind: 'public-benchmark',
    name: 'HumanEval (OpenAI)',
    license: 'MIT',
    uri: 'https://github.com/openai/human-eval',
  },
  items: 'items.jsonl',
  scoring: { allowed: ['code-exec'] },
  createdAt: '2026-08-04T00:00:00.000Z',
};

describe('SuiteManifestSchema', () => {
  it('accepts a valid manifest (items as path)', () => {
    const m = SuiteManifestSchema.parse(VALID_MANIFEST);
    expect(m.suiteId).toBe('code-gen-humaneval-js-v1');
    expect(m.source.kind).toBe('public-benchmark');
  });

  it('accepts inline items', () => {
    const m = SuiteManifestSchema.parse({ ...VALID_MANIFEST, items: [VALID_ITEM] });
    expect(Array.isArray(m.items)).toBe(true);
  });

  it('accepts authored source kind without uri', () => {
    const m = SuiteManifestSchema.parse({
      ...VALID_MANIFEST,
      source: { kind: 'authored', name: 'Potion suite', license: 'Proprietary (Potion-authored)' },
    });
    expect(m.source.kind).toBe('authored');
  });

  const bad = (label: string, patch: (m: Record<string, unknown>) => void) => {
    it(`rejects ${label}`, () => {
      const m = JSON.parse(JSON.stringify(VALID_MANIFEST)) as Record<string, unknown>;
      patch(m);
      const r = SuiteManifestSchema.safeParse(m);
      expect(r.success).toBe(false);
    });
  };

  bad('suiteId with illegal characters', (m) => {
    m.suiteId = 'Code_Gen!';
  });
  bad('non-semver version', (m) => {
    m.version = 'v1';
  });
  bad('unknown source kind', (m) => {
    (m.source as Record<string, unknown>).kind = 'scraped';
  });
  bad('missing license', (m) => {
    delete (m.source as Record<string, unknown>).license;
  });
  bad('empty source name', (m) => {
    (m.source as Record<string, unknown>).name = '';
  });
  bad('invalid source uri', (m) => {
    (m.source as Record<string, unknown>).uri = 'not-a-url';
  });
  bad('empty items path', (m) => {
    m.items = '';
  });
  bad('empty inline items array', (m) => {
    m.items = [];
  });
  bad('unknown scoring kind in allowed', (m) => {
    m.scoring = { allowed: ['regex'] };
  });
  bad('non-ISO createdAt', (m) => {
    m.createdAt = 'last tuesday';
  });
  bad('missing clusterId', (m) => {
    delete m.clusterId;
  });
});

describe('crossCheckItem / scoringRequiresReference', () => {
  const manifest = {
    suiteId: 's',
    clusterId: 'code-gen',
    scoring: { allowed: ['code-exec'] as ['code-exec'] },
  };

  it('passes a matching item', () => {
    expect(crossCheckItem(manifest, VALID_ITEM as never, 0)).toEqual([]);
  });

  it('flags clusterId mismatch', () => {
    const item = { ...VALID_ITEM, clusterId: 'extraction' };
    const problems = crossCheckItem(manifest, item as never, 0);
    expect(problems.some((p) => p.includes('clusterId'))).toBe(true);
  });

  it('flags scoring kind outside the manifest allowlist', () => {
    const item = { ...VALID_ITEM, scoring: { kind: 'exact' }, reference: 'x' };
    const problems = crossCheckItem(manifest, item as never, 0);
    expect(problems.some((p) => p.includes('scoring.allowed'))).toBe(true);
  });

  it('flags missing reference when the scoring kind requires one', () => {
    expect(scoringRequiresReference('exact')).toBe(true);
    expect(scoringRequiresReference('field-match')).toBe(true);
    expect(scoringRequiresReference('code-exec')).toBe(false);
    expect(scoringRequiresReference('llm-judge')).toBe(false);
    const item = { ...VALID_ITEM, scoring: { kind: 'exact' }, reference: undefined };
    delete (item as Record<string, unknown>).reference;
    const noAllow = { suiteId: 's', clusterId: 'code-gen', scoring: {} };
    const problems = crossCheckItem(noAllow, item as never, 2);
    expect(problems.some((p) => p.includes('requires a reference'))).toBe(true);
    expect(problems[0]).toContain('item 3'); // 1-based index in message
  });
});
