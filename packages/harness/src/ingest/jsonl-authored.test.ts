// jsonl-authored adapter tests (ROADMAP M1a): schema validation, manifest
// cross-checks (clusterId match, scoring allowed for cluster, reference when
// required), id prefixing + EVAL-signature rewrite.
import { describe, expect, it } from 'vitest';
import type { EvalItem } from '@potion/core';
import { convertAuthoredJsonl } from './jsonl-authored.js';

const MANIFEST = {
  suiteId: 'extraction-authored-v1',
  clusterId: 'extraction',
  scoring: { allowed: ['field-match'] as ['field-match'] },
};

function item(patch: Partial<EvalItem> = {}): EvalItem {
  return {
    id: 'ex-01',
    clusterId: 'extraction',
    prompt: [
      {
        role: 'user',
        content: 'EVAL: ex-01\nExtract fields.\n\nRespond with ONLY the JSON object.',
      },
    ],
    reference: { vendor: 'Acme Corp' },
    scoring: { kind: 'field-match', schema: { vendor: 'string' } },
    ...patch,
  } as EvalItem;
}

function toJsonl(...items: EvalItem[]): string {
  return items.map((i) => JSON.stringify(i)).join('\n') + '\n';
}

describe('convertAuthoredJsonl', () => {
  it('converts valid authored JSONL, prefixing ids and rewriting EVAL signatures', () => {
    const { items, warnings } = convertAuthoredJsonl(toJsonl(item(), item({ id: 'ex-02' })), {
      idPrefix: 'extraction-v1-',
      manifest: MANIFEST,
    });
    expect(warnings).toEqual([]);
    expect(items.map((i) => i.id)).toEqual(['extraction-v1-ex-01', 'extraction-v1-ex-02']);
    expect(items[0]!.prompt[0]!.content).toContain('EVAL: extraction-v1-ex-01\n');
    expect(items[0]!.prompt[0]!.content).not.toContain('EVAL: ex-01\n');
    // reference/scoring untouched
    expect(items[0]!.reference).toEqual({ vendor: 'Acme Corp' });
    expect(items[0]!.scoring.kind).toBe('field-match');
  });

  it('without a prefix leaves items untouched', () => {
    const { items } = convertAuthoredJsonl(toJsonl(item()), { manifest: MANIFEST });
    expect(items[0]).toEqual(item());
  });

  it('rejects invalid EvalItem lines (schema)', () => {
    const bad = { id: 'x', clusterId: 'extraction', prompt: [], scoring: { kind: 'exact' } };
    expect(() => convertAuthoredJsonl(toJsonl(bad as EvalItem), { manifest: MANIFEST })).toThrow(
      /line 1.*invalid EvalItem/,
    );
  });

  it('rejects invalid JSON with line number', () => {
    expect(() => convertAuthoredJsonl('{"oops"\n', { manifest: MANIFEST })).toThrow(
      /line 1.*invalid JSON/,
    );
  });

  it('cross-check: clusterId mismatch is rejected', () => {
    expect(() =>
      convertAuthoredJsonl(toJsonl(item({ clusterId: 'code-gen' })), { manifest: MANIFEST }),
    ).toThrow(/clusterId 'code-gen' does not match manifest clusterId 'extraction'/);
  });

  it('cross-check: scoring kind outside the manifest allowlist is rejected', () => {
    const i = item({ scoring: { kind: 'exact' }, reference: 'x' });
    expect(() => convertAuthoredJsonl(toJsonl(i), { manifest: MANIFEST })).toThrow(
      /scoring kind 'exact' not in manifest scoring\.allowed/,
    );
  });

  it('cross-check: scoring not allowed for the cluster is rejected (cluster policy)', () => {
    // field-match is not a sane scoring kind for code-gen per CLUSTER_ALLOWED_SCORING.
    const i = item({ clusterId: 'code-gen' });
    expect(() =>
      convertAuthoredJsonl(toJsonl(i), {
        manifest: { suiteId: 's', clusterId: 'code-gen', scoring: {} },
      }),
    ).toThrow(/not allowed for cluster 'code-gen'/);
  });

  it('cross-check: missing reference when scoring requires it is rejected', () => {
    const i = item({ reference: undefined });
    delete (i as Record<string, unknown>).reference;
    expect(() => convertAuthoredJsonl(toJsonl(i), { manifest: MANIFEST })).toThrow(
      /scoring kind 'field-match' requires a reference/,
    );
  });

  it('rejects duplicate ids after prefixing', () => {
    expect(() =>
      convertAuthoredJsonl(toJsonl(item(), item()), {
        idPrefix: 'extraction-v1-',
        manifest: MANIFEST,
      }),
    ).toThrow(/duplicate item id 'extraction-v1-ex-01'/);
  });

  it('collects ALL problems in one error', () => {
    const badCluster = item({ clusterId: 'code-gen' });
    let caught: Error | null = null;
    try {
      convertAuthoredJsonl(toJsonl(badCluster, item()), { manifest: MANIFEST });
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught!.message).toContain('line 1'); // cluster mismatch
    expect(caught!.message).toContain('problem(s)');
  });
});
