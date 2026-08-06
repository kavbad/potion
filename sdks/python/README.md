# potion-ai (Python SDK)

Thin wrapper over the official [`openai`](https://pypi.org/project/openai/)
client for the Potion gateway. It speaks the exact OpenAI wire protocol and
adds Potion's routing controls: per-request policy override and
`x-frontier-trace` introspection.

## Install

```bash
pip install potion-ai        # from source: pip install ./sdks/python
```

Requires Python ≥ 3.9 and `openai>=1`.

## Quickstart

```python
from potion_ai import Potion, PolicyNotFoundError

client = Potion(
    base_url="http://localhost:3000",   # gateway origin (/v1 added if missing)
    api_key="pk_...",                   # your Potion api key
    default_policy="cheap",             # optional: policy id OR name
)

resp = client.chat.completions.create(
    model="potion-auto",
    messages=[{"role": "user", "content": "Write a python function that reverses a string"}],
)
print(resp.choices[0].message.content)

# Potion metadata:
print(resp.frontier_trace)   # {'cluster': 'code-gen', 'strategy': '1a2b3c4d',
                             #  'frontier': 'v3', 'policy': 'min_cost',
                             #  'fallback': '0', 'provenance': 'live', ...}
print(resp.frontier_trace.cluster, resp.frontier_trace.provenance)
print(resp.cost)             # usage.cost (USD) when the server reports one
```

## Per-request policy override

Every `chat.completions.create()` accepts a `policy=` kwarg — a policy **id
or name** resolved within your org — sent as the `X-Potion-Policy` header.
Precedence:

```
policy= kwarg  >  Potion(default_policy=...)  >  the api key's bound policy
```

```python
resp = client.chat.completions.create(
    model="potion-auto",
    messages=[{"role": "user", "content": "hello"}],
    policy="quality-first",   # this request only
)
assert resp.frontier_trace.policy_override == "quality-first"
```

Unknown policies fail fast:

```python
try:
    client.chat.completions.create(model="potion-auto", messages=[...], policy="nope")
except PolicyNotFoundError as err:
    err.status_code  # 400
    err.code         # 'policy_not_found'
    err.param        # 'X-Potion-Policy'
```

## Error mapping

The gateway's OpenAI-shaped error codes map onto typed exceptions:

| error `code` / `type`     | exception               | HTTP |
| ------------------------- | ----------------------- | ---- |
| `policy_not_found`        | `PolicyNotFoundError`   | 400  |
| `budget_exceeded`         | `BudgetExceededError`   | 429  |
| `rate_limit_exceeded`     | `RateLimitExceededError`| 429  |
| *(anything else)*         | `PotionError`           | —    |

All carry `.message`, `.status_code`, `.type`, `.code`, `.param`, `.body`.

## Notes

- Everything else proxies to the wrapped `openai.OpenAI` client
  (`client.openai`, and attribute passthrough for `models`, `embeddings`, …).
- `stream=True` returns the raw openai stream unwrapped (there is no single
  completion object to annotate); headers are not exposed on streams.
- Extra headers merge cleanly: `create(..., policy="p", extra_headers={...})`.

## Tests

```bash
cd sdks/python
python3 -m pytest tests/ -q   # mock HTTP server only — no live calls
```
