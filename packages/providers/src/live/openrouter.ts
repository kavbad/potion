// OpenRouter live transport (SPEC §2): OpenAI-compatible shape at
// POST https://openrouter.ai/api/v1/chat/completions with HTTP-Referer
// (and X-Title) headers; identical parsing to the OpenAI transport.
// embed: intentionally undefined — OpenRouter embeddings are not part of
// the platform contract in v1. Verified against GET /api/v1/models on
// 2026-08-04 (338 models): ZERO embedding models are served (no
// openai/text-embedding-3-small or any *embed* id), so there is no
// embedding id to note; the 384-dim canonical path stays OpenAI/Google.
import type { CompleteRequest, CompleteResponse, Provider } from '../types.js';
import { openAiCompatibleComplete, openAiCompatibleCompleteStream } from './openai.js';
import type { LiveProviderOptions } from './common.js';

// NOTE: the path is /api/v1/... — bare /v1/chat/completions returns HTTP 404
// (confirmed live 2026-08-04).
export const OPENROUTER_CHAT_URL = 'https://openrouter.ai/api/v1/chat/completions';

export function createOpenRouterProvider(opts: LiveProviderOptions): Provider {
  return {
    id: 'openrouter',

    complete: (req: CompleteRequest): Promise<CompleteResponse> =>
      openAiCompatibleComplete(
        'openrouter',
        OPENROUTER_CHAT_URL,
        {
          // OpenRouter ranking/attribution headers (HTTP-Referer per SPEC §2).
          'HTTP-Referer': 'https://github.com/potion-ai/potion',
          'X-Title': 'Potion',
        },
        opts,
        req,
      ),

    completeStream: (req, onToken) =>
      openAiCompatibleCompleteStream(
        'openrouter',
        OPENROUTER_CHAT_URL,
        { 'HTTP-Referer': 'https://github.com/potion-ai/potion', 'X-Title': 'Potion' },
        opts,
        req,
        onToken,
      ),

    // embed intentionally undefined: OpenRouter embeddings unsupported in v1.
  };
}
