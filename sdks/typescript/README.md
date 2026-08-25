# @potion/sdk (TypeScript SDK)

Thin wrapper over the official [`openai`](https://www.npmjs.com/package/openai)
client for the Potion gateway. It speaks the exact OpenAI wire protocol and
adds Potion's routing controls: per-request policy override and
`x-frontier-trace` introspection.

## Install

```bash
npm install @potion/sdk        # from source: npm install ./sdks/typescript
```

Requires Node ≥ 18 and `openai` v4 (installed as a dependency).

## Quickstart

```ts
import { Potion, PolicyNotFoundError } from '@potion/sdk';

const client = new Potion({
  baseUrl: 'http://localhost:3000',   // gateway origin (/v1 added if missing)
  apiKey: 'pk_...',                   // your Potion api key
  defaultPolicy: 'cheap',             // optional: policy id OR name
});

const resp = await client.chat.completions.create({
  model: 'potion-auto',
  messages: [{ role: 'user', content: 'Write a function that reverses a string' }],
});
console.log(resp.choices[0].message.content);

// Potion metadata:
console.log(resp.frontierTrace?.entries);
// { cluster: 'code-gen', strategy: '1a2b3c4d', frontier: 'v3',
//   policy: 'min_cost', fallback: '0', provenance: 'live', ... }
console.log(resp.frontierTrace?.cluster, resp.frontierTrace?.provenance);
console.log(resp.cost);               // usage.cost (USD) when reported
```

## Per-request policy override

Every `chat.completions.create()` accepts a `policy` param — a policy **id
or name** resolved within your org — sent as the `X-Potion-Policy` header.
Precedence:

```
policy param  >  new Potion({ defaultPolicy })  >  the api key's bound policy
```

```ts
const resp = await client.chat.completions.create({
  model: 'potion-auto',
  messages: [{ role: 'user', content: 'hello' }],
  policy: 'quality-first',   // this request only
});
console.log(resp.frontierTrace?.policyOverride); // 'quality-first'
```

Unknown policies fail fast with a typed error (HTTP 400):

```ts
try {
  await client.chat.completions.create({ model: 'potion-auto', messages, policy: 'nope' });
} catch (err) {
  if (err instanceof PolicyNotFoundError) {
    console.error(err.statusCode, err.code, err.param); // 400 policy_not_found X-Potion-Policy
  }
}
```

## Streaming

`stream: true` returns the raw openai stream **unwrapped** (there is no
single completion object to attach metadata to). Everything else about the
request — including `policy` — works the same:

```ts
const stream = await client.chat.completions.create({
  model: 'potion-auto',
  messages,
  policy: 'cheap',
  stream: true,
});
for await (const chunk of stream as AsyncIterable<unknown>) { ... }
```

## Error hierarchy

| Condition                              | Class                    | HTTP |
|----------------------------------------|--------------------------|------|
| Unknown X-Potion-Policy id/name        | `PolicyNotFoundError`    | 400  |
| Org budget hard-stop refused request   | `BudgetExceededError`    | 429  |
| Key/org rate limit fired               | `RateLimitExceededError` | 429  |
| Anything else (OpenAI-shaped)          | `PotionError`            | any  |

Every error carries `message`, `statusCode`, `type`, `code`, `param`, and
the raw `body` envelope.

## Escape hatch

`client.openai` is the wrapped official client, pointed at Potion. The
resources Potion serves today — chat completions (streaming and tool calls
included), legacy completions, embeddings, and `models.list()` — work as
documented upstream. Resources Potion does not serve (Responses, images,
audio, files, batches) return Potion's 404, not silent emptiness.
`client.models` / `client.embeddings` are exposed directly for convenience.

## Development

```bash
npm install
npm run build       # tsup → dist/ (esm + cjs + d.ts)
npm test            # vitest against a local mock server (no live calls)
npm run typecheck   # tsc --noEmit (strict)
```
