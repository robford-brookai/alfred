# Installation

## Requirements

- Python 3.11 or later
- An AI agent backend (see [Agent Backends](Agent-Backends))
- An Obsidian vault (or Alfred will scaffold one for you)

## Install from PyPI

```bash
# Base install (curator + janitor + distiller)
pip install alfred-vault

# Full install (adds surveyor with ML/vector dependencies)
pip install "alfred-vault[all]"
```

The base install includes the curator, janitor, and distiller. The `[all]` extra adds the surveyor, which requires numpy, scikit-learn, hdbscan, igraph, leidenalg, pymilvus, and an embedding provider.

## Install from Source

```bash
git clone https://github.com/ssdavidai/alfred.git
cd alfred
pip install -e .          # base
pip install -e ".[all]"   # full (with surveyor)
```

## Setup

Run the interactive quickstart wizard:

```bash
alfred quickstart
```

The wizard will:

1. Ask for your vault path (or create a new one)
2. Scaffold the vault directory structure (entity directories, templates, base views, starter views)
3. Create a `user-profile.md` in your vault root
4. Ask which agent backend to use (Claude Code, Zo Computer, or OpenClaw)
5. Write `config.yaml` and `.env`
6. Optionally configure the surveyor (Ollama for embeddings, OpenRouter for labeling)
7. Offer to start daemons immediately

## Manual Setup

If you prefer to configure manually:

```bash
cp config.yaml.example config.yaml
cp .env.example .env
```

Edit both files. See [Configuration](Configuration) for all options.

## Verifying Installation

```bash
alfred status          # check what's configured
alfred up --live       # start with dashboard to see everything working
```

## Surveyor-Specific Setup

The surveyor requires additional infrastructure:

1. **Ollama** (for local embeddings):
   ```bash
   # Install Ollama: https://ollama.com
   ollama pull nomic-embed-text    # or your preferred embedding model
   ```

2. **OpenRouter API key** (for cluster labeling):
   - Sign up at https://openrouter.ai
   - Add your API key to `.env`: `OPENROUTER_API_KEY=sk-or-...`

3. **Milvus Lite** (automatic):
   - Installed with `[all]` extra
   - File-based vector store at `data/milvus_lite.db`
   - No external server needed
