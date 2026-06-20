"""Shared cap-aware backoff between the curator and the learn signal pipeline.

Both processes hammer the same ``openai-codex`` (ChatGPT Pro) cap and the same
hermes gateway concurrency limiter. The learn signal pipeline persists a rate
guard at ``/alfred-data/state/steward/rate-guard.json`` keyed on
``rate_429_until`` (epoch seconds). The curator HONORS and FEEDS that same file
so a 429 hit by either side throttles both.

No cross-package import: we just read/write the JSON by path. This module is a
deliberately small, dependency-free mirror of the key the learn rate guard owns.
"""

from __future__ import annotations

import json
import re
import time
from pathlib import Path

from .utils import get_logger

log = get_logger(__name__)

# Canonical shared rate-guard file (owned by the learn signal pipeline).
DEFAULT_BACKOFF_PATH = "/alfred-data/state/steward/rate-guard.json"

# JSON key both sides agree on. Epoch seconds; LLM calls are deferred until now
# passes this value.
_BACKOFF_KEY = "rate_429_until"

# Clamp window for armed backoffs: never shorter than 30s (avoid tight retry
# loops), never longer than 24h (avoid a parse glitch stalling the daemon for
# days).
_MIN_BACKOFF = 30
_MAX_BACKOFF = 24 * 60 * 60


class RateBackoffDeferred(Exception):
    """Raised when an LLM call is skipped because a shared backoff is active.

    Callers must treat this as "deferred, retry later" — NOT a hard failure.
    A deferred file is left pending (not quarantined, not counted toward the
    poison-file failure threshold).
    """

    def __init__(self, until: float) -> None:
        self.until = until
        remaining = max(0, int(until - time.time()))
        super().__init__(f"rate-backoff active for ~{remaining}s (until={until})")


def resolve_backoff_path(
    path: str | Path | None = None,
    data_dir: str | Path | None = None,
) -> Path:
    """Resolve which rate-guard file to use.

    Prefers ``path`` when given. Otherwise uses the canonical shared path if its
    parent directory exists (the normal deployed case). As a last resort — e.g.
    in tests or a dev box without /alfred-data — derives a sibling under the
    curator's own ``data_dir`` so we never write into a nonexistent root.
    """
    if path is not None:
        return Path(path)

    canonical = Path(DEFAULT_BACKOFF_PATH)
    if canonical.parent.exists():
        return canonical

    if data_dir is not None:
        return Path(data_dir) / "steward" / "rate-guard.json"

    return canonical


def read_backoff_until(path: str | Path | None = None) -> float:
    """Return the active ``rate_429_until`` epoch, or 0.0 if none/unreadable.

    Tolerates a missing file, malformed JSON, or a missing key — always returns
    a float so callers can compare against ``time.time()`` without guarding.
    """
    p = resolve_backoff_path(path)
    try:
        data = json.loads(Path(p).read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return 0.0
    try:
        return float(data.get(_BACKOFF_KEY) or 0.0)
    except (TypeError, ValueError):
        return 0.0


def arm_backoff(seconds: float, path: str | Path | None = None) -> float:
    """Set ``rate_429_until = now + seconds`` (clamped), merging existing JSON.

    Only extends the horizon — if an existing backoff already reaches further
    into the future we keep it (so a short concurrency 429 can't shorten a long
    cap outage). Returns the resulting ``rate_429_until``.
    """
    p = resolve_backoff_path(path)
    secs = max(_MIN_BACKOFF, min(_MAX_BACKOFF, int(seconds)))
    new_until = time.time() + secs

    data: dict = {}
    try:
        existing = json.loads(Path(p).read_text(encoding="utf-8"))
        if isinstance(existing, dict):
            data = existing
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        data = {}

    try:
        current = float(data.get(_BACKOFF_KEY) or 0.0)
    except (TypeError, ValueError):
        current = 0.0
    if current > new_until:
        new_until = current

    data[_BACKOFF_KEY] = new_until

    try:
        Path(p).parent.mkdir(parents=True, exist_ok=True)
        tmp = Path(p).with_suffix(".tmp")
        tmp.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        tmp.replace(p)
    except OSError as e:
        log.warning("rate_backoff.write_failed", path=str(p), error=str(e))

    log.warning("rate_backoff.armed", path=str(p), seconds=secs, until=new_until)
    return new_until


def parse_backoff_seconds_from_output(text: str) -> int | None:
    """Inspect combined subprocess stdout+stderr for a 429 and return a horizon.

    Returns:
      * the cap-reset horizon (seconds) for an ``openai-codex`` usage-cap 429
        (``usage_limit_reached`` / "the usage limit has been reached"), parsed
        from ``resets_in_seconds`` or ``resets_at - now``; 0 if the payload is
        present but no horizon could be parsed (caller uses a default).
      * 60 for a gateway concurrency 429 ("Too many concurrent runs" /
        ``rate_limit_exceeded``).
      * ``None`` if no 429 signature is present.
    """
    if not text:
        return None
    lowered = text.lower()

    if "usage_limit_reached" in lowered or "the usage limit has been reached" in lowered:
        m = re.search(r"resets_in_seconds[\"']?\s*[:=]\s*(\d+)", text)
        if m:
            try:
                secs = int(m.group(1))
            except ValueError:
                secs = 0
            if secs > 0:
                return secs
        m = re.search(r"resets_at[\"']?\s*[:=]\s*(\d+)", text)
        if m:
            try:
                resets_at = int(m.group(1))
            except ValueError:
                resets_at = 0
            delta = int(resets_at - time.time())
            if delta > 0:
                return delta
        return 0  # cap payload but no usable horizon — caller defaults

    if "too many concurrent runs" in lowered or "rate_limit_exceeded" in lowered:
        return 60

    return None
