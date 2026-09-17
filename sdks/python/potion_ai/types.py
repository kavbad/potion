"""Types for potion-ai (SPEC §13.2)."""

from __future__ import annotations

from typing import Dict, Optional


class FrontierTrace(Dict[str, str]):
    """Parsed ``x-frontier-trace`` response header.

    The server emits a semicolon-separated header, e.g.::

        cluster=code-gen;strategy=1a2b3c4d;frontier=v3;policy=min_cost;fallback=0;provenance=live

    (plus ``policy_override=<name>`` when an X-Potion-Policy override was
    active, and ``upgraded=0|1`` for composite strategies). Access fields
    either as a mapping (``trace["cluster"]``) or via the typed properties
    below. Unknown/absent fields return ``None`` from the properties.
    """

    @classmethod
    def parse(cls, header: Optional[str]) -> Optional["FrontierTrace"]:
        """Parse the raw header value; ``None``/empty in → ``None`` out."""
        if not header:
            return None
        out = cls()
        for part in header.split(";"):
            key, sep, value = part.partition("=")
            if sep:
                out[key.strip()] = value.strip()
        return out

    @property
    def cluster(self) -> Optional[str]:
        return self.get("cluster")

    @property
    def strategy(self) -> Optional[str]:
        return self.get("strategy")

    @property
    def frontier(self) -> Optional[str]:
        return self.get("frontier")

    @property
    def policy(self) -> Optional[str]:
        """The ACTIVE policy type (the override's type when overridden)."""
        return self.get("policy")

    @property
    def policy_override(self) -> Optional[str]:
        """Name of the X-Potion-Policy override row, when one was active."""
        return self.get("policy_override")

    @property
    def fallback(self) -> Optional[str]:
        return self.get("fallback")

    @property
    def provenance(self) -> Optional[str]:
        return self.get("provenance")

    @property
    def upgraded(self) -> Optional[str]:
        return self.get("upgraded")

    @property
    def underpowered(self) -> Optional[str]:
        """Present only when the floor excluded points on EVIDENCE WIDTH rather
        than measured quality: how many models scored at or above the bar but
        whose confidence interval dips below it. Not a verdict on the model."""
        return self.get("underpowered")
