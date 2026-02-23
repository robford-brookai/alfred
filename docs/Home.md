# Alfred Wiki

Alfred is a set of AI-powered background services that keep your [Obsidian](https://obsidian.md) vault organized, connected, and intelligent.

## What is Alfred?

Alfred runs four background workers that continuously process, organize, and enrich your vault:

| Tool | Purpose | How it works |
|------|---------|-------------|
| [Curator](Curator) | Inbox processing | Watches `inbox/`, creates structured records from raw files, extracts entities, interlinks everything |
| [Janitor](Janitor) | Vault quality | Scans for broken links, invalid frontmatter, orphaned files; fixes them automatically |
| [Distiller](Distiller) | Knowledge extraction | Reads operational records, extracts assumptions, decisions, constraints, contradictions, syntheses |
| [Surveyor](Surveyor) | Semantic mapping | Embeds vault content, clusters by similarity, labels clusters, writes relationship tags |

## Quick Navigation

- **Getting Started**
  - [Installation](Installation)
  - [Configuration](Configuration)
  - [User Profile](User-Profile)

- **Tools**
  - [Curator](Curator) — inbox processing (4-stage pipeline)
  - [Janitor](Janitor) — vault quality (3-stage pipeline)
  - [Distiller](Distiller) — knowledge extraction (2-pass pipeline)
  - [Surveyor](Surveyor) — semantic mapping (4-stage pipeline)

- **Reference**
  - [CLI Commands](CLI-Commands)
  - [Vault Schema](Vault-Schema)
  - [Live Dashboard](Live-Dashboard)
  - [Architecture](Architecture)
  - [Agent Backends](Agent-Backends)

## Quick Start

```bash
pip install alfred-vault
alfred quickstart
alfred up --live
```

Drop a file into your vault's `inbox/` folder and watch the curator process it in real time.
