"""Potion client (SPEC §13.2) — thin wrapper over the official openai client."""

from __future__ import annotations

from typing import Any, Dict, Mapping, Optional

import openai
from openai.types.chat import ChatCompletion

from .errors import map_error
from .types import FrontierTrace


class PotionChatCompletion:
    """A :class:`openai.types.chat.ChatCompletion` plus Potion metadata.

    Every attribute of the underlying completion (``id``, ``choices``,
    ``usage``, …) is proxied, so existing OpenAI-shaped code keeps working;
    the Potion additions are:

    * ``.frontier_trace`` — :class:`FrontierTrace` parsed from the
      ``x-frontier-trace`` response header (``None`` when the header is
      absent, e.g. a non-Potion backend);
    * ``.cost`` — ``usage.cost`` (USD) when the server reports one, else
      ``None``.
    """

    def __init__(self, completion: ChatCompletion, headers: Mapping[str, str]) -> None:
        self._completion = completion
        self.frontier_trace: Optional[FrontierTrace] = FrontierTrace.parse(
            headers.get("x-frontier-trace")
        )
        self.cost: Optional[float] = self._extract_cost(completion)

    @staticmethod
    def _extract_cost(completion: ChatCompletion) -> Optional[float]:
        usage = getattr(completion, "usage", None)
        if usage is None:
            return None
        cost = getattr(usage, "cost", None)
        if cost is None and hasattr(usage, "model_dump"):
            cost = usage.model_dump().get("cost")
        return float(cost) if cost is not None else None

    def __getattr__(self, name: str) -> Any:
        return getattr(self._completion, name)

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"PotionChatCompletion({self._completion!r})"


class _Completions:
    def __init__(self, client: "Potion") -> None:
        self._client = client

    def create(
        self,
        *,
        policy: Optional[str] = None,
        extra_headers: Optional[Dict[str, str]] = None,
        **kwargs: Any,
    ) -> Any:
        """Create a chat completion.

        ``policy`` (policy id or name) is sent as ``X-Potion-Policy`` and
        overrides the client's ``default_policy`` for this request only; the
        api key's bound policy remains the server-side default when neither
        is set. Returns :class:`PotionChatCompletion` — or, for
        ``stream=True``, the raw openai stream (unwrapped; see README).
        """
        effective = policy if policy is not None else self._client.default_policy
        headers: Dict[str, str] = dict(extra_headers or {})
        if effective:
            headers["X-Potion-Policy"] = effective
        raw_kwargs: Dict[str, Any] = dict(kwargs)
        if headers:
            raw_kwargs["extra_headers"] = headers
        try:
            raw = self._client.openai.chat.completions.with_raw_response.create(**raw_kwargs)
        except openai.APIStatusError as err:
            raise map_error(
                status_code=err.status_code,
                body=self._error_body(err),
                fallback_message=str(err),
            ) from err
        parsed = raw.parse()
        if kwargs.get("stream"):
            # Streaming returns an iterator of chunks; headers are still
            # available on the raw response but there is no single completion
            # object to wrap. Returned unwrapped (documented contract).
            return parsed
        return PotionChatCompletion(parsed, raw.headers)

    # Escape hatch: anything else (e.g. the raw openai resource methods)
    # proxies to the wrapped client.
    def __getattr__(self, name: str) -> Any:
        return getattr(self._client.openai.chat.completions, name)

    @staticmethod
    def _error_body(err: openai.APIStatusError) -> Optional[Dict[str, Any]]:
        """Extract the OpenAI-shaped error envelope across openai>=1 versions
        (``err.body`` carries the INNER error object; the response carries the
        full ``{"error": {...}}`` envelope)."""
        try:
            parsed = err.response.json()
        except Exception:  # noqa: BLE001 - any parse failure → fall through
            parsed = None
        if isinstance(parsed, dict) and isinstance(parsed.get("error"), dict):
            return parsed
        body = getattr(err, "body", None)
        if isinstance(body, dict):
            return {"error": body}
        return None


class _Chat:
    def __init__(self, client: "Potion") -> None:
        self._client = client
        self.completions = _Completions(client)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._client.openai.chat, name)  # pragma: no cover


class Potion:
    """Potion gateway client.

    :param base_url: gateway origin, e.g. ``"http://localhost:3000"`` (the
        ``/v1`` suffix is added when missing).
    :param api_key: Potion api key (``pk_…``).
    :param default_policy: policy id or name sent as ``X-Potion-Policy`` on
        every request unless overridden per-request with ``policy=``.
    :param openai_kwargs: forwarded to :class:`openai.OpenAI` (``timeout``,
        ``max_retries``, ``http_client``, …).
    """

    def __init__(
        self,
        base_url: str,
        api_key: str,
        default_policy: Optional[str] = None,
        **openai_kwargs: Any,
    ) -> None:
        base = base_url.rstrip("/")
        if not base.endswith("/v1"):
            base = f"{base}/v1"
        self.openai = openai.OpenAI(base_url=base, api_key=api_key, **openai_kwargs)
        self.default_policy = default_policy
        self.chat = _Chat(self)

    def __getattr__(self, name: str) -> Any:
        # Escape hatch to the wrapped client (models, embeddings, …).
        return getattr(self.openai, name)
