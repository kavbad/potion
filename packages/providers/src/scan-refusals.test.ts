// WHAT THE SCAN REFUSES TO LEARN (SERVING-ROADMAP S5).
//
// OpenRouter's /api/v1/models returns a `benchmarks` block — third-party
// eval percentiles per model. Ingesting it would be trivial and it is exactly
// the wrong thing to do:
//
//   Routing on someone else's benchmark is the incumbent leaderboard's game,
//   and it is the claim Potion exists to replace. The whole product is "we
//   measured this, for YOUR kind of work, and here is the evidence" — a
//   number scraped from a vendor's marketing surface has no provenance we
//   can stand behind, no per-cluster meaning, and no way to be wrong in a way
//   we would notice.
//
// So the refusal is deliberate, and it is pinned here rather than left as an
// absence: today the parser simply does not read the field, and the point of
// this test is that adding it later has to be a decision someone makes on
// purpose against a failing test, not a convenience someone slips in while
// wiring up context lengths.
import { describe, expect, it } from 'vitest';
import { fetchOpenRouterModels } from './scan.js';

/** A response shaped like OpenRouter's, benchmarks included. */
function modelsResponse(): Response {
  return new Response(
    JSON.stringify({
      data: [
        {
          id: 'vendor/impressive-model',
          canonical_slug: 'vendor/impressive-model',
          created: 1_760_000_000,
          pricing: { prompt: '0.0000005', completion: '0.0000015' },
          supported_parameters: ['tools', 'temperature'],
          context_length: 200_000,
          top_provider: { max_completion_tokens: 32_000 },
          // The thing we refuse.
          benchmarks: {
            mmlu: 0.921,
            gpqa: 0.774,
            swe_bench: 0.688,
            arena_elo: 1387,
          },
        },
      ],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

describe('the scan never ingests third-party benchmark scores', () => {
  it('parses the listing WITHOUT carrying any benchmark field through', async () => {
    const [listing] = await fetchOpenRouterModels({
      apiKey: 'test',
      fetchImpl: async () => modelsResponse(),
    });
    expect(listing).toBeDefined();
    // The useful facts DO come through…
    expect(listing!.id).toBe('vendor/impressive-model');
    expect(listing!.promptPerToken).toBeCloseTo(0.0000005, 12);
    expect(listing!.supportedParameters).toContain('tools');

    // …and not one benchmark number does, under any key.
    const serialized = JSON.stringify(listing);
    for (const forbidden of ['benchmark', 'mmlu', 'gpqa', 'swe_bench', 'arena_elo', '0.921', '1387']) {
      expect(serialized.toLowerCase(), `'${forbidden}' must not survive into a listing`).not.toContain(
        forbidden.toLowerCase(),
      );
    }
  });

  it('a model with spectacular benchmarks is treated exactly like one without', async () => {
    // The property that matters: benchmarks cannot influence ANYTHING,
    // because they do not reach the object decisions are made from. Two
    // listings identical but for their benchmark blocks must parse identically.
    const withScores = await fetchOpenRouterModels({
      apiKey: 'test',
      fetchImpl: async () => modelsResponse(),
    });
    const withoutScores = await fetchOpenRouterModels({
      apiKey: 'test',
      fetchImpl: async () => {
        const body = JSON.parse(await modelsResponse().text()) as { data: Array<Record<string, unknown>> };
        delete body.data[0]!.benchmarks;
        return new Response(JSON.stringify(body), { status: 200 });
      },
    });
    expect(withScores).toEqual(withoutScores);
  });
});
