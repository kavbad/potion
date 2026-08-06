"""PotionError hierarchy (SPEC §13.2).

The Potion gateway returns OpenAI-shaped errors::

    {"error": {"message": ..., "type": ..., "param": ..., "code": ...}}

The SDK maps the platform's ``code`` values onto typed exceptions so callers
can catch precisely instead of string-matching::

    try:
        client.chat.completions.create(..., policy="does-not-exist")
    except PolicyNotFoundError as err:
        ...
"""

from __future__ import annotations

from typing import Any, Dict, Optional


class PotionError(Exception):
    """Base class for every error raised by the Potion SDK.

    Carries the OpenAI-shaped error fields verbatim: ``message``, ``type``,
    ``code``, ``param`` plus the HTTP ``status_code``. """

    def __init__(
        self,
        message: str,
        *,
        status_code: Optional[int] = None,
        type: Optional[str] = None,  # noqa: A002 - mirrors the wire field
        code: Optional[str] = None,
        param: Optional[str] = None,
        body: Optional[Dict[str, Any]] = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.status_code = status_code
        self.type = type
        self.code = code
        self.param = param
        self.body = body

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return (
            f"{self.__class__.__name__}(message={self.message!r}, "
            f"status_code={self.status_code!r}, code={self.code!r}, param={self.param!r})"
        )


class PolicyNotFoundError(PotionError):
    """``code == 'policy_not_found'`` — the X-Potion-Policy id/name does not
    exist in the caller's org (HTTP 400, type invalid_request_error)."""


class BudgetExceededError(PotionError):
    """``code == 'budget_exceeded'`` / ``type == 'budget_exceeded'`` — the
    org's budget hard-stop refused the request (HTTP 429)."""


class RateLimitExceededError(PotionError):
    """``code == 'rate_limit_exceeded'`` — the key/org rate limit fired
    (HTTP 429)."""


#: Platform error code → exception class. Lookup falls back to PotionError.
ERROR_CODE_MAP = {
    "policy_not_found": PolicyNotFoundError,
    "budget_exceeded": BudgetExceededError,
    "rate_limit_exceeded": RateLimitExceededError,
}


def map_error(
    *,
    status_code: Optional[int],
    body: Optional[Dict[str, Any]],
    fallback_message: str,
) -> PotionError:
    """Map an OpenAI-shaped error body onto the PotionError hierarchy."""
    err = (body or {}).get("error") or {}
    message = err.get("message") or fallback_message
    code = err.get("code")
    # budget_exceeded may arrive as the TYPE rather than the code (SPEC §13.7).
    lookup = code if code in ERROR_CODE_MAP else err.get("type")
    cls = ERROR_CODE_MAP.get(lookup, PotionError)
    return cls(
        message,
        status_code=status_code,
        type=err.get("type"),
        code=code,
        param=err.get("param"),
        body=body,
    )
