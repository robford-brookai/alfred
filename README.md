# Alfred

Alfred is a set of AI-powered background services that keep your [Obsidian](https://obsidian.md) vault organized, connected, and intelligent — without you doing the busywork.

You drop a raw file into your inbox. Alfred turns it into a structured record, links it to the right projects and people, scans for broken references, extracts decisions and assumptions you made along the way, and maps how everything in your vault relates to everything else. It runs quietly in the background.

## What does that look like?

You paste a meeting transcript into `inbox/`. A few seconds later, Alfred has:

- Created a **conversation** record with participants, status, and activity log
- Created or updated **person** records for everyone mentioned
- Filed **tasks** with assignees and linked them to the right project
- Linked everything together with wikilinks so it shows up in the right views automatically

Later, the janitor notices a project page has a broken link and fixes it. The distiller reads your recent session notes and extracts a **decision** record ("We chose Postgres over DynamoDB") with rationale and evidence links. The surveyor notices that three unrelated notes are all about the same theme and tags them as a cluster.

You don't trigger any of this. It just happens.

## Quick Start

**Prerequisites:** Python 3.11+ and an AI agent backend. The default is [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (`claude` on PATH). Alternatives: Zo Computer (HTTP API) or OpenClaw.

```bash
pip install alfred-vault
alfred quickstart
```

The quickstart wizard walks you through choosing a vault path, agent backend, and optional surveyor setup. It scaffolds the vault directory structure (including templates, base views, and a `user-profile.md`), writes `config.yaml`, and offers to start daemons immediately.

```bash
alfred up          # start background daemons
alfred up --live   # start with real-time TUI dashboard
alfred status      # check what's running
alfred down        # stop everything
```

## The Four Tools

**Curator** watches your `inbox/` folder. When a new file appears (email, voice memo transcript, raw notes), curator processes it through a 4-stage pipeline: (1) an LLM analyzes the content and creates a rich note, (2) pure-Python entity resolution deduplicates and creates people, orgs, projects, and other entities, (3) interlinking wires up wikilinks between the note and all entities, and (4) a per-entity LLM pass enriches each record with substantive body content and filled frontmatter. The result is a dense, well-connected graph — not stubs.

Entity extraction is context-aware: Alfred reads your `user-profile.md` to understand what's relevant to you. It only creates records for entities you directly interact with — not things merely mentioned or analyzed in your notes.

**Janitor** periodically scans every file in your vault for structural problems: broken wikilinks, missing or invalid frontmatter fields, orphaned files with no connections, stub records with no real content. It uses a 3-stage pipeline: (1) pure-Python autofix for deterministic issues like invalid types, missing fields, and field type mismatches, (2) per-file LLM calls for ambiguous broken wikilink repair with candidate matching, and (3) per-file LLM enrichment of stub records using only existing vault context and verifiable public facts — no generated filler.

**Distiller** reads your operational records — conversations, session logs, project notes — and identifies latent knowledge worth extracting. It uses a multi-stage pipeline: Pass A extracts learnings per-source-record via LLM, deduplicates and merges across sources with fuzzy title matching (pure Python), then creates well-formed learning records via focused per-learning LLM calls. Pass B performs cross-learning meta-analysis — scanning the entire learning graph for contradictions between decisions, shared assumptions, and emergent syntheses, creating higher-order records that link the reasoning graph together. The result is an evidence graph that evolves from having things to having reasoning.

**Surveyor** works differently from the other three. It embeds your vault content into vectors (via Ollama locally or an OpenAI-compatible API), clusters records by semantic similarity using HDBSCAN + Leiden community detection, asks an LLM to label the clusters, and writes relationship tags and wikilinks back into your files.

## Live Dashboard

```bash
alfred up --live
```

The live dashboard shows a 2x2 grid with one panel per worker. Each panel displays:

- **Health indicator** — healthy, degraded, failing, stopped, or restarting
- **Current pipeline step** — what the worker is doing right now
- **Interpreted event feed** — human-readable status messages instead of raw log lines, color-coded by severity (green=success, yellow=warning, red=error)
- **LLM usage** — call count and token/character usage
- **Footer** — uptime, active workers, aggregate error/warning counts, recent vault mutations

The dashboard interprets ~60+ structlog events into meaningful messages like "Stage 1 done — 3 entities found", "Created person/John Doe", or "Sweep done — 10/12 issues fixed". It also detects silent failures: pipelines that "complete" with zero results, manifests that weren't written, and poor fix rates.

## Install

```bash
# Base install (curator + janitor + distiller)
pip install alfred-vault

# Full install (adds surveyor — requires Ollama for embeddings + OpenRouter for labeling)
pip install "alfred-vault[all]"

# From source
git clone https://github.com/ssdavidai/alfred.git
cd alfred
pip install -e .          # base
pip install -e ".[all]"   # full
```

## CLI

```bash
# Daemon management
alfred up                              # start all daemons (background)
alfred up --foreground                 # stay attached (dev/debug)
alfred up --live                       # start with real-time TUI dashboard
alfred up --only curator,janitor       # start specific tools
alfred down                            # stop daemons
alfred status                          # per-tool status overview

# Batch processing
alfred process                         # batch-process all inbox files (Rich TUI)
alfred process -j 8                    # 8 parallel workers (default: 4)
alfred process -n 10                   # process only 10 files
alfred process --dry-run               # show what would be processed

# Bulk import
alfred ingest conversations.json       # split ChatGPT/Anthropic export into inbox files
alfred ingest export.json --dry-run    # preview without writing

# Run tools individually
alfred curator                         # curator daemon (foreground)
alfred janitor scan                    # structural scan, print report
alfred janitor fix                     # scan + AI agent fix
alfred janitor watch                   # periodic sweep daemon
alfred distiller scan                  # find extraction candidates
alfred distiller run                   # scan + extract knowledge records
alfred distiller watch                 # periodic extraction daemon
alfred surveyor                        # full embed/cluster/label/write pipeline

# Direct vault operations
alfred vault create <type> <name>      # create a record
alfred vault read <path>               # read a record
alfred vault edit <path>               # edit a record
alfred vault list [type]               # list records

# Run external commands with vault context
alfred exec -- <command>               # injects ALFRED_VAULT_PATH etc.
alfred exec --scope curator -- <cmd>   # also sets ALFRED_VAULT_SCOPE
```

All commands accept `--config path/to/config.yaml` (default: `config.yaml` in cwd).

## Configuration

`alfred quickstart` generates both files interactively. To configure manually instead:

```bash
cp config.yaml.example config.yaml
cp .env.example .env
# Edit both files
```

`config.yaml` has sections for `vault`, `agent`, `logging`, and each tool. Environment variables are substituted via `${VAR}` syntax. See `config.yaml.example` for all options.

### User Profile

Alfred uses a `user-profile.md` file in your vault root to understand who you are. This helps entity extraction focus on things relevant to you rather than creating records for every person, company, or topic mentioned in your notes.

The quickstart wizard creates a template. Fill it in with your name, work context, and interests. If the file is empty or missing, Alfred falls back to general-purpose extraction.

## Agent Backends

Curator, janitor, and distiller delegate the actual reading and writing to an AI agent. You choose which one:

| Backend | How it runs | Setup |
|---------|------------|-------|
| **Claude Code** (default) | `claude -p` subprocess | Install [Claude Code](https://docs.anthropic.com/en/docs/claude-code), ensure `claude` is on PATH |
| **Zo Computer** | HTTP API | Set `ZO_API_KEY` in `.env` |
| **OpenClaw** | `openclaw` subprocess | Install OpenClaw, ensure `openclaw` is on PATH |

Set `agent.backend` in `config.yaml` to `claude`, `zo`, or `openclaw`.

## Vault Structure

The vault uses structured Markdown files with YAML frontmatter. Records link to each other with `[[wikilinks]]` — open any project page and you'll see live tables of its tasks, conversations, sessions, and people, all populated automatically.

**20 record types:**

| Category | Types |
|----------|-------|
| Operational | project, task, session, conversation, input, note, process, run, event, thread |
| Entity | person, org, location, account, asset |
| Epistemic | assumption, decision, constraint, contradiction, synthesis |

`alfred quickstart` scaffolds the full directory structure with templates, base view definitions, and starter views (Home, CRM, Task Manager).

### Template System

Each record type has a template in `_templates/` that defines default frontmatter fields and body structure. Templates include base-view embeds (e.g., `![[project.base#Tasks]]`) that render live Dataview tables in Obsidian.

When records are created — whether by the curator pipeline, vault CLI, or manual creation — templates are automatically applied. Even when custom body content is provided (e.g., during entity creation), base-view embeds are preserved and appended to ensure every record gets its Dataview sections.

## Data & State

Runtime state lives in `data/`. The vault itself is the source of truth — state files are bookkeeping and can be deleted to force a full re-process.

| File | Purpose |
|------|---------|
| `data/*_state.json` | Per-tool processing state (what's been seen, sweep history, etc.) |
| `data/vault_audit.log` | Append-only JSONL log of every vault mutation |
| `data/alfred.pid` | PID file for the background daemon |
| `data/*.log` | Per-tool log files |

## Architecture

```
src/alfred/
  cli.py               # CLI dispatcher
  daemon.py             # background process management
  orchestrator.py       # multiprocess daemon manager with auto-restart
  dashboard.py          # Rich TUI live dashboard (2x2 worker feed grid)
  quickstart.py         # interactive setup wizard
  _data.py              # bundled resource locator (importlib.resources)

  curator/              # inbox processor (4-stage pipeline)
  janitor/              # vault quality scanner + fixer (3-stage pipeline)
  distiller/            # knowledge extractor (2-pass pipeline)
  surveyor/             # semantic embedder + clusterer (4-stage pipeline)

  vault/                # vault operations layer (CRUD, mutation log, scoping)

  _bundled/             # data files shipped in the wheel
    skills/             # agent skill prompts (one per tool)
    scaffold/           # vault directory structure, templates, base views
```

Each tool follows the same module pattern: `config.py` (typed dataclass), `daemon.py` (async entry point), `state.py` (JSON persistence), `backends/` (agent interface), `pipeline.py` (multi-stage processing), `cli.py` (subcommands).

## Documentation

Full documentation is available in [`docs/`](docs/) and on the [GitHub Wiki](https://github.com/ssdavidai/alfred/wiki):

- [Installation](docs/Installation.md)
- [Configuration](docs/Configuration.md)
- [CLI Commands](docs/CLI-Commands.md)
- [Vault Schema](docs/Vault-Schema.md)
- [Curator](docs/Curator.md) | [Janitor](docs/Janitor.md) | [Distiller](docs/Distiller.md) | [Surveyor](docs/Surveyor.md)
- [Live Dashboard](docs/Live-Dashboard.md)
- [Architecture](docs/Architecture.md)
- [Agent Backends](docs/Agent-Backends.md)
- [User Profile](docs/User-Profile.md)

## License

MIT
