'use client';

// "HAND THIS TO YOUR AGENT" (operator, 2026-08-22): time to value for a
// team whose integration is done by Claude Code or another coding agent.
// One instruction block per situation, written FOR the agent — concrete
// steps, what to change, what to keep, how to verify, what never to do.
// The key is never embedded: the block tells the agent where to read it.
import { useState } from 'react';

type Situation = 'node-new' | 'python-new' | 'openai-sdk' | 'gateway' | 'ai-sdk' | 'http';

const SITUATIONS: { id: Situation; label: string }[] = [
  { id: 'openai-sdk', label: 'Existing app on the OpenAI SDK' },
  { id: 'gateway', label: 'Existing app on another gateway' },
  { id: 'node-new', label: 'New project · Node / TypeScript' },
  { id: 'python-new', label: 'New project · Python' },
  { id: 'ai-sdk', label: 'Vercel AI SDK or LangChain' },
  { id: 'http', label: 'Anything else over HTTP' },
];

const VERIFY = `## Verify
1. Send one real request through the app (or the snippet above).
2. Confirm the response carries the header \`x-frontier-trace\` — it is Potion's receipt: the kind of work, the strategy, the rule, and whether the evidence was live. Its absence means the request did not go through Potion.
3. Open the Potion dashboard: the request appears under Home → "Your first receipt" with what it cost against the premium pick.

## Never
- Never print, log, or commit the Potion key. Read it from the environment variable \`POTION_API_KEY\`.
- Never change the request or response handling: Potion speaks the OpenAI chat protocol, including streaming and tool calls.
- Never pin a provider model name to "win" a task. Use \`potion-auto\`; the rule on the key decides, and the receipt shows the choice.`;

function block(s: Situation, baseUrl: string): string {
  const head = `# Route this app's AI requests through Potion

You are integrating Potion, a measured model router with an OpenAI-compatible API.
Base URL: ${baseUrl}/v1
Key: read \`POTION_API_KEY\` from the environment (the human has set it; do not ask for it, do not echo it).
Model label: \`potion-auto\` (any other label is accepted and treated the same; routing is decided by the rule bound to the key).
`;
  switch (s) {
    case 'openai-sdk':
      return `${head}
## Steps
1. Find every place an OpenAI client is constructed (\`new OpenAI(...)\` in JS/TS, \`OpenAI(...)\` in Python, or equivalent). There may be more than one.
2. Set the base URL to \`${baseUrl}/v1\` and the API key to \`process.env.POTION_API_KEY\` / \`os.environ["POTION_API_KEY"]\`. Keep every other option.
3. Set \`model\` to \`"potion-auto"\` on chat-completions calls. Leave messages, temperature, streaming, tools, tool_choice, max_tokens untouched.
4. If the code branches on the provider model name in responses (e.g. parsing \`response.model\`), make it tolerant: Potion returns the label you sent.
5. Run the existing test suite; nothing else should change.

${VERIFY}`;
    case 'gateway':
      return `${head}
## Steps
1. Find the gateway's base URL and key in config/env (e.g. \`OPENROUTER_API_KEY\`, \`*_BASE_URL\`). Replace the base URL with \`${baseUrl}/v1\` and the key with \`POTION_API_KEY\`. Do not delete the old values; comment them so the human can roll back.
2. Replace every hard-coded provider model id (e.g. \`openai/gpt-4.1\`, \`anthropic/claude-...\`) with \`potion-auto\`. If the app lets users pick a model, keep the picker but map every choice to \`potion-auto\` for now and note it for the human.
3. Remove gateway-specific headers (referer/title/ranking headers); Potion ignores them but they are noise.
4. Keep streaming and tool-call code exactly as it is.

${VERIFY}`;
    case 'node-new':
      return `${head}
## Steps
1. \`npm install openai\` (or pnpm/yarn).
2. Create the client once:
\`\`\`ts
import OpenAI from 'openai';
export const ai = new OpenAI({ baseURL: '${baseUrl}/v1', apiKey: process.env.POTION_API_KEY });
\`\`\`
3. Call it with \`model: 'potion-auto'\`:
\`\`\`ts
const res = await ai.chat.completions.create({ model: 'potion-auto', messages: [{ role: 'user', content: '...' }] });
\`\`\`
4. Streaming and tools work as in the OpenAI SDK docs; nothing Potion-specific is needed.

${VERIFY}`;
    case 'python-new':
      return `${head}
## Steps
1. \`pip install openai\`.
2. Create the client once:
\`\`\`python
import os
from openai import OpenAI
ai = OpenAI(base_url="${baseUrl}/v1", api_key=os.environ["POTION_API_KEY"])
\`\`\`
3. Call it with \`model="potion-auto"\`:
\`\`\`python
res = ai.chat.completions.create(model="potion-auto", messages=[{"role": "user", "content": "..."}])
\`\`\`
4. Streaming (\`stream=True\`) and tools work as in the OpenAI SDK docs.

${VERIFY}`;
    case 'ai-sdk':
      return `${head}
## Steps
- **Vercel AI SDK**: use the OpenAI-compatible provider with \`baseURL: '${baseUrl}/v1'\` and \`apiKey: process.env.POTION_API_KEY\`; pass \`'potion-auto'\` as the model id. Example: \`createOpenAI({ baseURL, apiKey })('potion-auto')\`. Keep \`streamText\`/\`generateText\` calls as they are.
- **LangChain**: construct \`ChatOpenAI\` with \`base_url="${baseUrl}/v1"\` (Python) / \`configuration: { baseURL }\` (JS), \`api_key\` from \`POTION_API_KEY\`, and \`model="potion-auto"\`. Tool binding works unchanged.
- Replace every hard-coded provider model id in chains/agents with \`potion-auto\`.

${VERIFY}`;
    case 'http':
    default:
      return `${head}
## Steps
1. POST \`${baseUrl}/v1/chat/completions\` with headers \`Authorization: Bearer $POTION_API_KEY\` and \`Content-Type: application/json\`.
2. Body is the OpenAI chat-completions shape: \`{"model":"potion-auto","messages":[{"role":"user","content":"..."}]}\`; add \`"stream": true\` for server-sent events.
3. Parse the response exactly as an OpenAI response.

${VERIFY}`;
  }
}

export function AgentInstructions({ baseUrl }: { baseUrl: string }) {
  const [situation, setSituation] = useState<Situation>('openai-sdk');
  const [copied, setCopied] = useState(false);
  const text = block(situation, baseUrl);
  return (
    <div className="border border-[#d9d5cb] bg-[#fbfaf7]">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#d9d5cb] px-4 py-2.5">
        <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-faint">hand this to your agent · claude code, cursor, codex, anything</div>
        <button
          type="button"
          onClick={() => { void navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1800); }}
          className="bg-ink px-3 py-1 font-mono text-[11px] text-[#f4f2ec] hover:opacity-90"
        >
          {copied ? 'copied' : 'copy instructions'}
        </button>
      </div>
      <div className="flex flex-wrap gap-px border-b border-[#d9d5cb] bg-[#d9d5cb]">
        {SITUATIONS.map((s) => (
          <button key={s.id} type="button" onClick={() => setSituation(s.id)} className={`px-3 py-1.5 font-mono text-[11px] ${situation === s.id ? 'bg-ink text-[#f4f2ec]' : 'bg-[#fbfaf7] text-soft hover:text-ink'}`}>
            {s.label}
          </button>
        ))}
      </div>
      <pre className="max-h-72 overflow-auto whitespace-pre-wrap px-4 py-3 font-mono text-[11px] leading-relaxed text-soft">{text}</pre>
      <p className="border-t border-[#d9d5cb] px-4 py-2 font-mono text-[10px] text-faint">Paste it into your agent with your key already in the environment. The block never contains the key.</p>
    </div>
  );
}
