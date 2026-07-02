# hermes-relay — VENDORED

**Upstream:** [Codename-11/hermes-relay](https://github.com/Codename-11/hermes-relay) (Axiom Labs)
**Manifest version:** 1.2.1 (see `plugin.yaml`)
**Captured:** 2026-07-02 from the golden `home.alfred.black` box
(`/hermes-state/profiles/main/plugins/hermes-relay`, plugin source as of upstream
default branch ~2026-06-30).

## Why vendored (not git-cloned at build time)

- The upstream repo has **no tag that maps to manifest `version: 1.2.1`** — its
  release tags top out at `v0.7.0` and `android-v1.2.x` (the Android app), a
  separate scheme. There is no clean, reproducible pinnable ref for the exact
  code home runs.
- Vendoring the **exact tree the proven-good home box runs** guarantees the whole
  fleet is byte-identical to the golden reference — the entire point of this bake.

This mirrors the existing `packages/hermes/plugins/one-alfred` vendoring pattern.

## What was stripped on capture

`__pycache__/` dirs and `*.pyc` bytecode. No `.env`, secrets, `.db`/session, or
pairing state were present in the plugin dir (scanned on capture) — those live in
the profile `.env` and runtime state, not here.

## How it's installed into a profile

- `packages/hermes/Dockerfile`: `COPY packages/hermes/plugins/hermes-relay /opt/hermes-relay`
- `packages/hermes/docker/supervisor.sh`: deploys `/opt/hermes-relay` →
  `$HERMES_HOME/profiles/main/plugins/hermes-relay` at boot (main only) and
  creates the `plugin` import-shim symlink (the plugin uses absolute `plugin.*`
  imports but installs under `hermes-relay/`).

## Refreshing

Re-capture from the golden box (or a newer proven-good one):

```
ssh <box> 'docker exec alfred-black-hermes-1 tar -C /hermes-state/profiles/main/plugins -cf - hermes-relay' \
  | tar -C /tmp -xf -
# strip __pycache__/*.pyc, scan for secrets, then replace this dir.
```
