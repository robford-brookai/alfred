<div align="center">

# Alfred

**Personal agentic infrastructure. Self-hosted. Always on.**

A layered AI architecture that captures your data, maintains your knowledge, executes your workflows, and communicates on your behalf.

[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Python 3.11+](https://img.shields.io/badge/python-3.11+-green.svg)](https://python.org)
[![PyPI](https://img.shields.io/pypi/v/alfred-vault.svg)](https://pypi.org/project/alfred-vault/)

</div>

---

Chatbots answer questions. Agentic tools complete tasks. Alfred runs your life.

Alfred is a self-hosted agentic butler — six layers of intelligence that work together so your AI doesn't just respond when prompted, it observes, thinks, acts, and learns continuously. Your Obsidian vault becomes a living knowledge graph that both you and your agents maintain together. Temporal workflows execute durable, auditable operations. Data pipelines capture the world around you. And it all runs on infrastructure you control.

---

## The Six Layers

```
 Interface     Telegram, WhatsApp, Slack, iMessage, SMS, email, CLI, TUI
     |
   Agent        Claude Code, Zo Computer, OpenClaw — pluggable AI backends
     |
  Kinetic       Temporal workflows — durable, scheduled, auditable execution
     |
 Semantic       Obsidian vault — human-readable, agent-writable knowledge graph
     |
   Data          Omi transcripts, meeting recordings, email digests, RSS — raw signal in
     |
   Infra         Mac Mini, VPS (Hetzner/DO/AWS), personal cloud (Zo Computer)
```

### Semantic Layer — Your vault is the single source of truth

An Obsidian vault with 20 structured record types, wikilinked into a knowledge graph that both you and your agents can read, write, and reason over. Four specialized workers maintain it continuously:

| Worker | Role |
|--------|------|
| **Curator** | Watches `inbox/` and turns raw files (transcripts, emails, notes) into structured, interlinked records |
| **Janitor** | Scans for broken links, invalid frontmatter, orphaned files — and fixes them |
| **Distiller** | Reads operational records and extracts latent knowledge: assumptions, decisions, constraints, contradictions |
| **Surveyor** | Embeds content into vectors, clusters by semantic similarity, discovers and writes relationship tags |

The vault is both the agent's operational memory and your second brain. Not a database — a browseable, versioned, wikilinked knowledge base.

### Kinetic Layer — Durable workflow execution

A Temporal-based execution engine that orchestrates agent work as durable workflows. If it crashes, it picks up where it left off. An agent can sleep for days and resume with full context.

```bash
alfred temporal worker                    # start the workflow worker
alfred temporal run MyWorkflow            # trigger a workflow
alfred temporal schedule register defs.py # register cron schedules
alfred temporal list                      # list discovered workflows
```

Write workflows in Python. Activities like `spawn_agent`, `run_script`, and `notify_slack` are built in. The agent handles reasoning; Python handles control flow.

### Agent Layer — Pluggable AI backends

| Backend | Type | Notes |
|---------|------|-------|
| **Claude Code** | Subprocess | Default. Install [Claude Code](https://docs.anthropic.com/en/docs/claude-code), `claude` on PATH |
| **Zo Computer** | HTTP API | Cloud-based. Set `ZO_API_KEY` in `.env` |
| **OpenClaw** | Subprocess | Self-hosted. Supports multi-stage pipelines |

Switch backends without rewiring. Configure per-workflow agent profiles with different backends, skills, and scopes.

### Data Layer — Pipelines that capture the world

Feed data into your vault's `inbox/` from any source. The Curator processes it into structured records automatically.

- Omi wearable transcripts (conversations processed into records)
- Meeting recordings (Zoom, Sembly AI)
- Email digests, RSS feeds, API webhooks
- Bulk imports via `alfred ingest`

### Interface Layer — Meet Alfred where you are

The interface is governed by your agent runtime:
- **OpenClaw**: Telegram, WhatsApp, Slack, iMessage, Discord, Signal
- **Zo Computer**: Telegram, SMS, email
- **Local**: CLI (`alfred`), TUI dashboard (`alfred tui`), Claude Code

### Infra Layer — Runs where you trust

Your data never leaves your control. Run Alfred on:
- A Mac Mini under your desk
- A VPS (Hetzner, DigitalOcean, AWS)
- Personal cloud (Zo Computer)

---

## Quickstart

```bash
pip install alfred-vault
alfred quickstart          # interactive setup wizard
alfred up                  # start background daemons
```

That's it. The wizard handles vault path, agent backend, and directory scaffolding.

**Prerequisites:** Python 3.11+ and an AI agent on PATH. Default is Claude Code.

## Install

```bash
# Base (semantic layer workers: curator + janitor + distiller)
pip install alfred-vault

# With surveyor (adds ML/vector dependencies)
pip install "alfred-vault[all]"

# With Temporal (kinetic layer)
pip install "alfred-vault[temporal]"

# Everything
pip install "alfred-vault[all]"

# From source
git clone https://github.com/ssdavidai/alfred.git
cd alfred && pip install -e ".[all]"
```

## Vault Structure

Structured Markdown with YAML frontmatter. 20 record types across three categories:

| Category | Types |
|----------|-------|
| **Operational** | project, task, session, conversation, input, note, process, run, event, thread |
| **Entity** | person, org, location, account, asset |
| **Epistemic** | assumption, decision, constraint, contradiction, synthesis |

Records link via `[[wikilinks]]` — open any project page and you'll see live tables of tasks, conversations, and people, populated automatically.

## CLI Reference

```bash
# Daemon management
alfred up                              # start all (background)
alfred up --foreground                 # attached mode (dev/debug)
alfred up --only curator,janitor       # start specific workers
alfred down                            # stop
alfred status                          # overview
alfred tui                             # live dashboard (requires Node.js)

# Semantic layer workers
alfred curator                         # curator daemon (foreground)
alfred janitor scan                    # scan + report
alfred janitor fix                     # scan + AI fix
alfred distiller scan                  # find candidates
alfred distiller run                   # scan + extract
alfred surveyor                        # full pipeline

# Kinetic layer (requires: pip install alfred-vault[temporal])
alfred temporal worker                 # start workflow worker
alfred temporal run <workflow>         # trigger a workflow
alfred temporal schedule register <f>  # register schedules from file
alfred temporal schedule list          # list registered schedules
alfred temporal list                   # list discovered workflows

# Vault operations
alfred vault create <type> <name>      # create record
alfred vault read <path>               # read record
alfred vault edit <path>               # edit record
alfred vault list [type]               # list records

# Data ingestion
alfred ingest <file>                   # split bulk export into inbox files
alfred process                         # batch-process inbox

# External commands with vault context
alfred exec -- <command>               # injects ALFRED_VAULT_PATH
alfred exec --scope curator -- <cmd>   # also sets ALFRED_VAULT_SCOPE
```

## Configuration

```bash
alfred quickstart                      # recommended: interactive setup
# — or —
cp config.yaml.example config.yaml
cp .env.example .env
```

`config.yaml` has sections for `vault`, `agent`, `logging`, each worker tool, and `temporal`. Supports `${VAR}` environment variable substitution. See [`config.yaml.example`](config.yaml.example) for all options.

## Documentation

Full documentation is available in [`docs/`](docs/) and on the [GitHub Wiki](https://github.com/ssdavidai/alfred/wiki):

**Getting Started**
- [Installation](docs/Installation.md) | [Configuration](docs/Configuration.md) | [User Profile](docs/User-Profile.md)

**The Six Layers**
- [Architecture](docs/Architecture.md) — layered architecture overview
- [Semantic Layer](docs/Semantic-Layer.md) — vault as knowledge graph
- [Kinetic Layer](docs/Kinetic-Layer.md) — Temporal workflow engine
- [Agent Backends](docs/Agent-Backends.md) — Claude Code, Zo, OpenClaw

**Workers**
- [Curator](docs/Curator.md) | [Janitor](docs/Janitor.md) | [Distiller](docs/Distiller.md) | [Surveyor](docs/Surveyor.md)

**Reference**
- [CLI Commands](docs/CLI-Commands.md) | [Vault Schema](docs/Vault-Schema.md) | [Live Dashboard](docs/Live-Dashboard.md)

## Use Cases

**Task Manager** — Drop meeting transcripts into inbox. Alfred extracts tasks, assigns them to people, links them to projects, and maintains status. Query your vault for "all open tasks on Project X" and get live Dataview tables.

**CRM** — Every conversation creates or updates person and org records. Relationships, interactions, and context accumulate automatically. Your vault becomes a relationship graph you can browse in Obsidian.

**Automated Workflows** — Schedule Temporal workflows that run your agent on a cadence: daily inbox processing, weekly vault health sweeps, monthly knowledge distillation. Durable execution means nothing gets dropped.

**Knowledge Base** — The Distiller surfaces assumptions your team is operating on, decisions that were made but never documented, and contradictions between records. The Surveyor finds semantic clusters you never noticed. Together they build an evidence graph that evolves with your work.

## Contributing

Alfred is early-stage and actively developed. Issues, PRs, and ideas are welcome.

## License

[MIT](LICENSE)

Built by Test User
