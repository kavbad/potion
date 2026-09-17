"""potion-ai tests — pytest against a LOCAL mock HTTP server (no live calls).

The mock server implements POST /v1/chat/completions with the Potion wire
contract: OpenAI-shaped JSON + x-frontier-trace header, and OpenAI-shaped
error bodies for the mapped codes.
"""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from potion_ai import (
    BudgetExceededError,
    PolicyNotFoundError,
    Potion,
    PotionError,
    RateLimitExceededError,
)

TRACE = (
    "cluster=code-gen;strategy=1a2b3c4d;frontier=v3;policy=min_cost;fallback=0;"
    "provenance=mock;policy_override=quality-first"
)

COMPLETION = {
    "id": "chatcmpl-test",
    "object": "chat.completion",
    "created": 1_700_000_000,
    "model": "potion-auto",
    "choices": [
        {
            "index": 0,
            "message": {"role": "assistant", "content": "hello back"},
            "finish_reason": "stop",
        }
    ],
    "usage": {"prompt_tokens": 3, "completion_tokens": 2, "total_tokens": 5, "cost": 0.00042},
    "potion": {
        "requested_cluster": "auto",
        "resolved_cluster": "code-gen",
        "requested_policy": "quality-first",
        "policy_source": "override",
        "resolved_policy_type": "min_cost",
        "model": "mock-cheap",
        "fallback": False,
        "cost_usd": 0.00042,
        "provenance": "mock",
    },
}


class MockPotionHandler(BaseHTTPRequestHandler):
    # Class-level capture of the last request's headers/body for assertions.
    last_headers = None
    last_body = None
    last_path = None

    def log_message(self, *args):  # silence
        pass

    def do_POST(self):
        length = int(self.headers.get("content-length", "0"))
        body = self.rfile.read(length)
        # header casing on the wire is transport-dependent → store case-insensitively
        MockPotionHandler.last_headers = {k.lower(): v for k, v in self.headers.items()}
        MockPotionHandler.last_body = json.loads(body) if body else None
        MockPotionHandler.last_path = self.path

        # G1 Outcome API (SPEC §16) — the wire contract client.outcome() speaks.
        if self.path.endswith("/outcomes"):
            if (MockPotionHandler.last_body or {}).get("request_id") == "chatcmpl-unknown":
                return self._send(
                    404,
                    {
                        "error": {
                            "message": "no served request 'chatcmpl-unknown' for this org — outcomes attach to requests Potion served",
                            "type": "invalid_request_error",
                            "param": None,
                            "code": "unknown_request",
                        }
                    },
                )
            return self._send(
                201,
                {
                    "id": "oc-1",
                    "request_id": (MockPotionHandler.last_body or {}).get("request_id"),
                    "attached": {"cluster": "code-gen", "strategy": "1a2b3c4d", "router_version": 3},
                },
            )

        policy_header = self.headers.get("x-potion-policy")
        if policy_header == "does-not-exist":
            return self._send(
                400,
                {
                    "error": {
                        "message": "unknown policy 'does-not-exist' — no policy with that id or name exists in your org",
                        "type": "invalid_request_error",
                        "param": "X-Potion-Policy",
                        "code": "policy_not_found",
                    }
                },
            )
        if policy_header == "busted-budget":
            return self._send(
                429,
                {
                    "error": {
                        "message": "monthly budget cap reached",
                        "type": "budget_exceeded",
                        "param": None,
                        "code": "budget_exceeded",
                    }
                },
            )
        if policy_header == "slow-down":
            return self._send(
                429,
                {
                    "error": {
                        "message": "rate limit exceeded",
                        "type": "rate_limit_exceeded",
                        "param": None,
                        "code": "rate_limit_exceeded",
                    }
                },
            )
        if policy_header == "weird-failure":
            return self._send(
                500,
                {
                    "error": {
                        "message": "strategy execution failed: boom",
                        "type": "service_unavailable",
                        "param": None,
                        "code": "service_unavailable",
                    }
                },
            )
        self._send(200, COMPLETION, extra_headers={"x-frontier-trace": TRACE})

    def _send(self, status, payload, extra_headers=None):
        data = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        for k, v in (extra_headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(data)


@pytest.fixture(scope="module")
def server():
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), MockPotionHandler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{httpd.server_address[1]}"
    httpd.shutdown()
    thread.join(timeout=5)


def make_client(base_url, **kwargs):
    return Potion(base_url=base_url, api_key="pk_test_mock", max_retries=0, **kwargs)


def create(client, policy=None):
    return client.chat.completions.create(
        model="potion-auto",
        messages=[{"role": "user", "content": "hello"}],
        **({"policy": policy} if policy is not None else {}),
    )


class TestHeaderSent:
    def test_no_policy_anywhere_sends_no_header(self, server):
        create(make_client(server))
        assert "x-potion-policy" not in MockPotionHandler.last_headers
        assert MockPotionHandler.last_path == "/v1/chat/completions"

    def test_default_policy_sends_header(self, server):
        create(make_client(server, default_policy="cheap"))
        assert MockPotionHandler.last_headers.get("x-potion-policy") == "cheap"

    def test_per_request_policy_sends_header(self, server):
        create(make_client(server), policy="quality-first")
        assert MockPotionHandler.last_headers.get("x-potion-policy") == "quality-first"

    def test_per_request_policy_wins_over_default(self, server):
        client = make_client(server, default_policy="cheap")
        create(client, policy="quality-first")
        assert MockPotionHandler.last_headers.get("x-potion-policy") == "quality-first"

    def test_default_policy_applies_when_request_omits_policy(self, server):
        client = make_client(server, default_policy="cheap")
        create(client)
        assert MockPotionHandler.last_headers.get("x-potion-policy") == "cheap"

    def test_extra_headers_preserved_alongside_policy(self, server):
        client = make_client(server)
        client.chat.completions.create(
            model="potion-auto",
            messages=[{"role": "user", "content": "hello"}],
            policy="p1",
            extra_headers={"x-custom": "yes"},
        )
        assert MockPotionHandler.last_headers.get("x-potion-policy") == "p1"
        assert MockPotionHandler.last_headers.get("x-custom") == "yes"


class TestResponseWrapper:
    def test_frontier_trace_parsed(self, server):
        resp = create(make_client(server))
        assert resp.frontier_trace is not None
        assert resp.frontier_trace["cluster"] == "code-gen"
        assert resp.frontier_trace.strategy == "1a2b3c4d"
        assert resp.frontier_trace.frontier == "v3"
        assert resp.frontier_trace.policy == "min_cost"
        assert resp.frontier_trace.provenance == "mock"
        assert resp.frontier_trace.policy_override == "quality-first"
        assert resp.frontier_trace.upgraded is None

    def test_cost_from_usage(self, server):
        resp = create(make_client(server))
        assert resp.cost == pytest.approx(0.00042)

    def test_openai_fields_proxied(self, server):
        resp = create(make_client(server))
        assert resp.id == "chatcmpl-test"
        assert resp.choices[0].message.content == "hello back"
        assert resp.usage.total_tokens == 5
        dumped = resp.model_dump()
        assert dumped["object"] == "chat.completion"


class TestErrorMapping:
    def test_policy_not_found(self, server):
        with pytest.raises(PolicyNotFoundError) as exc:
            create(make_client(server), policy="does-not-exist")
        err = exc.value
        assert err.status_code == 400
        assert err.code == "policy_not_found"
        assert err.param == "X-Potion-Policy"
        assert err.type == "invalid_request_error"
        assert isinstance(err, PotionError)

    def test_budget_exceeded(self, server):
        with pytest.raises(BudgetExceededError) as exc:
            create(make_client(server), policy="busted-budget")
        assert exc.value.status_code == 429
        assert exc.value.code == "budget_exceeded"

    def test_rate_limit_exceeded(self, server):
        with pytest.raises(RateLimitExceededError) as exc:
            create(make_client(server), policy="slow-down")
        assert exc.value.status_code == 429
        assert exc.value.code == "rate_limit_exceeded"

    def test_unmapped_code_falls_back_to_potion_error(self, server):
        with pytest.raises(PotionError) as exc:
            create(make_client(server), policy="weird-failure")
        assert type(exc.value) is PotionError
        assert exc.value.code == "service_unavailable"
        assert exc.value.status_code == 500


class TestOutcome:
    """G1 Outcome API: client.outcome() speaks POST /v1/outcomes."""

    def test_posts_snake_cased_signals_and_returns_receipt(self, server):
        receipt = make_client(server).outcome(
            "chatcmpl-test",
            success=True,
            validator="tests_passed",
            failure_reason="flaky suite",
        )
        assert MockPotionHandler.last_path == "/v1/outcomes"
        assert MockPotionHandler.last_body == {
            "request_id": "chatcmpl-test",
            "success": True,
            "validator": "tests_passed",
            "failure_reason": "flaky suite",
        }
        assert receipt["id"] == "oc-1"
        assert receipt["attached"]["cluster"] == "code-gen"
        assert receipt["attached"]["router_version"] == 3

    def test_unknown_request_maps_to_potion_error(self, server):
        with pytest.raises(PotionError) as exc:
            make_client(server).outcome("chatcmpl-unknown", success=True)
        assert exc.value.status_code == 404
        assert exc.value.code == "unknown_request"
        assert "outcomes attach to requests Potion served" in str(exc.value)


def test_typed_routing_on_the_response(server):
    """2026-09-16: the top-level ``potion`` object rides the completion; the SDK exposes it."""
    client = make_client(server)
    res = client.chat.completions.create(model="potion-auto", messages=[{"role": "user", "content": "hi"}])
    assert res.routing == COMPLETION["potion"]
    assert res.routing["fallback"] is False
    assert res.routing["resolved_cluster"] == "code-gen"
    assert res.frontier_trace.underpowered is None
