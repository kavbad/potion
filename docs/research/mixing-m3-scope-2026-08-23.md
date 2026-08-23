# MIXING M3 — combinations that can carry tools and stream (scope, 2026-08-23)

## Where it stands

`resolveOperatingPoint(policy, frontier, fallback, { toolCapableOnly })`
narrows the frontier to `single` points whenever the request carries
`tools`, `response_format` or `stop` (chat.ts). Streaming is relayed live
for `single`; a `composite` captures and replays; everything else answers
as JSON. So the measured combinations — the part of the frontier no
gateway has — never serve agentic or structured traffic, which is most of
the traffic a design partner brings.

## The shape of the fix

A capability is a property of a *shape*, declared where the shape is
executed, not inferred at the route:

| shape | `canServeTools` | `canStream` | why |
|---|---|---|---|
| single | yes | yes | one call; already true |
| cascade (stages s₁…sₙ, escalate on confidence) | yes **iff** every stage that can be the answering call forwards tools and the escalation signal does not need logprobs of a tool call | yes, from the answering stage only (earlier stages are scored, not shown) | the terminal call is a single model call |
| composite (start → upgrade on confidence) | yes iff the confidence check can score a tool call (today it scores text; a tool call has no text to judge) | already captured; can relay the upgrade stage live once the keep/upgrade decision is made | |
| mixture / program | no (until designed) | no | |

Concretely:

1. `StrategyCapabilities { canServeTools, canStream }` computed by
   `@potion/strategies` from the config (a pure function; tests per shape).
2. `resolveOperatingPoint` narrows by capability instead of by `type`.
3. Cascade: forward `params.tools` to every stage; a stage that returns a
   tool call is terminal (no escalation on a tool call — escalation judges
   answers, and a tool call is a decision, not an answer). The trace names
   the answering stage.
4. Composite with tools: if the start stage returns a tool call, keep it
   (same rule); the confidence gate applies only to text answers.
5. Streaming for cascade: relay the terminal stage live when the earlier
   stages have already escalated (the route learns "this is the answering
   stage" from the strategy via a callback), else replay.

## Measurement before serving

A combination earns `canServeTools` only after the harness has measured it
on the agentic-tool-use suite with tools attached — the frontier point must
carry that evidence (`evidence.toolsMeasured: true`). The complementarity
miner already names agentic-tool-use as the cluster with fusion headroom
(+2.1 pts, 2026-08-20); that is where the first measured tool-capable
cascade should come from.

## Cost

Engineering: the capability layer and cascade tool forwarding ≈ two days;
streaming relay for cascades ≈ one more. Measurement: one agentic-tool-use
leg for the candidate cascades, inside the Observatory envelope (≈ $5–10).
