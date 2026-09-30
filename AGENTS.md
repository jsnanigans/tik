# tik - Jira CLI Agent Guide

## Overview

tik is a fast, terminal-first Jira CLI tool built with Bun that enables developers to interact with Jira without leaving the command line. It features a local SQLite cache, hybrid (keyword + semantic) search, interactive UIs, and deep GitHub PR integration.

## Core Architecture

### Components

- **main.ts**: Main entry point with command definitions using `citty`
- **lib/**: Core utilities and business logic
  - `api.ts`: Jira API wrappers
  - `cache.ts`: SQLite cache management with FTS search
  - `embeddings.ts`: Ollama integration for semantic vector search
  - `search.ts`: MiniSearch-based fuzzy text indexing
  - `util.ts`: Terminal utilities, git integration, file handling
  - `github.ts`: GitHub PR integration via `gh` CLI
  - `config.ts`: Local config loader
- **ui/**: Ink (React for CLI) UI components
  - `render.tsx`: Rendering layer with static/interactive modes
  - `views.tsx`: Views for sprint, search, timeline, triage
  - `format.ts`: Formatting utilities for status, PR, priority, projects

### Data Flow

1. Commands execute via `main.ts` using `citty`
2. Data is read from local SQLite cache (`~/.cache/tik/tickets.db`)
3. On first run or with `-F/--fresh`, data syncs from Jira API
4. All read operations are cached - no network calls needed unless forced
5. Semantic search uses Ollama `nomic-embed-text` model for vector embeddings
6. PR status integrates with GitHub via `gh` CLI
7. UI is rendered with `Ink` (React for CLI)

## Key Features

### Instant Local Cache
- All read operations (sprint, mine, search, view) hit local SQLite DB
- Syncs incrementally using `updated` timestamps
- Full sync: `tik sync -f`
- Manual sync: `tik sync`

### Hybrid Search
- Combines keyword search (MiniSearch) with semantic search (Ollama embeddings)
- Uses RRF (Reciprocal Rank Fusion) for optimized ranking
- Fallback to fuzzy keyword search if Ollama unavailable
- Enable/disable: `--no-semantic`, `--no-fuzzy`

### Git Integration
- Auto-detects ticket from git branch (`feature/PROJ-123` → PROJ-123)
- `tik flow` commands automate:
  - Ticket creation
  - Feature branch creation
  - Worktree switching
  - PR creation
- Worktrees maintain isolated development environments

### PR Status Overlay
- Shows GitHub PR status next to Jira tickets:
  - `○` / `●` / `○` for open/merged/closed
  - `✓` / `✗` / `?` for review status
  - `✓` / `✗` / `◌` for CI checks
- Integrated via `gh pr list` and `gh search commits`

### Interactive Triage
- `tik triage`: Edit multiple tickets in one view
- Update status, type, sprint, points, assignee, labels in bulk
- Uses Ink Table with selectable rows

### Timeline Visualization
- Gantt-style view built from changelog history
- Shows start/done dates, dependencies, transitions
- Works for sprint, epic, or custom search

### Command-Line First
- All operations available from CLI, no browser needed
- Supports `--json`, `--plain` for scripting
- Rich markdown support for descriptions, AC, TI
- File input: `tik create "Title" -d ./desc.md`

## Essential Commands

| Command | Description |
|--------|-------------|
| `tik` / `tik sprint` | View current sprint |
| `tik mine` | View all open tickets assigned to you |
| `tik prio` | View high priority tickets |
| `tik view KEY` | View ticket details with description, AC, TI |
| `tik search "query"` | Fuzzy + semantic text search |
| `tik triage` | Interactive bulk-edit missing fields |
| `tik timeline KEY` | Gantt timeline with dependencies |
| `tik create "Summary"` | Create new ticket (-a, -S, -i, -t, --ac, --ti available) |
| `tik edit KEY` | Edit ticket fields |
| `tik start KEY` | Transition to "In Progress" |
| `tik review KEY` | Transition to your review status |
| `tik comment KEY "msg"` | Add comment |
| `tik link KEY --blocks TARGET` | Create link between tickets |
| `tik log` | View recent changes to your tickets |
| `tik sync` | Sync from Jira to local cache |
| `tik flow start KEY` | Create ticket + git branch + worktree |
| `tik flow pr` | Create or open GitHub PR for current branch |
| `tik flow status` | Show Jira+git+PR workflow status |
| `tik doc view ID` | View Confluence page content as markdown |
| `tik doc create "Title"` | Create Confluence page (--space, --parent, -d, --stdin available) |
| `tik doc edit ID` | Edit Confluence page interactively in terminal |
| `tik doc search "query"` | Search Confluence pages (local FTS or online via -O) |
| `tik doc sync` | Sync Confluence pages to local cache |


## Configuration

### Required Files

- `~/.config/tik/config.local.json`: User-specific config (created from `config.example.json`)
- `~/.cache/tik/tickets.db`: Local SQLite cache (auto-created)

### Required External Tools

| Tool | Purpose |
|------|---------|
| `op` (1Password CLI) | Fetches Jira API token (never stored in config) |
| `gh` (GitHub CLI) | Fetches PR status and creates PRs |
| `ollama` | Enables semantic search with `nomic-embed-text` (optional) |
| `bun` | Runtime and package manager |
| `just` | Command runner for build tasks |

### config.local.json Fields

| Field | Description |
|-------|-------------|
| `jiraBase` | Jira URL (e.g., `https://your-org.atlassian.net`) |
| `myEmail` | Your Atlassian account email |
| `defaultProject` | Your main project key (e.g., `PROJ`) |
| `syncProjects` | Array of project keys to sync |
| `myBoardId` | Your agile board ID |
| `myTeamId` | Your team's UUID in Jira |
| `inProgressTransitionId` | Transition ID for "In Progress" |
| `reviewTransitionId` | Transition ID for your review status |
| `teamBoardMap` | Maps team names to board IDs |
| `teamIdNames` | Maps team UUIDs to names |
| `githubRepos` | Maps Jira projects to GitHub repos |
| `projectAliases` | Maps project keys to shorthand used to resolve keys (e.g., `p123`) |
| `timelineFirstProject` | Project listed first within timeline groups |
| `statuses` | Workflow status names by role (`inProgress`, `review`, `ready`, `todo` subgroups, `done`, `reviewName`, `timeline`); defaults to the Jira default workflow |
| `customFields` | Jira custom field IDs by role (`team`, `sprint`, `storyPoints`, `epicLink`, `acceptanceCriteria`, `testingInstructions`) |
| `users` | Array of team members with `isMainAccount: true` for you |

## Semantic Search Setup (Optimal Experience)

```bash
# Install Ollama
brew install ollama

# Pull the embedding model (274MB)
ollama pull nomic-embed-text

# Start the server (run in background)
ollama serve

# Validate
tik embed check

# Sync embeddings (for existing tickets)
tik embed sync
```

Check embedding status:
```bash
tik embed
```

## Workflows

### Daily Flow
1. `tik` → see sprint
2. `tik mine` → see your open tickets
3. `tik search "billing bug"` → finds issues
4. `tik view PROJ-123` → view details
5. `tik start PROJ-123` → begin work
6. `tik flow start PROJ-123` → create branch + worktree
7. `tik flow pr --open` → create PR and open in browser
8. `tik log` → track changes

### Triaging Workflow
```bash
tik triage -a
```
Use arrow keys to navigate - press Enter to edit any field (status, sprint, points, etc.)

### Timeline Flow
```bash
tik timeline -S
```
Shows timeline from changelog: when tickets moved to "In Progress", "Ready for Review", etc.

## Key Dependencies Library

- **bun**: Fast JS runtime
- **citty**: Command-line interface builder
- **Ink**: React for CLI rendering
- **sqlite**: Local SQLite cache
- **minisearch**: Fuzzy keyword search engine
- **ollama**: Local LLM for embeddings
- **gh**: GitHub CLI for PR integration
- **1password-cli**: Secure credential storage

## Performance

- Sprint view: Instant (<50ms) — cached locally
- Full sync: ~2-3min for 1000+ tickets
- Embedding sync: ~45s for 1000 tickets

## Note on Ollama

Ollama is optional — all functionality works without it. Semantic search just improves search quality when available.
