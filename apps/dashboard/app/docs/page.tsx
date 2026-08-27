// /docs — the reference, and now a PUBLIC one.
//
// Two changes from the version that lived behind the auth wall.
//
// PUBLIC. Docs you have to sign in to read cannot answer the question
// someone has before they sign in. middleware.ts opens /docs, which means
// this page must render with no session — so the /api/connection call is now
// best-effort and every failure (401 included, not just an unreachable
// server) falls back to the generic form. It previously caught only
// ApiUnreachable, so a signed-out reader would have got a 500.
//
// PERSONALISED WHEN IT CAN BE. Signed in, the base URL and the reader's own
// bound policy are filled in from their org, because docs that say
// `https://api.example.com` are docs someone has to translate before they can
// use them. Signed out, the placeholders are honest about being placeholders.
//
// It still states the two things that surprise people, because both are
// load-bearing and neither is guessable: `model` is a LABEL, and appearing in
// the catalogue is not the same as being routable.
import { apiFetch } from '@/lib/api';
import { CopyBlock } from '@/components/copy-block';
import { SiteShell } from '@/components/site-header';
import { AgentInstructions } from '@/components/agent-instructions';
import { DocsAsk } from '@/components/docs-ask';
import type { ConnectionResponse } from '@/lib/types';

export const dynamic = 'force-dynamic';

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} className="scroll-mt-8 space-y-4">
      <h2 className="text-lg font-medium tracking-tight text-ink">{title}</h2>
      {children}
    </section>
  );
}

function Endpoint({ method, path, note }: { method: string; path: string; note: string }) {
  return (
    <li className="flex flex-col gap-1 border-b border-line py-3 last:border-0 sm:flex-row sm:items-baseline sm:gap-4">
      <span className="shrink-0 font-mono text-xs">
        <span className="mr-2 rounded bg-accent-soft px-1.5 py-0.5 font-medium text-accent">{method}</span>
        <span className="text-ink">{path}</span>
      </span>
      <span className="text-xs leading-relaxed text-soft">{note}</span>
    </li>
  );
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <tr className="border-b border-line last:border-0">
      <td className="whitespace-nowrap py-3 pr-6 align-top font-mono text-xs text-ink">{k}</td>
      <td className="py-3 text-xs leading-relaxed text-soft">{v}</td>
    </tr>
  );
}

const CONTENTS = [
  ['ask', 'Ask the docs'],
  ['quickstart', 'Quickstart'],
  ['agent', 'Hand it to your agent'],
  ['auth', 'Authentication'],
  ['model', 'The model field is a label'],
  ['trace', 'The decision header'],
  ['policies', 'Policies'],
  ['workloads', 'Workload types'],
  ['compat', 'Streaming and compatibility'],
  ['errors', 'Errors'],
  ['limits', 'Limits and budgets'],
  ['api', 'API reference'],
  ['honest', 'Things worth knowing'],
] as const;

/** The taxonomy Potion classifies into. Names mirror packages/cluster/data/taxonomy.json. */
const WORKLOADS: [string, string][] = [
  ['code-gen', 'Writing code to a specification'],
  ['code-review', 'Finding defects in code and explaining their impact'],
  ['extraction', 'Pulling structured fields out of unstructured documents'],
  ['summarization', 'Condensing a document while preserving what matters'],
  ['classification', 'Assigning a label from a fixed set'],
  ['multi-step-reasoning', 'Problems needing several dependent steps'],
  ['creative', 'Open-ended writing where there is no single right answer'],
  ['rewrite-edit', 'Revising text to a brief without changing its meaning'],
  ['rag-answer', 'Answering from supplied source passages'],
  ['agentic-tool-use', 'Planning and sequencing tool calls'],
];

export default async function DocsPage() {
  // Best-effort: this page is public, so a missing or rejected session is an
  // ordinary state, not an error. Any failure falls through to placeholders.
  let conn: ConnectionResponse | null = null;
  try {
    conn = await apiFetch<ConnectionResponse>('/api/connection');
  } catch {
    conn = null;
  }
  // Signed out there is no connection response; never hand out a stale host.
  const base = conn?.baseUrl ?? process.env.POTION_PUBLIC_API_URL ?? 'https://api.withpotion.com';

  const body = (
    <div className="max-w-3xl space-y-12">
      <div>
        <h1 className="text-[2rem] font-medium leading-[1.12] tracking-[-0.02em] text-ink">Docs</h1>
        <p className="mt-2 text-sm leading-relaxed text-soft">
          Potion speaks the OpenAI chat-completions protocol. If you already have an OpenAI client,
          you change one line and keep everything else — the request body, the response shape,
          streaming and tool calls are unchanged.
        </p>
        {!conn && (
          <p className="mt-4 border border-[#d9d5cb] bg-[#fbfaf7] px-4 py-3 text-xs leading-relaxed text-faint">
            You are reading this signed out, so the base URL below is the generic one and the
            policy section shows the four shapes rather than yours.{' '}
            <a href="/login" className="text-accent underline">Sign in</a> and this page fills in
            with your own endpoint and bound policy.
          </p>
        )}
        <nav className="mt-6 flex flex-wrap gap-x-5 gap-y-2 border-t border-line pt-5 text-xs">
          {CONTENTS.map(([id, label]) => (
            <a key={id} href={`#${id}`} className="text-soft transition-colors hover:text-accent">
              {label}
            </a>
          ))}
        </nav>
      </div>

      {/* The page answering its own questions, through Potion. The answer
          is drawn from this page's prose only (lib/docs-text.ts) and the
          receipt under it is the real x-frontier-trace — the product doing
          the thing the section below describes. */}
      <nav className="mb-10 border border-[#d9d5cb] bg-[#fbfaf7] px-6 py-4 text-[12.5px] leading-relaxed text-soft">
        <span className="mr-2 font-mono text-[11.5px] uppercase tracking-[0.13em] text-faint">On this page</span>
        <a href="#quickstart" className="text-accent underline">Quickstart</a> · <a href="#agent" className="text-accent underline">Hand it to your agent</a> · <a href="#auth" className="text-accent underline">Authentication</a> · <a href="#model" className="text-accent underline">The model field</a> · <a href="#trace" className="text-accent underline">The decision header</a> · <a href="#receipts" className="text-accent underline">Receipts &amp; kept</a> · <a href="#policies" className="text-accent underline">Policies</a> · <a href="#controls" className="text-accent underline">Bar, floor, pins</a> · <a href="#workloads" className="text-accent underline">Workload types</a> · <a href="#compat" className="text-accent underline">Streaming</a> · <a href="#errors" className="text-accent underline">Errors</a> · <a href="#limits" className="text-accent underline">Limits</a> · <a href="#pricing" className="text-accent underline">Pricing</a> · <a href="#traces-api" className="text-accent underline">Agent journeys</a> · <a href="#api" className="text-accent underline">API reference</a> · <a href="#honest" className="text-accent underline">Things worth knowing</a>
      </nav>

      <Section id="ask" title="Ask the docs">
        <p className="text-sm leading-relaxed text-soft">
          A question about anything on this page, answered from this page, served through Potion as{' '}
          <code className="font-mono text-xs">rag-answer</code> — with the receipt it got.
        </p>
        <DocsAsk />
      </Section>

      <Section id="quickstart" title="Quickstart">
        <ol className="space-y-2 text-sm leading-relaxed text-soft">
          <li>
            <span className="font-medium text-ink">1.</span> Create a serving key on{' '}
            <a href="/settings/keys" className="text-accent underline">API keys</a>.
          </li>
          <li>
            <span className="font-medium text-ink">2.</span> Point your client at the base URL below.
          </li>
          <li>
            <span className="font-medium text-ink">3.</span> Send a request. Watch it appear on{' '}
            <a href="/" className="text-accent underline">Connect</a> with the routing decision it got.
          </li>
        </ol>
        <CopyBlock label="Base URL" text={`${base}/v1`} />
        {/* The server personalises these against the org's bound policy, but a
            brand-new reader has no policy yet — and a quickstart missing its
            two main examples is the one moment the docs must not have a hole.
            Fall back to the generic form, which is correct for everyone. */}
        <CopyBlock
          label="curl"
          text={
            conn?.snippets?.curl ??
            `curl ${base}/v1/chat/completions \\\n  -H "Authorization: Bearer $POTION_API_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '{"model":"potion-auto","messages":[{"role":"user","content":"Write a python function that reverses a string"}]}'`
          }
        />
        <CopyBlock
          label="Node.js (openai SDK)"
          text={
            conn?.snippets?.openaiNode ??
            `import OpenAI from 'openai';\n\nconst client = new OpenAI({\n  baseURL: '${base}/v1',\n  apiKey: process.env.POTION_API_KEY,\n});\n\nconst res = await client.chat.completions.create({\n  model: 'potion-auto', // any label; Potion routes by prompt + policy\n  messages: [{ role: 'user', content: 'Write a python function that reverses a string' }],\n});\nconsole.log(res.choices[0].message.content);`
          }
        />
        <CopyBlock
          label="Python (openai SDK)"
          text={`from openai import OpenAI\n\nclient = OpenAI(\n    base_url="${base}/v1",\n    api_key=os.environ["POTION_API_KEY"],\n)\n\nres = client.chat.completions.create(\n    model="potion-auto",  # any label; Potion routes by prompt + policy\n    messages=[{"role": "user", "content": "Write a python function that reverses a string"}],\n)\nprint(res.choices[0].message.content)`}
        />
      </Section>

      <Section id="agent" title="Hand it to your agent">
        <p className="text-sm leading-relaxed text-soft">
          If Claude Code, Cursor, Codex or another coding agent does your integration, give it one of these. Each block
          is written for the agent: what to change, what to keep, how to verify, and what never to do. Your key is not
          in the block; the agent reads it from the environment.
        </p>
        <div className="mt-4">
          <AgentInstructions baseUrl={base} />
        </div>
      </Section>

      <Section id="auth" title="Authentication">
        <p className="text-sm leading-relaxed text-soft">
          Every call carries a serving key as a bearer token:{' '}
          <code className="font-mono text-xs">Authorization: Bearer $POTION_API_KEY</code>. Keys
          come in two scopes. A <code className="font-mono text-xs">serve</code> key sends traffic
          and reads its own state; <code className="font-mono text-xs">serve+admin</code> is
          additionally allowed to provision — mint keys, move budgets, rebind policy.
        </p>
        <p className="text-sm leading-relaxed text-soft">
          A key is shown once, at creation, and stored only as a SHA-256 hash. Potion cannot show it
          to you again and will not pretend otherwise — if it is lost, revoke it and mint another.
          Each key carries its own policy binding, so separate keys are how you run different
          trade-offs side by side.
        </p>
        <p className="text-xs leading-relaxed text-faint">
          You do not bring provider keys. Potion serves every request from its own, across
          providers — which is also what lets the router reach the whole catalogue rather than the
          one account you happened to have.
        </p>
      </Section>

      <Section id="model" title="The model field means what it says">
        <p className="text-sm leading-relaxed text-soft">
          <span className="font-medium text-ink">Your router has a name</span>:{' '}
          <code className="font-mono text-xs">potion/&lt;your-org&gt;</code> — shown on your{' '}
          <a href="/router" className="text-accent underline">Router page</a> and first in{' '}
          <code className="font-mono text-xs">GET /v1/models</code>. It is the model id to put in
          your code: Potion compiles that router from your workload, quality bar, and the measured
          frontiers, versions it as the evidence moves, and your receipts name the version each
          request rode. <code className="font-mono text-xs">potion-auto</code> is the plain alias —
          the two route identically.
        </p>
        <p className="text-sm leading-relaxed text-soft">
          Three cases, no surprises. <code className="font-mono text-xs">potion/&lt;your-org&gt;</code>{' '}
          (or <code className="font-mono text-xs">potion-auto</code>){' '}
          <span className="font-medium text-ink">routes</span>: Potion classifies the request and
          serves the measured pick under your policy. A{' '}
          <span className="font-medium text-ink">known model name pins</span>: exactly that model
          answers, the trace says <code className="font-mono text-xs">policy=pinned</code>, and
          nothing overrides your explicit choice. An{' '}
          <span className="font-medium text-ink">unknown name is an error</span>{' '}
          (<code className="font-mono text-xs">400 unknown_model</code>) — never a silent reroute.
        </p>
        <p className="text-sm leading-relaxed text-soft">
          Migrating an app whose model strings you cannot change yet? Flip{' '}
          <span className="font-medium text-ink">migration mode</span> in{' '}
          <a href="/settings/controls" className="text-accent underline">Settings · Controls</a>{' '}
          (or <code className="font-mono text-xs">PUT /api/org-settings</code>) and every label
          routes like <code className="font-mono text-xs">potion-auto</code> — an explicit,
          org-level choice. The receipt always names what actually answered.
        </p>
      </Section>

      <Section id="trace" title="The decision header">
        <p className="text-sm leading-relaxed text-soft">
          Every response carries <code className="font-mono text-xs">x-frontier-trace</code>, which
          is the routing decision in full. A router you cannot audit is a router you cannot trust,
          so this ships on every request rather than behind a debug flag.
        </p>
        <CopyBlock
          label="x-frontier-trace"
          text={`cluster=code-gen;strategy=6efe8a56;frontier=v2;policy=min_cost;fallback=0;provenance=live`}
        />
        <div className="overflow-x-auto border border-[#d9d5cb] bg-[#fbfaf7] px-6 py-2">
          <table className="w-full">
            <tbody>
              <Row k="cluster" v="The workload type the prompt was classified into." />
              <Row k="strategy" v="First 8 characters of the selected strategy hash — the exact configuration served, resolvable in Frontiers." />
              <Row k="frontier" v="Which published frontier version the choice came from. It increments when new evidence republishes." />
              <Row k="policy" v={<>The rule that selected the point: <code className="font-mono">min_cost</code>, <code className="font-mono">max_quality</code>, <code className="font-mono">latency_bound</code>, <code className="font-mono">compound</code> — or <code className="font-mono">pinned</code>, when you named the model yourself.</>} />
              <Row k="fallback" v={<><span className="font-medium text-soft">0</span> means a measured frontier existed and your policy selected a point on it. <span className="font-medium text-soft">1</span> means it did not, and the request rode the default strategy — the honest signal that Potion has nothing measured for this work yet.</>} />
              <Row k="provenance" v={<><span className="font-medium text-soft">live</span> means the evidence behind the choice came from real provider runs. Anything else means it did not, and should not be treated as a measurement.</>} />
              <Row k="x-potion-model" v={<>A sibling header naming the model that actually answered — also stamped onto your request log as <code className="font-mono">served_model</code>, so the ledger never guesses.</>} />
              <Row k="constrained" v={<>Present only as <code className="font-mono">constrained=tools</code>, when the request carried <code className="font-mono">tools</code> and your policy&apos;s optimum was a prompt-transforming strategy. Selection narrowed to single-model points, which the tool contract requires. Your policy&apos;s bound still held — a quality floor, cost ceiling or latency bound is never breached by narrowing, only its optimum is — so <code className="font-mono">fallback</code> stays 0.</>} />
            </tbody>
          </table>
        </div>
      </Section>

      <Section id="receipts" title="Receipts and the kept line">
        <p className="text-sm leading-relaxed text-soft">
          Every token, accounted for. Each served request becomes a row on{' '}
          <a href="/receipts" className="text-accent underline">Receipts</a>: when it ran, the kind
          of work, the model that answered, what it cost — and what your named baseline{' '}
          <span className="font-medium text-ink">would</span> have cost, recorded{' '}
          <span className="font-medium text-ink">at serve time</span> from real token counts, never
          reconstructed later. The difference is the <span className="font-semibold text-kept">kept</span>{' '}
          line, and the month&rsquo;s kept lines sum to the savings figure on Today — the same number,
          all the way up.
        </p>
        <p className="text-sm leading-relaxed text-soft">
          Programmatic access: <code className="font-mono text-xs">GET /api/routing-activity</code>{' '}
          returns the rows (<code className="font-mono text-xs">servedModel</code>,{' '}
          <code className="font-mono text-xs">costUsd</code>,{' '}
          <code className="font-mono text-xs">baselineCostUsd</code>, the parsed trace, and a
          summary that counts only requests which carried a routing decision).
        </p>
      </Section>

      <Section id="policies" title="Policies">
        <p className="text-sm leading-relaxed text-soft">
          A policy is the rule Potion optimises under. It is bound per key, and applies to every
          request that key sends.
        </p>
        <ul className="space-y-2 text-sm text-soft">
          <li><code className="font-mono text-xs text-ink">min_cost</code> — cheapest option holding a quality floor.</li>
          <li><code className="font-mono text-xs text-ink">max_quality</code> — best measured quality under a cost ceiling.</li>
          <li><code className="font-mono text-xs text-ink">latency_bound</code> — best quality inside a p95 latency budget.</li>
          <li><code className="font-mono text-xs text-ink">compound</code> — a quality floor <em>and</em> a latency bound, cheapest of the survivors.</li>
        </ul>
        <p className="text-xs leading-relaxed text-faint">
          Cost ceilings are expressed per <span className="font-medium text-soft">1,000 requests</span>,
          not per 1,000 tokens. Latency bounds are p95 in milliseconds.
        </p>
        {conn?.policy && (
          <p className="border border-[#d9d5cb] bg-[#fbfaf7] px-4 py-3 text-sm text-soft">
            <span className="text-xs uppercase tracking-wide text-faint">Yours right now</span>
            <br />
            {conn.policy.description}
          </p>
        )}
        <CopyBlock
          label="Rebind this key's policy"
          text={`curl -X POST ${base}/v1/policies \\\n  -H "Authorization: Bearer $POTION_API_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '{"type":"min_cost","qualityFloor":0.8}'`}
        />
      </Section>

      <Section id="controls" title="Your bar, your floor, your pins">
        <p className="text-sm leading-relaxed text-soft">
          <span className="font-medium text-ink">Name what you use today</span>{' '}
          (<code className="font-mono text-xs">PUT /api/incumbents</code>) and your quality bar
          becomes a measurement against <em>your own model on your own traffic</em> rather than a
          number we picked. Potion samples consented requests (capped per kind of work, personal
          data redacted), measures, and then <span className="font-medium text-ink">proposes your
          bar</span> — the proposal appears on Today and applies in one click
          (<code className="font-mono text-xs">POST /api/learning/proposals/:id/apply</code>).
        </p>
        <p className="text-sm leading-relaxed text-soft">
          <span className="font-medium text-ink">The floor</span>{' '}
          (<code className="font-mono text-xs">PUT /api/floor</code>) sets the org-wide quality
          minimum and rebinds every live key.{' '}
          <span className="font-medium text-ink">Pins</span>{' '}
          (<code className="font-mono text-xs">GET/PUT/DELETE /api/pins</code>) freeze the exact
          frontier version serving a workload — useful while you run your own comparisons — and{' '}
          <code className="font-mono text-xs">GET /api/frontier-changelog</code> narrates every
          movement in plain English, including what a pin is holding back.
        </p>
      </Section>

      <Section id="workloads" title="Workload types">
        <p className="text-sm leading-relaxed text-soft">
          Every prompt is classified into one of these before anything is selected. Each has its own
          frontier, because the best strategy for extraction is not the best strategy for
          multi-step reasoning — that difference is the entire reason routing pays.
        </p>
        <div className="overflow-x-auto border border-[#d9d5cb] bg-[#fbfaf7] px-6 py-2">
          <table className="w-full">
            <tbody>
              {WORKLOADS.map(([id, what]) => (
                <Row key={id} k={id} v={what} />
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-xs leading-relaxed text-faint">
          A prompt that matches none of them confidently is served on the default strategy, and the
          trace says <code className="font-mono">fallback=1</code> rather than guessing.
        </p>
      </Section>

      <Section id="compat" title="Streaming and compatibility">
        <p className="text-sm leading-relaxed text-soft">
          Set <code className="font-mono text-xs">stream: true</code> and you get standard
          server-sent events terminated by <code className="font-mono text-xs">data: [DONE]</code>,
          the same as any OpenAI-compatible client expects. The routing decision is chosen before
          the first token, so <code className="font-mono text-xs">x-frontier-trace</code> is present
          on the response headers even while the body is still streaming.
        </p>
        <ul className="space-y-2 text-sm leading-relaxed text-soft">
          <li><span className="font-medium text-ink">Tools and function calling</span> pass through to the selected model unchanged. Because tool semantics cannot survive a strategy that rewrites or fans out the prompt, a request carrying <code className="font-mono text-xs">tools</code> is served from a single-model point; if that is not your policy&apos;s optimum, the trace says <code className="font-mono text-xs">constrained=tools</code>.</li>
          <li><span className="font-medium text-ink">Token usage and cost</span> come back on the response, taken from the provider’s own reported figures where it reports them rather than from a modelled estimate.</li>
          <li><span className="font-medium text-ink">Agentic loops</span> work as in OpenAI: an assistant turn carrying <code className="font-mono text-xs">tool_calls</code> and the <code className="font-mono text-xs">role: &quot;tool&quot;</code> result turns are accepted and forwarded to the model verbatim.</li>
          <li><span className="font-medium text-ink">Request parameters</span> forwarded to the selected model: <code className="font-mono text-xs">temperature</code>, <code className="font-mono text-xs">top_p</code>, <code className="font-mono text-xs">stop</code>, <code className="font-mono text-xs">seed</code>, <code className="font-mono text-xs">user</code>, <code className="font-mono text-xs">response_format</code> (JSON mode and JSON schema), <code className="font-mono text-xs">parallel_tool_calls</code>, <code className="font-mono text-xs">max_tokens</code>. <code className="font-mono text-xs">response_format</code> and <code className="font-mono text-xs">stop</code>, like tools, are served only by single-model points. In JSON mode a model that fences its object in <code className="font-mono text-xs">```json</code> has the fence removed on non-streaming responses when the inside parses, so <code className="font-mono text-xs">JSON.parse</code> works as it does on OpenAI. <code className="font-mono text-xs">n</code> must be 1.</li>
          <li><span className="font-medium text-ink">Content-part arrays</span> are accepted; text parts are joined. Image parts are refused with <code className="font-mono text-xs">400 unsupported_content</code> until a vision frontier is measured — never silently dropped.</li>
          <li><span className="font-medium text-ink">Typed routing on the response</span>: every non-streaming answer carries a top-level <code className="font-mono text-xs">potion</code> object — requested vs resolved cluster and policy, <code className="font-mono text-xs">policy_source</code> (<code className="font-mono text-xs">key_default</code> when you sent no override — omitting <code className="font-mono text-xs">x-potion-policy</code> is the convention for &quot;use the policy bound to this key&quot;), the model that answered, and <code className="font-mono text-xs">fallback</code> with a <code className="font-mono text-xs">fallback_reason</code> (<code className="font-mono text-xs">policy_infeasible</code> means no measured point met your bar and the best point served). The <code className="font-mono text-xs">x-frontier-trace</code> header stays the source record.</li>
          <li><span className="font-medium text-ink">Policy discovery</span>: <code className="font-mono text-xs">GET /v1/policies</code> lists your org&apos;s policies with ids and names and marks the one bound to the calling key — populate a selector from it instead of guessing identifiers. An unknown <code className="font-mono text-xs">x-potion-policy</code> returns <code className="font-mono text-xs">policy_not_found</code> with the available policies and the safe default in the error.</li>
          <li><span className="font-medium text-ink">x-latency-contract</span> appears only when a measured combination cannot token-stream: the value <code className="font-mono text-xs">non-streamed</code> means the answer arrives as one JSON body despite <code className="font-mono text-xs">stream: true</code>.</li>
          <li><span className="font-medium text-ink">Legacy completions</span> are shimmed at <code className="font-mono text-xs">/v1/completions</code>.</li>
        </ul>
      </Section>

      <Section id="errors" title="Errors">
        <p className="text-sm leading-relaxed text-soft">
          Errors use the OpenAI envelope — <code className="font-mono text-xs">{'{ error: { message, type, param, code } }'}</code>{' '}
          — so existing client error handling keeps working.
        </p>
        <div className="overflow-x-auto border border-[#d9d5cb] bg-[#fbfaf7] px-6 py-2">
          <table className="w-full">
            <tbody>
              <Row k="400 invalid_request_error" v="The body did not validate — a missing messages array, a malformed policy." />
              <Row k="400 unsupported_content" v="The messages carry image parts; Potion routes text only for now. The message says how many." />
              <Row k="401 authentication_required" v="No bearer token was supplied." />
              <Row k="401 invalid_api_key" v="The key is unknown, revoked or expired." />
              <Row k="403" v={<>The key is valid but its scope does not cover this call — provisioning with a <code className="font-mono">serve</code> key rather than <code className="font-mono">serve+admin</code>.</>} />
              <Row k="413" v="The request body exceeds the accepted size." />
              <Row k="400 unknown_model" v={<>The <code className="font-mono">model</code> value is neither <code className="font-mono">potion-auto</code> nor a model Potion serves. Name one from <code className="font-mono">/v1/models</code>, or enable migration mode.</>} />
              <Row k="400 cluster_not_found" v={<>An explicit <code className="font-mono">X-Potion-Cluster</code> hint named a cluster that does not exist.</>} />
              <Row k="403 insufficient_role" v={<>The call needs a higher role — minting keys, rebinding policies, applying proposals and flipping org settings are admin actions.</>} />
              <Row k="429 rate_limit_exceeded" v="Too many requests. Back off and retry." />
              <Row k="429 budget_exceeded" v="Your spend cap would be crossed by this call. Refused BEFORE the provider is called, so it costs nothing." />
              <Row k="503 service_unavailable" v="No upstream could serve the request." />
            </tbody>
          </table>
        </div>
      </Section>

      <Section id="limits" title="Limits and budgets">
        <p className="text-sm leading-relaxed text-soft">
          A budget is a cap on spend with an optional hard stop. The check runs{' '}
          <span className="font-medium text-ink">before</span> the upstream call, so a refused
          request costs nothing — a cap that only notices after the money is gone is not a cap.
          Set it on <a href="/usage" className="text-accent underline">Usage</a> or through{' '}
          <code className="font-mono text-xs">/api/budgets</code>.
        </p>
        <p className="text-sm leading-relaxed text-soft">
          Rate limits are enforced per key. A limited response carries the standard retry hints;
          treat <code className="font-mono text-xs">429</code> as backpressure rather than failure.
        </p>
      </Section>

      <Section id="api" title="API reference">
        <p className="text-sm leading-relaxed text-soft">
          Everything this dashboard does is an HTTP call you can make yourself with a Bearer token.
          A <span className="font-mono text-xs">serve</span> key covers the serving surface and its
          own reads; provisioning needs <span className="font-mono text-xs">serve+admin</span>.
        </p>
        <ul className="border border-[#d9d5cb] bg-[#fbfaf7] px-6 py-2">
          <Endpoint method="POST" path="/v1/chat/completions" note="Serve a request. OpenAI-compatible; streaming supported." />
          <Endpoint method="POST" path="/v1/completions" note="Legacy completions shim." />
          <Endpoint method="POST" path="/v1/embeddings" note="Platform embedder." />
          <Endpoint method="GET" path="/v1/models" note="The catalogue, with potion.measured marking what is actually routable." />
          <Endpoint method="GET / POST" path="/v1/policies" note="Read or rebind the calling key's own policy." />
          <Endpoint method="POST" path="/api/plan" note="Describe what you're building → workload type + measured options. member+" />
          <Endpoint method="GET" path="/api/connection" note="Base URL, bound policy, keys, per-cluster routing readiness." />
          <Endpoint method="GET" path="/api/routing-activity" note="Recent requests with the routing decision each one got." />
          <Endpoint method="GET / POST" path="/api/api-keys" note="List or mint keys. Minting requires serve+admin." />
          <Endpoint method="GET / PUT" path="/api/budgets" note="Spending cap and hard stop. admin" />
          <Endpoint method="GET" path="/api/usage" note="Requests, tokens and spend; /api/usage/current for the live day; /api/usage/invoice for the period invoice." />
          <Endpoint method="PUT" path="/api/incumbents" note="Name what you use today; starts consented measurement. admin" />
          <Endpoint method="GET" path="/api/learning" note="Sampling progress and bar proposals; POST /api/learning/proposals/:id/apply accepts one. admin to apply" />
          <Endpoint method="PUT" path="/api/floor" note="Org-wide quality floor; rebinds every live key. admin" />
          <Endpoint method="GET / PUT / DELETE" path="/api/pins/:clusterId" note="Freeze or release the frontier version serving a workload. admin to change" />
          <Endpoint method="GET" path="/api/frontier-changelog" note="Every frontier movement, narrated." />
          <Endpoint method="GET" path="/api/certifications" note="Suite certifications — what is vouched for, and what was refused." />
          <Endpoint method="GET / PUT" path="/api/org-settings" note="Model-field semantics: migration mode on or off. admin to change" />
          <Endpoint method="POST" path="/v1/traces" note="Agent spans in; priced, loop-flagged, clustered into agent-* workloads." />
          <Endpoint method="GET / PUT" path="/api/traces/retention" note="Span retention in days; 0 keeps metadata only. admin to change" />
          <Endpoint method="GET" path="/api/audit" note="Key custody, sign-ins and incidents, one chronology; /api/audit/export.jsonl for a window. admin" />
        </ul>
      </Section>

      <Section id="pricing" title="Pricing: aligned by construction">
        <p className="text-sm leading-relaxed text-soft">
          Model costs pass through <span className="font-medium text-ink">at cost</span>. Potion&rsquo;s
          revenue is a <span className="font-medium text-ink">share of the savings your receipts
          verify</span> — the same serve-time counterfactual described above, summed per period. If
          Potion saves you nothing, it earns nothing above cost. The invoice
          (<code className="font-mono text-xs">GET /api/usage/invoice</code>,{' '}
          <a href="/settings/billing" className="text-accent underline">Settings · Billing</a>)
          itemises model cost, verified savings, and the share — the bill and the proof are the same
          numbers.
        </p>
      </Section>

      <Section id="traces-api" title="Agent journeys">
        <p className="text-sm leading-relaxed text-soft">
          Agent workloads send spans to <code className="font-mono text-xs">POST /v1/traces</code>{' '}
          with the same bearer key. Potion prices every span, flags tool-call loops, and clusters
          redacted sessions into <code className="font-mono text-xs">agent-*</code> workloads that
          grow their own frontiers. Pin a request to one explicitly with the{' '}
          <code className="font-mono text-xs">X-Potion-Cluster</code> header. Retention is yours:
          <code className="font-mono text-xs">PUT /api/traces/retention</code> (0 = metadata only;
          prompts and attributes are redacted on purge).
        </p>
      </Section>

      <Section id="honest" title="Things worth knowing">
        <ul className="space-y-3 text-sm leading-relaxed text-soft">
          <li>
            <span className="font-medium text-ink">A catalogue is not a frontier.</span> Potion knows
            about more models than it will route to. Only points it has measured for your kind of work
            are ever selected automatically — an unmeasured model is reachable, never auto-chosen.
          </li>
          <li>
            <span className="font-medium text-ink">Quality numbers carry intervals.</span> Every
            measured quality ships with the confidence interval its evidence supports. Where two
            strategies overlap inside that interval, Potion reports them as tied rather than
            inventing a ranking — and your policy decides on cost or latency instead.
          </li>
          <li>
            <span className="font-medium text-ink">Latency numbers start provisional.</span> Before you
            have traffic, p95 comes from evaluation runs (the model call only). Potion switches to
            serving-grade latency, measured end to end on your own requests, once there is enough of it.
          </li>
          <li>
            <span className="font-medium text-ink">Your first requests route on platform evidence.</span>{' '}
            Measurements of the workload type, not of you. As your traffic accumulates, the numbers
            become yours.
          </li>
        </ul>
      </Section>
    </div>
  );

  // Always the public frame: /docs is a signed-out surface, so it never
  // arrives inside the app rail — signed-in readers still get their
  // personalised base URL and policy in the body.
  return <SiteShell current="docs"><div className="mx-auto max-w-5xl px-6 py-14">{body}</div></SiteShell>;
}
