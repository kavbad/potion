import { describe, expect, it } from 'vitest';
import {
  MIN_MEASURED_POINTS,
  assessCoverage,
  type CoverageCell,
  type CoverageEvidence,
} from './coverage.js';

const cell = (over: Partial<CoverageCell> = {}): CoverageCell => ({
  bucket: 'code-gen',
  bucketKind: 'cluster',
  shapeClass: 'no-tools/sync/0-1k',
  requests: 100,
  orgCount: 5,
  ...over,
});

const evidence = (over: Partial<CoverageEvidence> = {}): CoverageEvidence => ({
  livePoints: MIN_MEASURED_POINTS,
  toolCapablePoints: 2,
  maxContextTokens: 128_000,
  ...over,
});

describe('assessCoverage', () => {
  it('covered: enough live points, tool-capable where needed, context to spare', () => {
    const v = assessCoverage(cell(), evidence());
    expect(v).toMatchObject({ reason: 'covered', covered: true, score: 0 });
  });

  it('an unassigned region is uncovered by construction', () => {
    // Routing never picked a cluster for it, so no cluster's evidence is its
    // evidence — not even a fully measured one.
    const v = assessCoverage(cell({ bucketKind: 'unassigned', bucket: 'lsh:0f0f' }), evidence());
    expect(v.reason).toBe('unassigned_region');
    expect(v.covered).toBe(false);
  });

  it('no frontier and an empty frontier are the same verdict', () => {
    expect(assessCoverage(cell(), null).reason).toBe('no_live_points');
    expect(assessCoverage(cell(), evidence({ livePoints: 0 })).reason).toBe('no_live_points');
  });

  it('tool-carrying demand with no tool-capable point is the named gap', () => {
    const v = assessCoverage(
      cell({ shapeClass: 'tools/sync/0-1k' }),
      evidence({ toolCapablePoints: 0 }),
    );
    expect(v.reason).toBe('no_tool_capable_point');
    // The same cluster is fine for traffic that carries no tools — the gap
    // is a property of (cluster, shape), never of the cluster alone.
    expect(assessCoverage(cell(), evidence({ toolCapablePoints: 0 })).reason).toBe('covered');
  });

  it('sizes context against the WORST case the cell can contain', () => {
    // A 16k-64k cell contains requests up to 64k chars ≈ 16k tokens.
    const long = cell({ shapeClass: 'no-tools/sync/16k-64k' });
    expect(assessCoverage(long, evidence()).requiredContextTokens).toBe(16_000);
    expect(assessCoverage(long, evidence({ maxContextTokens: 8_192 })).reason).toBe(
      'context_too_short',
    );
    expect(assessCoverage(long, evidence({ maxContextTokens: 32_000 })).reason).toBe('covered');
  });

  it('treats UNKNOWN context as uncovered — absence of evidence is not coverage', () => {
    // models.context_length is nullable precisely because a provider may not
    // report it. Reading that as "big enough" is how a 60k prompt gets
    // silently truncated by a model nobody checked.
    expect(assessCoverage(cell(), evidence({ maxContextTokens: null })).reason).toBe(
      'context_too_short',
    );
  });

  it('flags measured-but-thin evidence below the breadth floor', () => {
    const v = assessCoverage(cell(), evidence({ livePoints: MIN_MEASURED_POINTS - 1 }));
    expect(v.reason).toBe('thin_evidence');
    expect(v.covered).toBe(false);
  });

  it('ranks by demand × breadth × severity, and covered cells score 0', () => {
    const big = assessCoverage(cell({ requests: 1000, orgCount: 10 }), null);
    const small = assessCoverage(cell({ requests: 10, orgCount: 5 }), null);
    expect(big.score).toBeGreaterThan(small.score);
    // Breadth matters, not just volume: the same request count spread over
    // more customers is a bigger gap.
    const narrow = assessCoverage(cell({ requests: 100, orgCount: 5 }), null);
    const wide = assessCoverage(cell({ requests: 100, orgCount: 50 }), null);
    expect(wide.score).toBeGreaterThan(narrow.score);
    expect(assessCoverage(cell(), evidence()).score).toBe(0);
  });

  it('ranks a total absence of evidence above a merely narrow one', () => {
    const none = assessCoverage(cell(), evidence({ livePoints: 0 }));
    const thin = assessCoverage(cell(), evidence({ livePoints: 2 }));
    expect(none.score).toBeGreaterThan(thin.score);
  });

  it('falls back to the widest context requirement for an unparsable shape', () => {
    // A shape key from a future version must not be read as "small".
    const v = assessCoverage(cell({ shapeClass: 'who/knows' }), evidence());
    expect(v.requiredContextTokens).toBe(64_000);
  });
});
