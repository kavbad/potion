// The 'hand this to your agent' blocks — plain text, no React, so the same
// words can be dumped to files, tested, and dogfooded by agents.
export type Situation = 'node-new' | 'python-new' | 'openai-sdk' | 'gateway' | 'ai-sdk' | 'http';

export const SITUATIONS: { id: Situation; label: string }[] = [
  { id: 'openai-sdk', label: 'Existing app on the OpenAI SDK' },
  { id: 'gateway', label: 'Existing app on another gateway' },
  { id: 'node-new', label: 'New project · Node / TypeScript' },
  { id: 'python-new', label: 'New project · Python' },
  { id: 'ai-sdk', label: 'Vercel AI SDK or LangChain' },
  { id: 'http', label: 'Anything else over HTTP' },
];

const RECEIPT = `## The receipt
Every Potion response carries the header \`x-frontier-trace\`. Its exact format:
\`cluster=classification;strategy=ffe46bc9;frontier=v4;policy=min_cost;fallback=0;provenance=live\`
- \`cluster\` — the kind of work Potion detected (one of: classification, extraction, code-gen, code-review, rag-answer, summarization, rewrite-edit, creative, multi-step-reasoning, agentic-tool-use)
- \`strategy\` — the first 8 characters of the hash of what answered (a model, or a measured combination)
- \`frontier\` — the version of the measured frontier it was picked from
- \`policy\` — the rule in force: min_cost, max_quality or latency_bound
- \`fallback\` — 0 when the rule picked a measured point; 1 when nothing measured qualified and the default served
- \`provenance\` — \`live\` means served by a real provider on live evidence; anything else is not a real answer
Optional extras: \`policy_override=<name>\` when a per-request rule was used; \`upgraded=0|1\` for combinations.
The model that answered is in a second header, \`x-potion-model\` (a model name, or \`combination:<type>\` for a measured combination). The response body's \`model\` field only echoes the label you sent.
Streaming: \`stream: true\` streams for a single model; when Potion serves a measured combination that cannot stream, it returns a complete 200 JSON body instead, with the header \`x-latency-contract: non-streamed\`. Streaming clients must handle a non-streamed JSON response.
Discover policies with GET /v1/policies (ids, names, and which one the key is bound to); never guess policy names — omit \`x-potion-policy\` entirely to use the key's bound policy (that IS the convention). Every JSON answer carries a \`potion\` object: requested vs resolved cluster/policy, the model that answered, and \`fallback\` + \`fallback_reason\` (\`policy_infeasible\` = no measured point met the bar; the best point served) — read it instead of parsing the trace.
Tool loops work as in OpenAI (assistant \`tool_calls\` turn, then \`role: "tool"\` results). Forwarded parameters: temperature, top_p, stop, seed, user, response_format (JSON mode / JSON schema), parallel_tool_calls, max_tokens; \`n\` must be 1. Content-part arrays are accepted for text; image parts return 400 \`unsupported_content\` — do not send vision traffic through Potion yet.
Errors are OpenAI-shaped JSON: \`{"error":{"message","type","code"}}\`; \`error.code\` is the stable field (e.g. \`budget_exceeded\`, \`rate_limit_exceeded\`, \`cluster_not_found\`, \`no_policy_bound\`). Error responses do not carry the receipt.

Optional request headers: \`x-potion-cluster: <cluster>\` to state the kind of work yourself (one of the ten above; unknown values return 400 cluster_not_found); \`x-potion-policy: <policy name or id>\` to use a different rule for this one request.`;

const VERIFY = `## Verify
1. Send one real request through the app. If \`POTION_API_KEY\` is not set, fail with a clear message before calling anything.
2. Read the response headers \`x-frontier-trace\` and \`x-potion-model\` and print them. Their absence means the request did not go through Potion. Reading a header is not "changing response handling".
3. Confirm in code that the header's \`provenance\` is \`live\` and \`fallback\` is \`0\` on a normal request. (The human can see the same request on the dashboard under Home → Your first receipt; an agent cannot, so do not try.)

## Never
- Never print, log, or commit the Potion key. Read it from the environment variable \`POTION_API_KEY\`.
- Never alter the OpenAI request or response shapes, or the headers Potion returns. Streaming and tool calls work unchanged.
- Never rely on the model field to choose a model: it is a label. The rule on the key decides; \`x-potion-model\` shows what answered.`;

export function block(s: Situation, baseUrl: string, routerModel = 'potion-auto'): string {
  const head = `# Route this app's AI requests through Potion

You are integrating Potion, a measured model router with an OpenAI-compatible API.
Base URL: ${baseUrl}/v1
Key: read \`POTION_API_KEY\` from the environment. Do not ask for it, do not echo it; if it is unset at runtime, fail with a clear message BEFORE constructing a client. This matters: the OpenAI SDKs silently fall back to \`OPENAI_API_KEY\` and \`OPENAI_BASE_URL\` when given undefined, so an app migrating off OpenAI with those still set would quietly keep sending traffic to OpenAI while believing it is on Potion. Always pass both \`apiKey\` and \`baseURL\` explicitly.
Retries: the SDK's default retries (on 408/409/429/5xx and connection errors) are safe to keep — those responses are refused before any model runs, so nothing is billed twice. A 200 is billed once.
Model: \`${routerModel}\`${routerModel === 'potion-auto' ? " (or the org's NAMED router id \`potion/<org-slug>\` — shown on the dashboard's Router page; both route identically)" : " — this org's NAMED router (\`potion-auto\` is the plain alias; both route identically)"}. Routing is decided by the rule bound to the key, never by this field; the field is echoed back and recorded with the request as a label, so an existing per-tier label (e.g. \`fast\`, \`best\`) may be passed through unchanged as a free tag. The receipt (below) shows what answered.
Base URL: your Potion origin plus \`/v1\` — put it in \`POTION_BASE_URL\` (default \`${baseUrl}/v1\`) so it can be changed without a code edit (inside a private network the origin differs).
${RECEIPT}
`;
  switch (s) {
    case 'openai-sdk':
      return `${head}
## Steps
1. Find every place an OpenAI client is constructed (\`new OpenAI(...)\` in JS/TS, \`OpenAI(...)\` in Python, or equivalent), and every raw \`fetch\`/HTTP call to an OpenAI-shaped endpoint. There may be more than one. Leave Potion's own internal provider abstractions alone if you happen to be inside Potion's repo.
2. Set the base URL to \`${baseUrl}/v1\` and the API key to \`process.env.POTION_API_KEY\` / \`os.environ["POTION_API_KEY"]\`. Keep every other option. Do this in the package that makes the calls (in a monorepo, not the root).
3. Set \`model\` to \`"${routerModel}"\` on chat-completions calls. Leave messages, temperature, streaming, tools, tool_choice, max_tokens untouched.
3b. To read the receipt: JS/TS \`const { data, response } = await client.chat.completions.create({...}).withResponse(); response.headers.get('x-frontier-trace')\` (openai >= 5). Python \`raw = client.chat.completions.with_raw_response.create(...); raw.headers['x-frontier-trace']; raw.parse()\` (openai >= 1.0).
4. If the code branches on the provider model name in responses (e.g. parsing \`response.model\`), make it tolerant: Potion returns the label you sent.
5. Run the existing test suite. Preserve behaviour: if you moved from raw HTTP to the SDK, note that the SDK throws on non-2xx instead of returning a failed response and only JSON-decodes JSON content types — keep the app's observable behaviour the same.

${VERIFY}`;
    case 'gateway':
      return `${head}
## Steps
1. Find the gateway's base URL and key in config/env (e.g. \`OPENROUTER_API_KEY\`, \`*_BASE_URL\`). Replace the base URL with \`${baseUrl}/v1\` and the key with \`POTION_API_KEY\`. Do not delete the old values; comment them so the human can roll back.
2. Replace every hard-coded provider model id (e.g. \`openai/gpt-4.1\`, \`anthropic/claude-...\`) with \`${routerModel}\`. If the app lets users pick a model or tier: keep the control and pass its value through as the model label (it is recorded as a tag, not used for routing), and leave a one-line note for the human that routing now follows the key's rule; a per-request \`x-potion-policy\` header is the supported way to vary behaviour per tier.
3. Comment out gateway-specific headers (referer/title/ranking headers) like the other old values; Potion ignores them.
4. Keep streaming and tool-call code exactly as it is.
5. Read the receipt with \`.withResponse()\` (JS) / \`with_raw_response\` (Python), as above.

${VERIFY}`;
    case 'node-new':
      return `${head}
## Steps
1. \`npm install openai\` (openai >= 5; in the package that makes the calls).
2. Create the client once:
\`\`\`ts
import OpenAI from 'openai';
export const ai = new OpenAI({ baseURL: '${baseUrl}/v1', apiKey: process.env.POTION_API_KEY });
\`\`\`
3. Call it with \`model: '${routerModel}'\`:
\`\`\`ts
const res = await ai.chat.completions.create({ model: '${routerModel}', messages: [{ role: 'user', content: '...' }] });
\`\`\`
4. Streaming and tools work as in the OpenAI SDK docs; nothing Potion-specific is needed.
5. Read the receipt with \`.withResponse()\`: \`const { data, response } = await ai.chat.completions.create({...}).withResponse(); response.headers.get('x-frontier-trace')\`.

${VERIFY}`;
    case 'python-new':
      return `${head}
## Steps
1. \`pip install "openai>=1.0"\` in the project's virtualenv.
2. Create the client once:
\`\`\`python
import os
from openai import OpenAI
ai = OpenAI(base_url="${baseUrl}/v1", api_key=os.environ["POTION_API_KEY"])
\`\`\`
3. Call it with \`model="${routerModel}"\`:
\`\`\`python
res = ai.chat.completions.create(model="${routerModel}", messages=[{"role": "user", "content": "..."}])
\`\`\`
4. Streaming (\`stream=True\`) and tools work as in the OpenAI SDK docs.
5. Read the receipt with the raw response: \`raw = ai.chat.completions.with_raw_response.create(...)\`, then \`raw.headers["x-frontier-trace"]\` and \`raw.parse()\` for the completion.

${VERIFY}`;
    case 'ai-sdk':
      return `${head}
## Steps
- **Vercel AI SDK** (\`ai\` v5+ with \`@ai-sdk/openai\` v2+/v4): \`const potion = createOpenAI({ baseURL: '${baseUrl}/v1', apiKey: process.env.POTION_API_KEY, headers: { 'x-potion-cluster': '<kind of work>' } })\` and use \`potion.chat('${routerModel}')\` — NOT \`potion('${routerModel}')\`, which builds a Responses-API model and posts to \`/responses\`, which Potion does not serve. (\`@ai-sdk/openai-compatible\` also works.) Keep \`streamText\`/\`generateText\` calls as they are. To read the receipt without consuming the stream, pass a \`fetch\` wrapper to \`createOpenAI\` that records \`response.headers.get('x-frontier-trace')\` and \`x-potion-model\`.
- **LangChain**: construct \`ChatOpenAI\` with \`base_url="${baseUrl}/v1"\` (Python) / \`configuration: { baseURL }\` (JS), \`api_key\` from \`POTION_API_KEY\`, and \`model="${routerModel}"\`. Tool binding works unchanged.
- Replace every hard-coded provider model id in chains/agents with \`${routerModel}\`.

${VERIFY}`;
    case 'http':
    default:
      return `${head}
## Steps
1. POST \`${baseUrl}/v1/chat/completions\` with headers \`Authorization: Bearer $POTION_API_KEY\` and \`Content-Type: application/json\`.
2. Body is the OpenAI chat-completions shape: \`{"model":"${routerModel}","messages":[{"role":"user","content":"..."}]}\`; add \`"stream": true\` for server-sent events.
3. Parse the response exactly as an OpenAI response. Use a 90-second timeout for chat and read \`usage\` for token counts; \`max_tokens\` is honored.
4. Responses also carry \`x-ratelimit-remaining-requests\` (a per-second bucket of 10) — retry on 429 with a short backoff.

${VERIFY}`;
  }
}

