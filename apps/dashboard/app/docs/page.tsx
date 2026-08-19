// /docs — the in-app reference.
//
// Written against what the server ACTUALLY does, with the base URL and the
// reader's own policy filled in from /api/connection rather than left as a
// placeholder — docs that say `https://api.example.com` are docs someone has
// to translate before they can use them.
//
// It states the two things that surprise people, because both are load-
// bearing and neither is guessable: `model` is a LABEL (routing comes from
// the prompt and your policy), and appearing in the catalogue is not the same
// as being routable (only measured points are).
import { ApiUnreachable, apiFetch } from '@/lib/api';
import { CopyBlock } from '@/components/copy-block';
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

export default async function DocsPage() {
  let conn: ConnectionResponse | null = null;
  try {
    conn = await apiFetch<ConnectionResponse>('/api/connection');
  } catch (e) {
    if (!(e instanceof ApiUnreachable)) throw e;
  }
  const base = conn?.baseUrl ?? 'https://your-potion-host';

  return (
    <div className="max-w-3xl space-y-12">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Docs</h1>
        <p className="mt-2 text-sm leading-relaxed text-soft">
          Potion speaks the OpenAI chat-completions protocol. If you already have an OpenAI client,
          you change two lines and keep everything else.
        </p>
      </div>

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

      <Section id="model" title="`model` is a label, not a choice">
        <p className="text-sm leading-relaxed text-soft">
          Potion reads each request, works out which kind of work it is, and selects a strategy from
          the measured frontier under your policy. Whatever you put in <code className="font-mono text-xs">model</code>{' '}
          is echoed back and recorded, and is <span className="font-medium text-ink">not</span> an input
          to that decision. <code className="font-mono text-xs">potion-auto</code> is the documented
          convention; sending a specific model id will not pin it.
        </p>
        <p className="text-sm leading-relaxed text-soft">
          Every response carries an <code className="font-mono text-xs">x-frontier-trace</code> header
          with the decision:
        </p>
        <CopyBlock
          label="x-frontier-trace"
          text={`cluster=code-gen;strategy=6efe8a56;frontier=v2;policy=min_cost;fallback=0;provenance=live`}
        />
        <p className="text-xs leading-relaxed text-faint">
          <span className="font-medium text-soft">fallback=0</span> means a measured frontier existed
          and your policy selected a point on it. <span className="font-medium text-soft">fallback=1</span>{' '}
          means it did not, and the request rode the default strategy.{' '}
          <span className="font-medium text-soft">provenance=live</span> means the evidence behind the
          choice came from real provider runs.
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
        {conn?.policy && (
          <p className="rounded-lg border border-line bg-paper px-4 py-3 text-sm text-soft">
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

      <Section id="api" title="API reference">
        <p className="text-sm leading-relaxed text-soft">
          Everything this dashboard does is an HTTP call you can make yourself with a Bearer token.
          A <span className="font-mono text-xs">serve</span> key covers the serving surface and its
          own reads; provisioning needs <span className="font-mono text-xs">serve+admin</span>.
        </p>
        <ul className="rounded-xl border border-line bg-panel px-6 py-2">
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
          <Endpoint method="GET" path="/api/usage" note="Requests, tokens and spend." />
        </ul>
      </Section>

      <Section id="honest" title="Things worth knowing">
        <ul className="space-y-3 text-sm leading-relaxed text-soft">
          <li>
            <span className="font-medium text-ink">A catalogue is not a frontier.</span> Potion knows
            about more models than it will route to. Only points it has measured for your kind of work
            are ever selected automatically — an unmeasured model is reachable, never auto-chosen.
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
}
