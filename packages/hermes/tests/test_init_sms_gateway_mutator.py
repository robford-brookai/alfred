"""Tests for render_sms_gateway.py — the idempotent ADD-only mutator that
backfills `gateway.platforms.sms` into the main-profile config.yaml.

Why this script exists (in short): `render_hermes.py` is seed-only — once
config.yaml exists on disk, init never re-renders it. That's correct for
operator-owned files, but it means a template-only addition of a new opt-in
gateway platform (which Hermes' SMS adapter REQUIRES — it doesn't auto-detect
from env vars like Telegram/Slack do) is invisible to any tenant whose
config.yaml was seeded before the template change.

This mutator runs after `render_hermes.py` on every init boot. It is:
  - ADD-only: never overwrites an existing block, even if disabled
  - Operator-friendly: an operator-set `enabled: false` survives
  - Idempotent: byte-equal output when the block is already there
  - Best-effort: no-config returns cleanly so init never aborts
"""

from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest


HERMES = Path(__file__).resolve().parent.parent
RENDER_SCRIPT = HERMES / "init" / "render_sms_gateway.py"


def _load_render_module():
    spec = importlib.util.spec_from_file_location(
        "render_sms_gateway", RENDER_SCRIPT
    )
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture
def render_module():
    pytest.importorskip(
        "ruamel.yaml",
        reason="ruamel.yaml is the round-trip YAML mutator the init image installs.",
    )
    return _load_render_module()


# --- core behaviour ---------------------------------------------------------
def test_added_when_block_absent(tmp_path: Path, render_module):
    """A config.yaml with no `gateway:` block at all gets the SMS block
    injected. This is the case for tenants whose config was seeded before
    the template carried the gateway.platforms.sms block at all.
    """
    config = tmp_path / "config.yaml"
    config.write_text(
        "model:\n  default: x/main\nagent:\n  max_turns: 80\n",
        encoding="utf-8",
    )

    assert render_module.ensure_sms_gateway_block(config) == "added"

    from ruamel.yaml import YAML
    data = YAML().load(config.read_text())
    sms = data["gateway"]["platforms"]["sms"]
    assert sms["enabled"] is True
    assert sms["account_sid_env"] == "TWILIO_ACCOUNT_SID"
    assert sms["auth_token_env"] == "TWILIO_AUTH_TOKEN"
    assert sms["phone_number_env"] == "TWILIO_PHONE_NUMBER"
    assert sms["allowed_users_env"] == "SMS_ALLOWED_USERS"
    # Existing keys preserved.
    assert data["model"]["default"] == "x/main"
    assert data["agent"]["max_turns"] == 80


def test_added_when_gateway_exists_but_no_platforms_sms(tmp_path: Path, render_module):
    """A config.yaml that already has `gateway:` for some other reason
    (e.g. an empty `platforms: {}` from a Hermes default seed) gets the
    SMS sub-block grafted in WITHOUT touching sibling keys.
    """
    config = tmp_path / "config.yaml"
    config.write_text(
        "gateway:\n"
        "  platforms: {}\n"
        "  some_other_gateway_key: keepme\n",
        encoding="utf-8",
    )

    assert render_module.ensure_sms_gateway_block(config) == "added"

    from ruamel.yaml import YAML
    data = YAML().load(config.read_text())
    assert data["gateway"]["platforms"]["sms"]["enabled"] is True
    # Sibling key under gateway is preserved.
    assert data["gateway"]["some_other_gateway_key"] == "keepme"


def test_noop_when_block_already_present(tmp_path: Path, render_module):
    """If the block is already there (operator-set or previously injected),
    don't touch it. Output is byte-equal to the input."""
    original = (
        "gateway:\n"
        "  platforms:\n"
        "    sms:\n"
        "      enabled: true\n"
        "      account_sid_env: TWILIO_ACCOUNT_SID\n"
        "      auth_token_env: TWILIO_AUTH_TOKEN\n"
        "      phone_number_env: TWILIO_PHONE_NUMBER\n"
        "      allowed_users_env: SMS_ALLOWED_USERS\n"
    )
    config = tmp_path / "config.yaml"
    config.write_text(original, encoding="utf-8")

    assert render_module.ensure_sms_gateway_block(config) == "present"
    assert config.read_text() == original  # byte-equal


def test_operator_disabled_block_preserved(tmp_path: Path, render_module):
    """An operator-set `enabled: false` survives. The mutator is ADD-only,
    never an enforce-on-true overwrite. This is how an operator opts out of
    SMS even though the rest of the platform supports it."""
    config = tmp_path / "config.yaml"
    config.write_text(
        "gateway:\n"
        "  platforms:\n"
        "    sms:\n"
        "      enabled: false\n",
        encoding="utf-8",
    )

    assert render_module.ensure_sms_gateway_block(config) == "present"

    from ruamel.yaml import YAML
    data = YAML().load(config.read_text())
    assert data["gateway"]["platforms"]["sms"]["enabled"] is False
    # The mutator did NOT graft the four *_env keys onto an
    # operator-disabled block.
    assert "account_sid_env" not in data["gateway"]["platforms"]["sms"]


def test_no_config_returns_cleanly(tmp_path: Path, render_module):
    """A missing config.yaml is a recoverable state — the init step
    must never abort because of it. Returns a sentinel string instead
    of raising."""
    assert (
        render_module.ensure_sms_gateway_block(tmp_path / "missing.yaml")
        == "no-config"
    )


# --- entrypoint.sh wire pin -------------------------------------------------
def test_entrypoint_invokes_sms_gateway_step():
    """The init entrypoint must call render_sms_gateway.py, guarded for the
    case where the main profile's config.yaml does not yet exist."""
    src = (HERMES / "init" / "entrypoint.sh").read_text()
    assert "render_sms_gateway.py" in src
    assert 'MAIN_PROFILE_DIR="$HERMES_DATA_DIR/profiles/main"' in src
    assert 'if [[ -f "$MAIN_PROFILE_DIR/config.yaml" ]]; then' in src, (
        "Step must guard for missing config.yaml so init never aborts on "
        "fresh boot before render_hermes seeds the file."
    )


def test_entrypoint_sms_step_runs_after_render_hermes():
    """Order matters: render_hermes seeds the file; render_sms_gateway
    backfills the block. The reverse order would mean a fresh-tenant boot
    runs the mutator before the file exists, which is the no-config branch
    — harmless, but the mutator's whole purpose is to upgrade existing
    files, so it must come AFTER the seeder."""
    src = (HERMES / "init" / "entrypoint.sh").read_text()
    render_idx = src.find("python3 /setup/render_hermes.py")
    sms_idx = src.find("python3 /setup/render_sms_gateway.py")
    chown_idx = src.find('chown -R 10000:10000 "$HERMES_DATA_DIR"')
    assert 0 < render_idx < sms_idx < chown_idx


def test_dockerfile_copies_render_sms_gateway():
    """The init image must bundle the mutator alongside render_hermes.py."""
    dockerfile = (HERMES / "init" / "Dockerfile").read_text()
    assert "COPY packages/hermes/init/render_sms_gateway.py" in dockerfile, (
        "render_sms_gateway.py must be COPY'd into the init image."
    )
