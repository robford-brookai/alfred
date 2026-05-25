"""Tests for the SMS gateway-platform block in the rendered Hermes config.

Hermes' built-in SMS adapter (`gateway/platforms/sms.py`) is enabled iff
config.yaml carries a `gateway.platforms.sms` block. Twilio credentials are
then picked up natively via env-var names declared in the block — never
hard-coded into config.yaml. Parity with the existing Telegram channel:

  gateway:
    platforms:
      sms:
        enabled: true
        account_sid_env: TWILIO_ACCOUNT_SID
        auth_token_env: TWILIO_AUTH_TOKEN
        phone_number_env: TWILIO_PHONE_NUMBER
        allowed_users_env: SMS_ALLOWED_USERS

The block is rendered ONLY on the `main` profile — workers/heavy run no
messaging channels. This file pins:

  1. main profile renders gateway.platforms.sms with enabled: true
  2. main profile renders the four `*_env` keys pointing at the correct
     Twilio / SMS_ env-var names
  3. workers profile does NOT render a gateway.platforms.sms block
  4. heavy profile does NOT render a gateway.platforms.sms block
"""

from __future__ import annotations

from pathlib import Path

import pytest
import yaml

HERMES = Path(__file__).resolve().parent.parent


def _render(profile: str) -> str:
    from jinja2 import Environment, FileSystemLoader, StrictUndefined

    env = Environment(
        loader=FileSystemLoader(str(HERMES)),
        undefined=StrictUndefined,
        keep_trailing_newline=True,
    )
    return env.get_template("hermes-config.yaml.njk").render(
        profile=profile,
        main_model="x/main",
        workers_model="x/workers",
        heavy_model="x/heavy",
        alfred_prime="",
        cross_tenant_peers="",
    )


def _parse(rendered: str) -> dict:
    """Parse the rendered YAML so assertions reflect structure, not text layout."""
    return yaml.safe_load(rendered)


# --- main profile: block present, env-driven --------------------------------
def test_main_renders_sms_gateway_block():
    rendered = _render("main")
    data = _parse(rendered)
    sms = (data.get("gateway") or {}).get("platforms", {}).get("sms")
    assert sms is not None, (
        "main config must carry a `gateway.platforms.sms` block — without it "
        "Hermes' SMS adapter never starts."
    )
    assert sms.get("enabled") is True, (
        "gateway.platforms.sms.enabled must be True on the main profile."
    )


def test_main_sms_block_points_at_correct_env_vars():
    """The 4 env-var indirections — credentials are loaded from env, never
    inlined into config.yaml. The names must match what ctrl-api writes via
    `/channels` → Save (and what the docker-compose env passthrough expects).
    """
    rendered = _render("main")
    data = _parse(rendered)
    sms = data["gateway"]["platforms"]["sms"]
    assert sms["account_sid_env"] == "TWILIO_ACCOUNT_SID"
    assert sms["auth_token_env"] == "TWILIO_AUTH_TOKEN"
    assert sms["phone_number_env"] == "TWILIO_PHONE_NUMBER"
    assert sms["allowed_users_env"] == "SMS_ALLOWED_USERS"


def test_main_sms_block_does_not_inline_credentials():
    """Belt-and-braces: the rendered YAML must NOT contain bare Twilio token /
    SID values — only `*_env` indirections. A regression that inlines
    `account_sid: AC...` would silently leak credentials into the seed file.
    """
    rendered = _render("main")
    data = _parse(rendered)
    sms = data["gateway"]["platforms"]["sms"]
    for forbidden in ("account_sid", "auth_token", "phone_number", "allowed_users"):
        assert forbidden not in sms, (
            f"gateway.platforms.sms.{forbidden} must NOT be inlined — "
            f"use {forbidden}_env to indirect through .env."
        )


# --- workers + heavy: no SMS block ------------------------------------------
@pytest.mark.parametrize("profile", ["workers", "heavy"])
def test_non_main_profiles_have_no_sms_block(profile: str):
    rendered = _render(profile)
    data = _parse(rendered)
    gateway = data.get("gateway") or {}
    platforms = gateway.get("platforms") or {}
    assert "sms" not in platforms, (
        f"{profile} profile must NOT render gateway.platforms.sms — "
        "workers and heavy run no messaging channels."
    )
