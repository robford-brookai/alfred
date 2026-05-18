# alfred-black

Single-VM, `docker compose up` deployment of Alfred Black.

This is a standalone reframing of the `alfred-platform` SaaS fleet: **one repo, one VM, one
`docker compose up`** — no Acme Cloud auto-provisioning, no Tailscale, no Cloudflare, no billing.
The AI runtime is **Hermes Agent** ([`NousResearch/hermes-agent`](https://github.com/NousResearch/hermes-agent)),
which replaces OpenClaw's two-container split with a single isolated runtime.

> 🚧 **Status: under construction.** Build is itemised in GitHub issues across four phases —
> see the [project issues](https://github.com/ssdavidai/alfred-black/issues) and the
> milestones (Phase 0 → Phase 3). The full design lives in [`docs/PLAN.md`](docs/PLAN.md).

## Intended flow (target end state)

```sh
git clone https://github.com/ssdavidai/alfred-black
cd alfred-black
cp .env.example .env      # fill DOMAIN, ACME_EMAIL, API keys
./scripts/bootstrap.sh    # generate secrets, validate
docker compose up -d      # the whole system comes up; web app live on your domain over HTTPS
```

## Architecture

Four-store storage model — see [`docs/PLAN.md`](docs/PLAN.md) Part I:

- **Vault** (markdown) — the principal's published knowledge surface.
- **`state.db`** (SQLite + sqlite-vec) — the machine's working memory.
- **Cold archive** (DuckDB/Parquet) — forensic long tail.
- **`ingest.db`** (SQLite) — raw inbound stream, 7-day TTL.

See [`docs/PLAN.md`](docs/PLAN.md) for the complete plan (Parts A–I) and phased task list.
