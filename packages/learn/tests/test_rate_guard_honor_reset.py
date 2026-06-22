"""rate-guard honors the real reset horizon + recent-429 grace
(fix/rate-guard-honor-reset).

Before this fix ``record_429`` clamped any backoff to 24h, so a multi-day
ChatGPT Pro *weekly* cap (``usage_limit_reached`` reports a multi-day
``resets_in_seconds``) re-probed every 24h and 429'd each time. And the
instant ``rate_429_until`` passed, a concurrent herd could all re-probe a
still-closed cap.

These tests lock in:
  (1) the backoff honors a multi-day horizon, up to a 7d ceiling;
  (2) a 429 within the grace window keeps deferring even past
      ``rate_429_until`` (boundary-herd protection), and self-clears once the
      429 ages past the grace.
"""
from __future__ import annotations

import sys
import time
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import src.activities.rate_guard as rate_guard_mod  # noqa: E402
from src.config import Config  # noqa: E402
from src.activities.rate_guard import (  # noqa: E402
    RATE_429_GRACE_SECONDS,
    RATE_429_MAX_BACKOFF_SECONDS,
    RateGuard,
)


def _cfg(tmp_path: Path) -> Config:
    return Config(alfred_data_dir=str(tmp_path))


@pytest.mark.asyncio
async def test_record_429_honors_multiday_horizon(tmp_path: Path) -> None:
    """A 4-day horizon is honored, not clamped down to 24h."""
    cfg = _cfg(tmp_path)
    guard = RateGuard(cfg)
    await guard.record_429(4 * 24 * 60 * 60)
    state = rate_guard_mod._read_state(cfg)
    remaining = float(state["rate_429_until"]) - time.time()
    assert remaining > 3.5 * 24 * 60 * 60  # ~4 days, well past the old 24h cap


@pytest.mark.asyncio
async def test_record_429_clamps_at_7d(tmp_path: Path) -> None:
    """An absurd horizon is still bounded by the 7d ceiling."""
    cfg = _cfg(tmp_path)
    guard = RateGuard(cfg)
    await guard.record_429(30 * 24 * 60 * 60)  # 30 days
    state = rate_guard_mod._read_state(cfg)
    remaining = float(state["rate_429_until"]) - time.time()
    assert RATE_429_MAX_BACKOFF_SECONDS - 60 < remaining <= RATE_429_MAX_BACKOFF_SECONDS + 5


@pytest.mark.asyncio
async def test_grace_blocks_after_deadline(tmp_path: Path) -> None:
    """Past rate_429_until but a 429 within grace -> still deferred."""
    cfg = _cfg(tmp_path)
    guard = RateGuard(cfg)
    now = time.time()
    state = rate_guard_mod._empty_state()
    state["rate_429_until"] = now - 10            # deadline already passed
    state["rate_429_last_event_ts"] = now - 10    # but a 429 fired 10s ago
    rate_guard_mod._write_state(cfg, state)
    dec = await guard.check_and_reserve(task_path="t", matter_path="m")
    assert not dec.allowed
    assert dec.cap == "rate_429"


@pytest.mark.asyncio
async def test_grace_clears_when_stale(tmp_path: Path) -> None:
    """Past rate_429_until and the last 429 older than grace -> calls resume."""
    cfg = _cfg(tmp_path)
    guard = RateGuard(cfg)
    now = time.time()
    stale = now - (RATE_429_GRACE_SECONDS + 60)
    state = rate_guard_mod._empty_state()
    state["rate_429_until"] = stale
    state["rate_429_last_event_ts"] = stale
    rate_guard_mod._write_state(cfg, state)
    dec = await guard.check_and_reserve(task_path="t", matter_path="m")
    assert dec.allowed
