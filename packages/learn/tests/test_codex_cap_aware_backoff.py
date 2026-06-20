"""Codex usage-cap-aware backoff (fix/codex-cap-aware-backoff).

The ``openai-codex`` (ChatGPT Pro) provider returns HTTP 429 with a
``usage_limit_reached`` payload carrying ``resets_in_seconds`` /
``resets_at`` when the Pro usage cap is exhausted. Before this fix the
SignalExtract + DecisionRouter pipelines fired one LLM call PER stream
event, all 429, and — because a failed extract never marks the event
processed — kept the cap pinned in a self-sustaining storm.

This suite covers the three load-bearing pieces of the fix:

  (a) ``parse_retry_after_from_exc`` reads the cap-reset horizon off a
      ``usage_limit_reached`` payload (prefers ``resets_in_seconds``,
      falls back to ``resets_at - now``).
  (b) the signal-extract activities skip the LLM entirely (and DO NOT
      mark the event processed — they raise) when a provider-429 backoff
      is active.
  (c) clerk classifies the ``usage_limit_reached`` 429 as non-retryable
      (a plain transient 429 stays retryable).
"""
from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

import pytest
from temporalio.exceptions import ApplicationError

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import src.activities.clerk as clerk  # noqa: E402
import src.activities.rate_guard as rate_guard_mod  # noqa: E402
import src.activities.signals as signals  # noqa: E402
from src.config import Config  # noqa: E402
from src.activities.rate_guard import (  # noqa: E402
    RateGuard,
    parse_retry_after_from_exc,
)


# ---------------------------------------------------------------------------
# (a) parse_retry_after_from_exc on a usage_limit_reached payload
# ---------------------------------------------------------------------------

def test_parse_usage_limit_prefers_resets_in_seconds() -> None:
    payload = (
        "Clerk run failed (HTTP 429): {'type': 'usage_limit_reached', "
        "'message': 'The usage limit has been reached', 'plan_type': 'pro', "
        "'resets_at': 9999999999, 'resets_in_seconds': 1800}"
    )
    secs = parse_retry_after_from_exc(RuntimeError(payload))
    assert secs == 1800


def test_parse_usage_limit_falls_back_to_resets_at() -> None:
    import time

    future = int(time.time()) + 1234
    payload = (
        "{'type': 'usage_limit_reached', 'message': 'The usage limit has "
        f"been reached', 'plan_type': 'pro', 'resets_at': {future}}}"
    )
    secs = parse_retry_after_from_exc(RuntimeError(payload))
    assert secs is not None
    # ~1234s, allow a couple seconds of clock drift in test execution.
    assert 1230 <= secs <= 1234


def test_parse_usage_limit_message_only_returns_zero() -> None:
    # Usage-cap detected by message text but no horizon → 0 (caller uses
    # the 60s default), NOT None (which would skip the backoff entirely).
    payload = "Clerk run failed (HTTP 429): The usage limit has been reached"
    secs = parse_retry_after_from_exc(RuntimeError(payload))
    assert secs == 0


def test_parse_plain_429_still_returns_zero() -> None:
    secs = parse_retry_after_from_exc(RuntimeError("HTTP 429: rate limited"))
    assert secs == 0


def test_parse_non_429_returns_none() -> None:
    assert parse_retry_after_from_exc(RuntimeError("connection refused")) is None


# ---------------------------------------------------------------------------
# (b) signal-extract skips the LLM when rate_429_until is in the future
# ---------------------------------------------------------------------------

def _cfg_for(tmp_path: Path) -> Config:
    return Config(alfred_data_dir=str(tmp_path))


@pytest.fixture()
def guard_with_active_backoff(tmp_path: Path, monkeypatch: Any) -> RateGuard:
    """A process-singleton RateGuard whose 429 backoff is active (1h out)."""
    import time

    cfg = _cfg_for(tmp_path)
    guard = RateGuard(cfg)

    # Seed an active backoff on disk, the same shape record_429 would write,
    # so check_and_reserve sees a live provider-429 deadline 1h out.
    state = rate_guard_mod._empty_state()
    state["rate_429_until"] = time.time() + 3600
    state["rate_429_count"] = 1
    rate_guard_mod._write_state(cfg, state)

    # Pin the module singleton so the activity's get_rate_guard() returns
    # this guard (same cfg → same on-disk state file under tmp_path).
    monkeypatch.setattr(rate_guard_mod, "_singleton", guard)
    monkeypatch.setattr(
        rate_guard_mod, "get_rate_guard", lambda cfg=None: guard
    )
    return guard


async def test_extract_signal_skips_llm_under_active_backoff(
    tmp_path: Path, monkeypatch: Any, guard_with_active_backoff: RateGuard
) -> None:
    # Point load_config at tmp_path so VaultClient + the activity share cfg.
    monkeypatch.setattr(signals, "load_config", lambda: _cfg_for(tmp_path))

    # A clerk that explodes if ever called — the assertion is that it is NOT.
    called = {"n": 0}

    async def _boom(*a: Any, **k: Any) -> Any:
        called["n"] += 1
        raise AssertionError("clerk must not be called under active backoff")

    monkeypatch.setattr(clerk, "_call_clerk", _boom)

    # Stub the read + pre-filter so we reach the rate-guard gate with a
    # well-formed, accepted event.
    async def _read_record(self: Any, path: str) -> dict[str, Any]:
        return {"frontmatter": {"source_type": "gmail"}, "content": "x" * 80}

    monkeypatch.setattr(
        signals.VaultClient, "read_record", _read_record, raising=True
    )
    monkeypatch.setattr(signals, "_pre_filter", lambda ev: (True, ""))
    monkeypatch.setattr(
        signals, "build_signal_extraction_prompt",
        lambda **k: "prompt", raising=False,
    )
    # Skip the noise-pattern vault round-trips.
    import src.activities.noise_patterns as noise_patterns

    async def _empty(*a: Any, **k: Any) -> list[Any]:
        return []

    monkeypatch.setattr(noise_patterns, "load_active_noise_patterns", _empty)
    monkeypatch.setattr(noise_patterns, "load_noise_instincts", _empty)

    # Under an active backoff the activity must RAISE (so the workflow does
    # NOT mark the event processed), not return None (= classified noise).
    with pytest.raises(RuntimeError) as ei:
        await signals.extract_signal_from_event("stream_event/abc.md")
    assert "rate-guard blocked" in str(ei.value)
    assert called["n"] == 0


# ---------------------------------------------------------------------------
# (c) clerk classifies usage_limit_reached as non-retryable
# ---------------------------------------------------------------------------

class _FakeResp:
    def __init__(self, status_code: int, body: Any = None, text: str = ""):
        self.status_code = status_code
        self._body = body if body is not None else {}
        self.text = text

    def json(self) -> Any:
        return self._body


class _FakeClient:
    def __init__(self, resp: _FakeResp):
        self._resp = resp

    async def __aenter__(self) -> "_FakeClient":
        return self

    async def __aexit__(self, *exc: Any) -> bool:
        return False

    async def post(self, *args: Any, **kwargs: Any) -> _FakeResp:
        return self._resp


def _patch_client(monkeypatch: Any, resp: _FakeResp) -> None:
    monkeypatch.setattr(
        clerk.httpx, "AsyncClient", lambda *a, **k: _FakeClient(resp)
    )

    class _Cfg:
        def gateway_token(self) -> str:
            return "tok"

        openclaw_workers_gateway_url = "http://workers"
        clerk_agent_id = "learn-clerk"

    monkeypatch.setattr(clerk, "load_config", lambda: _Cfg())


async def test_usage_limit_429_is_non_retryable(monkeypatch: Any) -> None:
    _patch_client(
        monkeypatch,
        _FakeResp(
            429,
            {"error": {"message": (
                "{'type': 'usage_limit_reached', 'message': 'The usage "
                "limit has been reached', 'plan_type': 'pro', "
                "'resets_in_seconds': 1800}"
            )}},
        ),
    )
    with pytest.raises(ApplicationError) as ei:
        await clerk._call_clerk("hi")
    assert ei.value.non_retryable is True
    assert ei.value.type == "ClerkUsageCapError"


async def test_plain_429_remains_retryable(monkeypatch: Any) -> None:
    _patch_client(
        monkeypatch,
        _FakeResp(429, {"error": {"message": "rate limited"}}),
    )
    with pytest.raises(ApplicationError) as ei:
        await clerk._call_clerk("hi")
    assert ei.value.non_retryable is False
