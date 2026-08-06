"""potion-ai — thin OpenAI-compatible SDK for the Potion gateway (SPEC §13.2).

Wraps the official ``openai`` client and adds:

* per-request policy override via the ``policy=`` kwarg (sends
  ``X-Potion-Policy: <policyId | policyName>``);
* ``.frontier_trace`` on responses (parsed ``x-frontier-trace`` header);
* ``.cost`` on responses (``usage.cost`` when the server reports one);
* a :class:`PotionError` hierarchy mapping the platform's OpenAI-shaped
  error codes (policy_not_found, budget_exceeded, rate_limit_exceeded).

Quickstart::

    from potion_ai import Potion

    client = Potion(base_url="http://localhost:3000", api_key="pk_...",
                    default_policy="cheap")
    resp = client.chat.completions.create(
        model="potion-auto",
        messages=[{"role": "user", "content": "hello"}],
    )
    print(resp.choices[0].message.content, resp.frontier_trace, resp.cost)

    resp2 = client.chat.completions.create(
        model="potion-auto",
        messages=[{"role": "user", "content": "hello"}],
        policy="quality-first",  # per-request override wins over default_policy
    )
"""

from .client import Potion, PotionChatCompletion
from .errors import (
    BudgetExceededError,
    PolicyNotFoundError,
    PotionError,
    RateLimitExceededError,
)
from .types import FrontierTrace

__all__ = [
    "BudgetExceededError",
    "FrontierTrace",
    "PolicyNotFoundError",
    "Potion",
    "PotionChatCompletion",
    "PotionError",
    "RateLimitExceededError",
]

__version__ = "0.1.0"
