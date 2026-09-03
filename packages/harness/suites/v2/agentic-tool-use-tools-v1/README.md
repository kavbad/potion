# agentic-tool-use-tools-v1

The MIXING M3 instrument: items carry real tool definitions and are scored on the tool call they produce (`tool-call`: expected name + argument subset; half credit for the right tool with other arguments). A frontier point measured here carries `evidence.toolsMeasured`, which is what lets a combination serve tool-carrying requests.

## 1.1.0 (2026-09-01) — multi-turn continuation

The or-gemini-flash incident (measured q=1.0 here at 1.0.0, then zero-token
completion bursts in production, always AFTER tool results) proved the
original 24 single-turn items structurally blind to the failure mode that
matters most for agentic serving: what the model does once a tool has
answered. att-25..36 put the tool call AND its result in the transcript and
score the continuation:

- **chain** (att-25..30, `tool-call`): the request needs a SECOND call
  grounded in the first result (weather → reminder, order lookup → refund,
  read → write, …).
- **conclude** (att-31..36, `field-contains`): the request needs a grounded
  final JSON answer built from the result; the checked fields are values the
  tool returned, so an answer that ignores the result scores as low as no
  answer.

An empty stop after a tool result — the production failure — scores 0 on
every one of these items. Both kinds still carry tools in the request, so
"answer instead of calling another tool" remains part of what is measured.
