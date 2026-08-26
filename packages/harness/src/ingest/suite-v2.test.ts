// v2 suite loader tests (ROADMAP M1a): the two checked-in v2 suites load
// through manifest validation + cross-checks; malformed manifests/items fail
// with precise errors (tmp dirs).
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { SUITES_V2_DIR, loadSuiteV2 } from './suite-v2.js';

describe('loadSuiteV2 (checked-in suites)', () => {
  it('loads code-gen-humaneval-js-v1: 12 JS code-exec items with provenance', () => {
    const { manifest, items } = loadSuiteV2('code-gen-humaneval-js-v1');
    expect(manifest.suiteId).toBe('code-gen-humaneval-js-v1');
    expect(manifest.clusterId).toBe('code-gen');
    expect(manifest.source.kind).toBe('authored');
    expect(manifest.source.license).toContain('Potion-authored');
    expect(items).toHaveLength(12);
    for (const item of items) {
      expect(item.clusterId).toBe('code-gen');
      expect(item.scoring.kind).toBe('code-exec');
      expect((item.scoring as { language: string }).language).toBe('javascript');
      expect(item.id).toMatch(/^he-js-js-bench-\d{2}$/);
      expect(typeof item.reference).toBe('string');
    }
  });

  it('loads extraction-authored-v1: 30 repackaged items, ids stable by prefix', () => {
    const { manifest, items } = loadSuiteV2('extraction-authored-v1');
    expect(manifest.source.kind).toBe('authored');
    expect(items).toHaveLength(30);
    expect(items[0]!.id).toBe('extraction-v1-ex-01');
    expect(items[29]!.id).toBe('extraction-v1-ex-30');
    expect(items.every((i) => i.scoring.kind === 'field-match')).toBe(true);
    expect(items.every((i) => i.reference !== undefined)).toBe(true);
  });

  it('SUITES_V2_DIR points at packages/harness/suites/v2', () => {
    expect(SUITES_V2_DIR).toMatch(/packages\/harness\/suites\/v2$/);
  });
});

describe('loadSuiteV2 (failure modes, tmp dirs)', () => {
  const root = mkdtempSync(`${tmpdir()}/potion-suites-v2-`);

  function writeSuite(id: string, manifest: unknown, items?: string) {
    const dir = `${root}/${id}`;
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      `${dir}/manifest.json`,
      typeof manifest === 'string' ? manifest : JSON.stringify(manifest),
    );
    if (items !== undefined) writeFileSync(`${dir}/items.jsonl`, items);
  }

  const baseManifest = {
    suiteId: 'bad-suite',
    clusterId: 'extraction',
    version: '1.0.0',
    source: { kind: 'authored', name: 'test', license: 'Proprietary' },
    items: 'items.jsonl',
    scoring: { allowed: ['field-match'] },
    createdAt: '2026-08-04T00:00:00.000Z',
  };
  const baseItem = {
    id: 'x-01',
    clusterId: 'extraction',
    prompt: [{ role: 'user', content: 'EVAL: x-01\nextract' }],
    reference: { a: 'b' },
    scoring: { kind: 'field-match', schema: { a: 'string' } },
  };

  it('rejects an invalid suite id', () => {
    expect(() => loadSuiteV2('Bad_Id', root)).toThrow(/invalid suite id/);
  });

  it('rejects a missing suite', () => {
    expect(() => loadSuiteV2('nope', root)).toThrow(/not found/);
  });

  it('rejects a malformed manifest (schema violation)', () => {
    writeSuite('bad-suite', { ...baseManifest, version: 'v1' }, JSON.stringify(baseItem) + '\n');
    expect(() => loadSuiteV2('bad-suite', root)).toThrow(/invalid manifest/);
  });

  it('rejects when manifest suiteId does not match the directory', () => {
    writeSuite('other-suite', { ...baseManifest, suiteId: 'bad-suite' }, JSON.stringify(baseItem) + '\n');
    expect(() => loadSuiteV2('other-suite', root)).toThrow(/does not match directory name/);
  });

  it('rejects an invalid items.jsonl line', () => {
    writeSuite('bad-items', { ...baseManifest, suiteId: 'bad-items' }, '{"broken"\n');
    expect(() => loadSuiteV2('bad-items', root)).toThrow(/items line 1.*invalid JSON/);
  });

  it('rejects items failing manifest cross-checks', () => {
    writeSuite(
      'bad-cross',
      { ...baseManifest, suiteId: 'bad-cross' },
      JSON.stringify({ ...baseItem, clusterId: 'code-gen' }) + '\n',
    );
    expect(() => loadSuiteV2('bad-cross', root)).toThrow(/cross-check failed/);
  });

  it('loads a valid suite from a tmp dir', () => {
    writeSuite('ok-suite', { ...baseManifest, suiteId: 'ok-suite' }, JSON.stringify(baseItem) + '\n');
    const { items } = loadSuiteV2('ok-suite', root);
    expect(items).toHaveLength(1);
    expect(items[0]!.id).toBe('x-01');
  });
});

describe('locked confirmation suites (eval-review adoption, 2026-08-25)', () => {
  const root = mkdtempSync(`${tmpdir()}/potion-suites-locked-`);

  function writeSuite(id: string, manifest: unknown, items: string) {
    const dir = `${root}/${id}`;
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${dir}/manifest.json`, JSON.stringify(manifest));
    writeFileSync(`${dir}/items.jsonl`, items);
  }

  const item = JSON.stringify({
    id: 'lk-01',
    clusterId: 'extraction',
    prompt: [{ role: 'user', content: 'EVAL: lk-01\nextract' }],
    reference: { a: 'b' },
    scoring: { kind: 'field-match', schema: { a: 'string' } },
  }) + '\n';
  const manifest = (id: string, locked: boolean) => ({
    suiteId: id,
    clusterId: 'extraction',
    version: '1.0.0',
    source: { kind: 'authored', name: 'test', license: 'Proprietary' },
    items: 'items.jsonl',
    scoring: { allowed: ['field-match'] },
    createdAt: '2026-08-25T00:00:00.000Z',
    ...(locked ? { locked: true } : {}),
  });

  it('a locked suite REFUSES the default (search) purpose — fail-closed', () => {
    writeSuite('locked-conf', manifest('locked-conf', true), item);
    expect(() => loadSuiteV2('locked-conf', root)).toThrow(/LOCKED \(confirmation-only\)/);
    expect(() => loadSuiteV2('locked-conf', root, 'search')).toThrow(/must not/);
  });

  it('a locked suite loads under the explicit confirmation purpose', () => {
    const { manifest: m, items } = loadSuiteV2('locked-conf', root, 'confirmation');
    expect(m.locked).toBe(true);
    expect(items).toHaveLength(1);
  });

  it('an unlocked suite is untouched by the gate under both purposes', () => {
    writeSuite('open-suite', manifest('open-suite', false), item);
    expect(loadSuiteV2('open-suite', root).items).toHaveLength(1);
    expect(loadSuiteV2('open-suite', root, 'confirmation').items).toHaveLength(1);
  });

  it('no checked-in platform suite is accidentally locked (search must keep working)', () => {
    // Every current platform suite predates the flag; locking one is a
    // deliberate act at authoring time, never a side effect of this change.
    expect(() => loadSuiteV2('code-gen-hard-v2')).not.toThrow();
  });
});
