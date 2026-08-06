// Platform embedder selection (ROADMAP M1a item 3 — DECISION documented in
// embed-dims.ts): canonical space = 384-dim; production = OpenAI
// text-embedding-3-small with `dimensions: 384`; mock embedder (384-dim) for
// CI/dev; Google text-embedding-004 (768-dim) is non-canonical and rejected.
//
// resolveEmbedder(env, providers) priority order:
//   (a) POTION_EMBEDDER=openai WITH OPENAI_API_KEY set → OpenAI embed, wrapped
//       in a fail-fast 384-dim guard (mode 'openai'). Also the default when
//       POTION_EMBEDDER is unset and OPENAI_API_KEY is present (preserves the
//       historical boot behavior).
//   (b) POTION_EMBEDDER=mock, POTION_EMBEDDER=openai WITHOUT a key (fallback),
//       or nothing configured at all → mock embedder + a LOUD startup warning
//       ("mock embeddings: cluster assignment is simulated").
//   (c) POTION_EMBEDDER=<anything else> → EmbedderConfigError; 'google' gets a
//       dedicated message explaining the 768-dim space is non-canonical.
import { type Embedder } from './assigner.js';
import { assertCanonicalDims, CANONICAL_EMBED_DIMS } from './embed-dims.js';

/** Production embedding model (mirrors OPENAI_EMBED_MODEL in @potion/providers;
 * duplicated so @potion/cluster has no runtime dependency on providers). */
export const OPENAI_PLATFORM_EMBED_MODEL = 'text-embedding-3-small';

/** Reported model name for the deterministic mock embedder. */
export const MOCK_EMBED_MODEL = 'mock-keyword-clustered-384';

export type EmbedderMode = 'openai' | 'mock';

export interface ResolvedEmbedder {
  embedder: Embedder;
  mode: EmbedderMode;
  model: string;
  dims: number;
}

/** Env vars consulted by resolveEmbedder (pass process.env, or a subset in tests). */
export interface EmbedderEnv {
  POTION_EMBEDDER?: string | undefined;
  OPENAI_API_KEY?: string | undefined;
}

/**
 * Structural subset of @potion/providers' Record<ProviderId, Provider> — only
 * the embed-capable entries the platform embedder can be drawn from. Kept
 * structural so @potion/cluster does not depend on @potion/providers at runtime.
 */
export interface EmbedderProviders {
  mock: { embed?: (texts: string[]) => Promise<number[][]> };
  openai?: { embed?: (texts: string[]) => Promise<number[][]> };
}

/** Named error for invalid platform-embedder configuration. */
export class EmbedderConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmbedderConfigError';
  }
}

export const MOCK_EMBEDDINGS_WARNING =
  'mock embeddings: cluster assignment is simulated — set POTION_EMBEDDER=openai ' +
  'with OPENAI_API_KEY for real semantic routing in production';

/**
 * Wrap an embedder so every returned vector is asserted 384-dim (canonical)
 * before it can reach centroid building or assignment — fails fast with
 * EmbeddingDimensionError on the first offending batch.
 */
export function withDimensionGuard(embedder: Embedder, context: string): Embedder {
  return {
    async embed(texts: string[]): Promise<number[][]> {
      const vectors = await embedder.embed(texts);
      for (const v of vectors) assertCanonicalDims(v, context);
      return vectors;
    },
  };
}

export function resolveEmbedder(
  env: EmbedderEnv,
  providers: EmbedderProviders,
  opts: { warn?: (msg: string) => void } = {},
): ResolvedEmbedder {
  const warn = opts.warn ?? ((msg: string) => console.warn(`[potion] ${msg}`));
  const requested = env.POTION_EMBEDDER?.trim().toLowerCase();

  // (c) explicit unknown value → throw (google gets a dedicated explanation).
  if (requested !== undefined && requested !== '' && requested !== 'openai' && requested !== 'mock') {
    if (requested === 'google') {
      throw new EmbedderConfigError(
        "POTION_EMBEDDER=google cannot be the platform embedder: Google's " +
          'text-embedding-004 is 768-dim, NOT the canonical 384-dim space ' +
          '(mixing spaces would corrupt cluster routing). Use ' +
          'POTION_EMBEDDER=openai (text-embedding-3-small, dimensions:384) or mock.',
      );
    }
    throw new EmbedderConfigError(
      `unknown POTION_EMBEDDER='${env.POTION_EMBEDDER}' — expected 'openai' or 'mock'`,
    );
  }

  const hasKey = !!env.OPENAI_API_KEY;

  // (a) OpenAI: explicitly requested with a key, or defaulted-to when a key is
  // present. Explicitly requested WITHOUT a key falls back to mock loudly (b).
  if ((requested === 'openai' || requested === undefined || requested === '') && hasKey) {
    const openai = providers.openai;
    if (!openai?.embed) {
      throw new EmbedderConfigError(
        'POTION_EMBEDDER=openai but the providers record exposes no openai.embed',
      );
    }
    const embedFn = openai.embed.bind(openai);
    return {
      embedder: withDimensionGuard({ embed: (texts) => embedFn(texts) }, 'openai embedder'),
      mode: 'openai',
      model: OPENAI_PLATFORM_EMBED_MODEL,
      dims: CANONICAL_EMBED_DIMS,
    };
  }

  if (requested === 'openai' && !hasKey) {
    warn('POTION_EMBEDDER=openai but OPENAI_API_KEY is not set — falling back to mock embeddings');
  }

  // (b) mock embedder + loud startup warning.
  if (!providers.mock.embed) {
    throw new EmbedderConfigError('the mock provider exposes no embed — cannot build centroids');
  }
  warn(MOCK_EMBEDDINGS_WARNING);
  const mockEmbed = providers.mock.embed.bind(providers.mock);
  return {
    embedder: withDimensionGuard({ embed: (texts) => mockEmbed(texts) }, 'mock embedder'),
    mode: 'mock',
    model: MOCK_EMBED_MODEL,
    dims: CANONICAL_EMBED_DIMS,
  };
}
