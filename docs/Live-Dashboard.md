# Live Dashboard

The live dashboard provides real-time visibility into all four Alfred workers through a Rich TUI interface.

## Starting the Dashboard

```bash
alfred up --live
```

This starts all configured daemons and displays a 2x2 grid of per-worker feed panels.

## Layout

```
+-- Curator --- * healthy -- pid 1234 --------++-- Janitor --- @ degraded -- pid 1235 --------+
| Processing inbox/meeting-notes.md            || Starting fix sweep #5                         |
|                                              ||                                               |
| 14:23:01  v Pipeline complete - 3 entities   || 14:22:45  Scan found 12 issues                |
| 14:22:58  Stage 4 done - enriched 2 entities || 14:22:40  Autofix - 8 fixed, 2 flagged        |
| 14:22:50  Stage 3 done - linked 3 entities   || 14:22:30  ! Failed to fix person/Old.md       |
| 14:22:45  v Created person/John Doe          || 14:22:20  v Sweep done - 10/12 issues fixed   |
| 14:22:30  Stage 1 done - note + 3 entities   ||                                               |
|                            12 calls  45k chars||                           8 calls  23k chars   |
+----------------------------------------------++-----------------------------------------------+
+-- Distiller - * healthy -- pid 1236 --------++-- Surveyor -- * healthy -- pid 1237 ----------+
| Idle - next deep run in 45m                  || Embedding diff: 3 new, 1 changed              |
|                                              ||                                               |
| 14:20:01  v Run complete - 5 records created || 14:23:05  Tagged project/X [construction]      |
| 14:19:55  Meta-analysis - 1 synthesis        || 14:23:00  v Labeled 3 clusters                 |
| 14:19:45  v Created decision/API Architecture|| 14:22:50  Found 8 clusters (3 changed)         |
| 14:19:30  Dedup - 8 candidates, 5 unique     || 14:22:40  Embedded 15 files, removed 2         |
|                             5 calls  67k chars||                           3 calls  15k tokens  |
+----------------------------------------------++-----------------------------------------------+
 Uptime: 1h 23m 45s  |  4/4 workers  |  0 errors  3 warnings  |  Ctrl+C to stop
```

## Panel Components

Each worker panel has four parts:

### Title Bar
Shows the tool name, health indicator, and PID.

### Current Step (top line, bold)
What the worker is doing right now:
- Curator: "Processing inbox/file.md", "Stage 2: Entity Resolution", "Watching inbox..."
- Janitor: "Sweep #5", "Scanning...", "Stage 2: Link Repair", "Idle"
- Distiller: "Extraction #3", "Analyzing project X", "Meta-analysis", "Idle"
- Surveyor: "Initial sync", "Embedding diff", "Watching vault", "Idle"

### Event Feed (middle, scrolling)
Human-readable interpreted events, newest first. Each line has a timestamp and severity indicator:
- (dim) Info — normal progress events
- (green) Success — completed operations with results
- (yellow) Warning — anomalies, retries, partial failures
- (red) Error — hard failures

### LLM Usage (bottom, dim)
Call count and token/character usage for the session.

## Health Indicators

| Indicator | Meaning |
|-----------|---------|
| * healthy | Running, no errors |
| @ degraded | Running, 1-4 errors detected |
| ! failing | Running, 5+ errors detected |
| * stopped | Process exited, not restarting |
| * restarting | Process died, waiting to restart |
| o pending | Not yet started |

## Event Interpretation

The dashboard interprets ~60+ structlog events into human-readable messages. Examples:

### Curator Events

| Raw Event | Dashboard Message |
|-----------|------------------|
| `daemon.processing file=notes.md` | Processing inbox/notes.md |
| `pipeline.s1_complete entities_found=3` | Stage 1 done - 3 entities found |
| `pipeline.s2_entity_created entity=person/John` | Created person/John |
| `pipeline.complete entities_resolved=3` | Pipeline complete - 3 entities |
| `daemon.no_changes` | (warning) Agent produced no vault changes |

### Janitor Events

| Raw Event | Dashboard Message |
|-----------|------------------|
| `sweep.start sweep_id=5 fix_mode=true` | Starting fix sweep #5 |
| `scanner.scan_complete issues=12` | Scan found 12 issues |
| `autofix.complete fixed=8 flagged=2` | Autofix - 8 fixed, 2 flagged |
| `sweep.complete issues=12 fixed=10` | Sweep done - 10/12 issues fixed |

### Distiller Events

| Raw Event | Dashboard Message |
|-----------|------------------|
| `extraction.start run_id=3` | Starting extraction run #3 |
| `pipeline.s1_complete source=src.md learnings=4` | Extracted 4 learnings from src.md |
| `pipeline.s2_complete candidates=8 after_dedup=5` | Dedup - 8 candidates, 5 unique |
| `extraction.complete records_created=5` | Run complete - 5 records created |

### Surveyor Events

| Raw Event | Dashboard Message |
|-----------|------------------|
| `embedder.diff_processed upserted=15 deleted=2` | Embedded 15 files, removed 2 |
| `clusterer.complete semantic_clusters=8 changed=3` | Found 8 clusters (3 changed) |
| `daemon.labeling_complete clusters_processed=3` | Labeled 3 clusters |
| `writer.tags_written path=project/X tags=[...]` | Tagged project/X with [...] |

## Silent Failure Detection

The dashboard flags anomalous "successes" that may indicate problems:

- Curator pipeline "complete" with 0 entities created
- Curator Stage 1 found 0 entities (warning)
- File marked processed but no vault changes
- Janitor fixed less than half of detected issues
- Distiller run complete with 0 records created
- Distiller manifest file missing (LLM didn't write it)

## Footer

The footer bar shows:
- Uptime since dashboard start
- Active/total worker count
- Aggregate error and warning counts
- Last 3 vault mutations (create/modify/delete with file names)

## Adaptive Layout

The dashboard adapts to the number of active workers:
- 1 worker: full screen
- 2 workers: side by side
- 3 workers: 2 on top, 1 on bottom
- 4 workers: 2x2 grid

## Background Threads

The dashboard runs three background threads:
- **LogTailThread** — tails `data/{tool}.log` files, parses structlog entries, updates feeds
- **AuditTailThread** — tails `data/vault_audit.log` for vault mutations
- **StatReaderThread** — reads `data/*_state.json` files periodically for stats
