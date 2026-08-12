// Parser behaviors the corpus cannot express file-by-file: issue COLLECTION,
// the pre-parse oversize gate's cost, version precedence, and the
// subset-of-core proof for the Lab policy vocabulary.
import { describe, expect, it } from 'vitest';
import { PolicySchema } from '@potion/core';
import { LabPolicySchema } from './schema.js';
import { parseHarnessSpec, parseHarnessSpecText } from './parse.js';
import { MAX_TOTAL_BYTES } from './limits.js';

describe('issue collection', () => {
  it('reports ALL issues in one pass, not first-failure', () => {
    const result = parseHarnessSpec({
      specVersion: 1,
      name: '', // schema: too short
      brain: { policy: { type: 'min_cost', qualityFloor: 0.8 } },
      mission: { kind: 'task', goal: 'g', doneDefinition: 'd' },
      superpowers: [],
      memory: { enabled: false },
      rules: ['contains sk-or-v1-0000FAKEFIXTURE0000000000'], // secret-material
      fuel: { maxUsdPerRun: -1, hardStop: true }, // schema: negative
      checkIns: [],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const codes = result.issues.map((i) => i.code);
      expect(codes).toContain('secret-material');
      expect(codes.filter((c) => c === 'schema').length).toBeGreaterThanOrEqual(2);
    }
  });

  it('every issue carries a usable path', () => {
    const result = parseHarnessSpec({
      specVersion: 1,
      name: 'x',
      brain: { policy: { type: 'min_cost', qualityFloor: 0.8 } },
      mission: { kind: 'task', goal: 'g', doneDefinition: 'd' },
      superpowers: [],
      memory: { enabled: false },
      rules: ['fine', 'export MY_API_KEY=abcdefgh1234'],
      fuel: { maxUsdPerRun: 1, hardStop: true },
      checkIns: [],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const secret = result.issues.find((i) => i.code === 'secret-material');
      expect(secret?.path).toBe('rules[1]');
    }
  });
});

describe('the pre-parse oversize gate', () => {
  it('rejects a 10 MB garbage input fast, without invoking JSON.parse', () => {
    const garbage = 'x'.repeat(10 * 1024 * 1024);
    const started = Date.now();
    const result = parseHarnessSpecText(garbage);
    const elapsed = Date.now() - started;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0]!.code).toBe('oversize-total');
    // Byte-length check only — parsing 10 MB would take far longer.
    expect(elapsed).toBeLessThan(100);
  });

  it('the boundary is exact', () => {
    // A syntactically broken input AT the cap: the gate passes it through and
    // the JSON parser rejects it — proving the gate is > not >=.
    const atCap = 'x'.repeat(MAX_TOTAL_BYTES);
    const r1 = parseHarnessSpecText(atCap);
    expect(!r1.ok && r1.issues[0]!.code).toBe('malformed-json');
    const overCap = 'x'.repeat(MAX_TOTAL_BYTES + 1);
    const r2 = parseHarnessSpecText(overCap);
    expect(!r2.ok && r2.issues[0]!.code).toBe('oversize-total');
  });
});

describe('version precedence', () => {
  it('an unknown specVersion is the ONLY error reported — not forty shape errors', () => {
    const result = parseHarnessSpec({ specVersion: 99, totally: 'different', format: true });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0]!.code).toBe('unsupported-spec-version');
    }
  });
});

describe('LabPolicySchema is a PROVEN subset of core PolicySchema', () => {
  // The deviation recorded in schema.ts: Lab policies are core's vocabulary
  // minus shadow/guarantee, strict. This test is what keeps "one dial
  // vocabulary" an enforced fact instead of a comment — if core's schema
  // drifts incompatibly, this fails the build.
  const LAB_POLICIES = [
    { type: 'max_quality', costCeilingPer1K: 5 },
    { type: 'min_cost', qualityFloor: 0.8 },
    { type: 'latency_bound', p95Ms: 2000 },
    { type: 'compound', qualityFloor: 0.85, p95Ms: 1500 },
  ];

  it('every Lab-valid policy parses under core PolicySchema', () => {
    for (const p of LAB_POLICIES) {
      expect(LabPolicySchema.safeParse(p).success, JSON.stringify(p)).toBe(true);
      expect(PolicySchema.safeParse(p).success, `core rejected ${JSON.stringify(p)}`).toBe(true);
    }
  });

  it('serving-side config (shadow/guarantee) is REJECTED by the Lab schema', () => {
    // Core accepts these; the Lab must not — an accepted-but-unenforced slot
    // is the phantom-decision pattern.
    // Must be genuinely core-VALID (candidates needs >=1 entry or 'frontier')
    // or this test proves nothing — the first draft used `candidates: []`,
    // which core also rejects, and the assertion failed for the wrong reason.
    const withShadow = {
      type: 'min_cost',
      qualityFloor: 0.8,
      shadow: { sampleRate: 0.1, candidates: 'frontier' },
    };
    expect(PolicySchema.safeParse(withShadow).success).toBe(true);
    expect(LabPolicySchema.safeParse(withShadow).success).toBe(false);
  });
});
