"""render_sms_gateway.py — ensure `gateway.platforms.sms` block in config.yaml.

`render_hermes.py` seeds the per-profile config.yaml ONCE; on subsequent boots
the file is operator-owned and never re-rendered. That's fine for most blocks
(operator can edit via `hermes config`), but it means a template-only addition
of a new gateway platform (like the one Lane V landed for SMS) is invisible to
any tenant whose config.yaml was seeded before the template change.

Telegram + Slack don't hit this issue because Hermes auto-detects them from
env vars (`TELEGRAM_BOT_TOKEN`, etc.) without a config block. SMS is opt-in:
Hermes' `gateway/platforms/sms.py` only starts its webhook listener when the
config carries `gateway.platforms.sms.enabled: true` AND the env vars are
present. So we need an idempotent, ADD-only mutator that backfills the block
on every init boot (preserving any operator override on `enabled: false`).

The same shape will likely apply to any future opt-in adapter (Discord,
Matrix, BlueBubbles, Mattermost). For now this script handles SMS only — if
another opt-in adapter lands, copy the function with the right env-var names.
"""

from __future__ import annotations

from pathlib import Path
from typing import Literal


def ensure_sms_gateway_block(
    config_path: Path,
) -> Literal["added", "present", "no-config"]:
    """Idempotently add `gateway.platforms.sms` to ``config_path``.

    Returns:
      "no-config" if the file doesn't exist (init step is best-effort,
        callers should not abort on a missing config).
      "present"   if the block is already there — left byte-equal.
      "added"     if the block was injected.

    The mutator is ADD-only: an operator-disabled (``enabled: false``) block
    is preserved as-is. The four ``*_env`` indirections always point at the
    canonical env-var names so a future credential-rotation doesn't drift.
    """
    if not config_path.exists():
        return "no-config"

    from ruamel.yaml import YAML

    yaml = YAML()
    yaml.preserve_quotes = True

    text = config_path.read_text(encoding="utf-8")
    data = yaml.load(text)
    if data is None:
        data = {}

    gateway = data.setdefault("gateway", {})
    if not isinstance(gateway, dict):
        # Hermes ships `gateway:` as a mapping or omits it; anything else is
        # operator surgery we shouldn't second-guess.
        return "present"
    platforms = gateway.setdefault("platforms", {})
    if not isinstance(platforms, dict):
        return "present"

    if "sms" in platforms:
        # Operator-owned (could be enabled: true OR enabled: false). Don't
        # touch — both states are legitimate ways for the operator to express
        # "I have configured this".
        return "present"

    platforms["sms"] = {
        "enabled": True,
        "account_sid_env": "TWILIO_ACCOUNT_SID",
        "auth_token_env": "TWILIO_AUTH_TOKEN",
        "phone_number_env": "TWILIO_PHONE_NUMBER",
        "allowed_users_env": "SMS_ALLOWED_USERS",
    }

    with config_path.open("w", encoding="utf-8") as f:
        yaml.dump(data, f)
    return "added"


if __name__ == "__main__":
    import os
    import sys

    profile_dir = Path(
        os.environ.get("MAIN_PROFILE_DIR", "/hermes-state/profiles/main")
    )
    config = profile_dir / "config.yaml"
    try:
        outcome = ensure_sms_gateway_block(config)
    except Exception as exc:
        # Best-effort step; never abort init on a render hiccup.
        print(f"[render-sms-gateway] WARN {config}: {exc}", file=sys.stderr)
        sys.exit(0)
    print(f"[render-sms-gateway] {config}: {outcome}")
