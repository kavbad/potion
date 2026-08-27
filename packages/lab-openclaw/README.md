# @potion/lab-openclaw

Potion Lab's runtime gate for [OpenClaw](https://docs.openclaw.ai): an
OpenClaw plugin hook that routes every tool call through Potion's
per-action-class trust record — supervised actions pause for approval in
your own OpenClaw surface, earned-autonomous actions run free (with a
standing audit sample), blocked classes refuse, and every resolution
becomes graduation evidence.

## Wiring

In your OpenClaw plugin entry:

```ts
import { registerPotionGate } from '@potion/lab-openclaw';

export default function register(api) {
  registerPotionGate(api, {
    apiUrl: 'https://api.withpotion.com',
    apiKey: process.env.POTION_API_KEY,   // a Potion SERVING key
    harnessHash: process.env.POTION_HARNESS_HASH,
  });
}
```

## The rules this shim enforces

- **No `allow-always`.** The approval prompt offers allow-once / deny only.
  Standing autonomy is earned through the grant — per action class, backed
  by evidence, revocable on drift — never toggled from a chat surface.
- **Fail closed to supervision, not to a brick.** If the gate is
  unreachable, actions require local approval; nothing is silently allowed
  and the agent keeps working. Those approvals do not count as evidence.
- **Unanswered says nothing.** Timeouts and cancellations record no
  evidence for or against the agent.

The permission ledger for the harness lives in Potion Lab
(`/lab/harness/<hash>`), where graduation proposals are reviewed and
granted.
