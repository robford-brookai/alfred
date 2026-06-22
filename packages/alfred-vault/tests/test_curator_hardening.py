"""Curator hardening: cap-burn prevention.

Three fixes, exercised here:
  1. `curator.enabled: false` is honored — `daemon.run` returns without
     scanning the inbox.
  2. Cap-aware backoff shared with the learn signal pipeline via the
     rate-guard JSON: `_call_llm` skips the subprocess when `rate_429_until`
     is in the future and signals a defer; a 429 in subprocess output arms the
     backoff with the parsed horizon.
  3. Poison-file quarantine — a file failing N times in a row is moved out of
     the watched inbox and marked processed; a rate-backoff defer does NOT
     increment the failure counter.
"""

from __future__ import annotations

import asyncio
import json
import time
from pathlib import Path
from unittest import mock

import pytest

from alfred.curator.config import (
    CuratorConfig,
    VaultConfig,
    load_from_unified,
)
from alfred.curator.rate_backoff import (
    _GRACE_SECONDS,
    _MAX_BACKOFF,
    RateBackoffDeferred,
    arm_backoff,
    parse_backoff_seconds_from_output,
    read_backoff_until,
)
from alfred.curator.state import State, StateManager


# ---------------------------------------------------------------------------
# Fix 1 — honor curator.enabled: false
# ---------------------------------------------------------------------------


def test_load_from_unified_maps_enabled_false():
    cfg = load_from_unified({"curator": {"enabled": False}, "vault": {"path": "/v"}})
    assert cfg.enabled is False


def test_load_from_unified_defaults_enabled_true():
    cfg = load_from_unified({"curator": {}, "vault": {"path": "/v"}})
    assert cfg.enabled is True


def test_disabled_daemon_returns_without_scanning():
    from alfred.curator import daemon

    config = CuratorConfig(enabled=False)

    with mock.patch.object(daemon, "InboxWatcher") as Watcher, \
         mock.patch.object(daemon, "_create_backend") as create_backend:
        asyncio.run(daemon.run(config, Path("/nonexistent-skills")))

    # Disabled: no watcher constructed, no backend created, nothing scanned.
    Watcher.assert_not_called()
    create_backend.assert_not_called()


# ---------------------------------------------------------------------------
# Fix 2 — cap-aware backoff (read/arm + _call_llm gating)
# ---------------------------------------------------------------------------


def test_read_backoff_tolerates_missing_file(tmp_path):
    assert read_backoff_until(tmp_path / "nope.json") == 0.0


def test_read_backoff_tolerates_garbage(tmp_path):
    p = tmp_path / "rate-guard.json"
    p.write_text("not json", encoding="utf-8")
    assert read_backoff_until(p) == 0.0


def test_arm_backoff_clamps_and_merges(tmp_path):
    p = tmp_path / "rate-guard.json"
    p.write_text(json.dumps({"other_key": "keep-me"}), encoding="utf-8")

    until = arm_backoff(5, path=p)  # below 30s floor -> clamped up to 30
    assert until >= time.time() + 29

    data = json.loads(p.read_text(encoding="utf-8"))
    assert data["other_key"] == "keep-me"  # merge, not clobber
    assert abs(data["rate_429_until"] - until) < 0.01


def test_arm_backoff_only_extends(tmp_path):
    p = tmp_path / "rate-guard.json"
    far = time.time() + 10_000
    p.write_text(json.dumps({"rate_429_until": far}), encoding="utf-8")
    # Arming a shorter backoff must not shorten an existing longer one.
    until = arm_backoff(60, path=p)
    assert abs(until - far) < 0.01


def test_arm_backoff_honors_multiday_horizon(tmp_path):
    """A 4-day horizon is honored, not clamped to 24h."""
    p = tmp_path / "rate-guard.json"
    until = arm_backoff(4 * 24 * 60 * 60, path=p)
    assert until - time.time() > 3.5 * 24 * 60 * 60


def test_arm_backoff_clamps_at_7d(tmp_path):
    """An absurd horizon is bounded by the 7d ceiling."""
    p = tmp_path / "rate-guard.json"
    until = arm_backoff(30 * 24 * 60 * 60, path=p)  # 30 days
    assert until - time.time() <= _MAX_BACKOFF + 5
    assert until - time.time() > _MAX_BACKOFF - 60


def test_read_backoff_honors_recent_429_grace(tmp_path):
    """Past rate_429_until but a 429 within grace -> read returns a future deadline."""
    p = tmp_path / "rate-guard.json"
    now = time.time()
    p.write_text(
        json.dumps({"rate_429_until": now - 10, "rate_429_last_event_ts": now - 10}),
        encoding="utf-8",
    )
    assert read_backoff_until(p) > now  # grace holds it open


def test_read_backoff_grace_clears_when_stale(tmp_path):
    """Past rate_429_until and a stale 429 -> read returns the (past) deadline."""
    p = tmp_path / "rate-guard.json"
    now = time.time()
    stale = now - (_GRACE_SECONDS + 60)
    p.write_text(
        json.dumps({"rate_429_until": stale, "rate_429_last_event_ts": stale}),
        encoding="utf-8",
    )
    assert read_backoff_until(p) <= now  # grace cleared, calls may resume


def test_arm_backoff_writes_last_event_ts(tmp_path):
    """arm_backoff records rate_429_last_event_ts so learn's grace sees it."""
    p = tmp_path / "rate-guard.json"
    arm_backoff(60, path=p)
    data = json.loads(p.read_text(encoding="utf-8"))
    assert "rate_429_last_event_ts" in data
    assert abs(data["rate_429_last_event_ts"] - time.time()) < 5


@pytest.mark.parametrize("text,expected", [
    ('{"type":"usage_limit_reached","resets_in_seconds":3600}', 3600),
    ('the usage limit has been reached', 0),       # cap, no horizon
    ('Error: Too many concurrent runs (max 10)', 60),
    ('rate_limit_exceeded', 60),
    ('all good here', None),
    ('', None),
])
def test_parse_backoff_seconds(text, expected):
    assert parse_backoff_seconds_from_output(text) == expected


def _openclaw_config(tmp_path):
    config = CuratorConfig(vault=VaultConfig(path=str(tmp_path / "vault")))
    config.agent.backend = "openclaw"
    return config


def test_call_llm_skips_subprocess_when_backoff_active(tmp_path):
    from alfred.curator import pipeline

    guard = tmp_path / "rate-guard.json"
    guard.write_text(json.dumps({"rate_429_until": time.time() + 3600}), encoding="utf-8")
    config = _openclaw_config(tmp_path)

    with mock.patch.object(pipeline, "read_backoff_until", return_value=time.time() + 3600), \
         mock.patch("asyncio.create_subprocess_exec") as spawn, \
         mock.patch.object(pipeline, "_clear_agent_sessions"), \
         mock.patch.object(pipeline, "sync_workspace_claude_md"):
        with pytest.raises(RateBackoffDeferred):
            asyncio.run(pipeline._call_llm("prompt", config, "/tmp/session.json", "s1-analyze"))

    spawn.assert_not_called()


def test_call_llm_arms_backoff_on_429_output(tmp_path):
    from alfred.curator import pipeline

    config = _openclaw_config(tmp_path)
    guard = tmp_path / "rate-guard.json"

    # Fake subprocess: non-zero exit, usage-cap payload on stdout.
    class _FakeProc:
        returncode = 1

        async def communicate(self):
            payload = b'{"type":"usage_limit_reached","resets_in_seconds":1800}'
            return payload, b""

    async def _fake_spawn(*a, **k):
        return _FakeProc()

    armed = {}

    def _capture_arm(seconds, path=None):
        armed["seconds"] = seconds
        return time.time() + seconds

    with mock.patch.object(pipeline, "read_backoff_until", return_value=0.0), \
         mock.patch("asyncio.create_subprocess_exec", _fake_spawn), \
         mock.patch.object(pipeline, "arm_backoff", _capture_arm), \
         mock.patch.object(pipeline, "_clear_agent_sessions"), \
         mock.patch.object(pipeline, "sync_workspace_claude_md"):
        with pytest.raises(RateBackoffDeferred):
            asyncio.run(pipeline._call_llm("prompt", config, "/tmp/session.json", "s1-analyze"))

    assert armed["seconds"] == 1800


# ---------------------------------------------------------------------------
# Fix 3 — quarantine poison files; defers do NOT count as failures
# ---------------------------------------------------------------------------


def _vault(tmp_path):
    vault = tmp_path / "vault"
    inbox = vault / "inbox"
    inbox.mkdir(parents=True)
    (vault / "inbox" / "processed").mkdir(parents=True)
    return vault, inbox


def _make_config(tmp_path):
    vault, _ = _vault(tmp_path)
    config = CuratorConfig(vault=VaultConfig(path=str(vault)))
    config.agent.backend = "openclaw"
    config.state.path = str(tmp_path / "state.json")
    config.max_consecutive_failures = 3
    return config


def _failing_pipeline_result():
    from alfred.curator.pipeline import PipelineResult
    return PipelineResult(success=False, deferred=False, summary="s1 failed: no note created")


def _deferred_pipeline_result():
    from alfred.curator.pipeline import PipelineResult
    return PipelineResult(success=False, deferred=True, summary="rate-backoff active")


def test_file_quarantined_after_threshold(tmp_path):
    from alfred.curator import daemon

    config = _make_config(tmp_path)
    inbox_file = config.vault.inbox_path / "poison.md"
    inbox_file.write_text("bad content", encoding="utf-8")

    state_mgr = StateManager(config.state.path)
    backend = mock.Mock()

    async def _run_three():
        with mock.patch.object(daemon, "run_pipeline",
                               new=mock.AsyncMock(return_value=_failing_pipeline_result())), \
             mock.patch.object(daemon, "build_vault_context"), \
             mock.patch.object(daemon, "read_mutations",
                               return_value={"files_created": [], "files_modified": [], "files_deleted": []}), \
             mock.patch.object(daemon, "create_session_file", return_value="/tmp/s.json"), \
             mock.patch.object(daemon, "cleanup_session_file"), \
             mock.patch.object(daemon, "append_to_audit_log"):
            for _ in range(3):
                if inbox_file.exists():
                    await daemon._process_file(inbox_file, backend, "", config, state_mgr)

    asyncio.run(_run_three())

    # File moved out of the watched inbox into _quarantine, original gone.
    assert not inbox_file.exists()
    quarantined = config.vault.inbox_path / "_quarantine" / "poison.md"
    assert quarantined.exists()
    # Marked processed so it never re-enters the loop; failure counter cleared.
    assert state_mgr.state.is_processed("poison.md")
    assert "poison.md" not in state_mgr.state.failure_counts


def test_backoff_defer_does_not_increment_failures(tmp_path):
    from alfred.curator import daemon

    config = _make_config(tmp_path)
    inbox_file = config.vault.inbox_path / "good.md"
    inbox_file.write_text("good content", encoding="utf-8")

    state_mgr = StateManager(config.state.path)
    backend = mock.Mock()

    async def _run_many():
        with mock.patch.object(daemon, "run_pipeline",
                               new=mock.AsyncMock(return_value=_deferred_pipeline_result())), \
             mock.patch.object(daemon, "build_vault_context"), \
             mock.patch.object(daemon, "read_mutations",
                               return_value={"files_created": [], "files_modified": [], "files_deleted": []}), \
             mock.patch.object(daemon, "create_session_file", return_value="/tmp/s.json"), \
             mock.patch.object(daemon, "cleanup_session_file"), \
             mock.patch.object(daemon, "append_to_audit_log"):
            for _ in range(5):
                await daemon._process_file(inbox_file, backend, "", config, state_mgr)

    asyncio.run(_run_many())

    # Five defers must NOT quarantine the file or count as failures: the file
    # stays pending in the inbox, never marked processed.
    assert inbox_file.exists()
    assert not (config.vault.inbox_path / "_quarantine" / "good.md").exists()
    assert "good.md" not in state_mgr.state.failure_counts
    assert not state_mgr.state.is_processed("good.md")


def test_failure_counter_resets_on_success(tmp_path):
    s = State()
    assert s.record_failure("f.md") == 1
    assert s.record_failure("f.md") == 2
    s.reset_failures("f.md")
    assert "f.md" not in s.failure_counts
    assert s.record_failure("f.md") == 1


def test_state_failure_counts_round_trip():
    s = State()
    s.record_failure("a.md")
    s.record_failure("a.md")
    restored = State.from_dict(s.to_dict())
    assert restored.failure_counts == {"a.md": 2}
