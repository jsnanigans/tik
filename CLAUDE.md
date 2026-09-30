# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

A Bun-based CLI tool for interacting with Jira using `citty` for command parsing. Credentials are fetched from 1Password (`op` CLI) and cached locally. Terminal UI is rendered with Ink (React for CLI).

## Commands

```bash
# Development
bun run main.ts [command]       # Run directly
just run [args]                 # Run via justfile

# Build
just build                      # Compile to ./tik binary
just install                    # Build and copy to ~/.local/bin/

# Type checking
just check                      # Run tsc --noEmit

# Maintenance
just clear-cache                # Clear credential cache
```

## CLI Commands

### Default / Sprint
All read commands use the local SQLite cache by default (instant, offline). Use `-F` / `--fresh` to sync from Jira before running.

```bash
tik                    # My sprint issues (default view, from cache)
tik -F                 # Sync first, then show sprint
tik sprint             # Same as above
tik sprint -a          # All team's sprint issues
tik sprint -e          # Expand done section
tik sprint -i          # Sprint info only (no issues)
tik sprint -g          # Show sprint goals
```

### Issue Operations
```bash
tik view [KEY]         # View ticket details with description, AC, TI (from cache)
tik view [KEY] -F      # Sync first, then view
tik export [KEY]       # Full local markdown copy: fields, links, attachments,
                       #   description, AC, TI, comments, changelog (live from Jira)
tik export [KEY] --out DIR|FILE.md --stdout --cached --bots
tik open [KEY]         # Open in browser
tik branch             # View ticket from git branch
tik pr [KEY]           # Show PR state, review, and CI (from key or branch)
tik prio               # High priority tickets in sprint (from cache)
tik prio -F            # Sync first, then show prio
tik mine               # All my open tickets (from cache)
tik mine -F            # Sync first, then show mine
tik search "login bug"  # Text search (fuzzy, summary + description)
  --summary "text"      # Search summary only
  --jql "JQL"           # Raw JQL query (bypasses filters, searches Jira API)
  -p PROJ,PORTAL          # Project(s)
  -t Bug,Task           # Issue type(s)
  -s "In Progress"      # Status(es)
  -a me|none|"Name"     # Assignee
  -r me|"Name"          # Reporter
  -l label1,label2      # Labels
  --priority High       # Priority (1-5 or name)
  -S                    # Current sprint
  --sprint 123|none     # Specific sprint or backlog
  --created -7d         # Created in last 7 days
  --updated -24h        # Updated in last 24 hours
  --resolved -7d        # Resolved in last 7 days
  --epic PROJ-100      # Tickets in epic
  --parent PROJ-50     # Subtasks of ticket
  --my-team             # Your team (myTeamId)
  --points 3|">0"|none  # Story points filter
  --recent              # Updated in last 7 days
  --stale 30            # NOT updated in 30 days
  --backlog             # No sprint + not done
  --my-created          # Created by me
  --sort updated|created|resolved|priority  # Sort field
  --asc                 # Sort ascending
  -m 100                # Max results
  --keys                # Output only keys
  --count               # Just show count
  -e, --expand-done     # Expand done section in table output
  -F, --fresh           # Sync before searching
  --no-fuzzy            # Disable fuzzy matching (exact match only)
  --no-semantic         # Disable semantic/vector search (keyword only)
  --min-score 50        # Minimum fuzzy score threshold (default: 50)
  --contains "text"     # Exact case-insensitive substring over summary/description/AC/TI (unranked, unlimited unless -m)
  --contains-any FILE   # One token per line (--contains-any=- for stdin); JSON {token: [{key, summary, status, statusCategory, doneAt}]}
```

### Triage
```bash
tik triage             # Interactively triage tickets missing fields
tik triage -a          # Include all tickets, not just those missing fields
```

### Timeline
```bash
tik timeline PROJ-123       # Timeline for a ticket and its related tickets
tik timeline "search text"   # Timeline from search results
tik timeline -S              # Timeline for current sprint
tik timeline --epic PROJ-100  # Timeline for epic
tik timeline ... --no-expand # Don't expand to related tickets
```
Accepts the same search filters as `tik search`. Shows a Gantt-style lane visualization with start/done dates from changelog, dependency graph connections.

### Transitions
```bash
tik start [KEY]        # → In Progress
tik review [KEY]       # → your review status (statuses.reviewName)
tik review [KEY] --gate-ci  # Gate transition on PR open + approved + passing checks
tik transition [KEY]   # List available transitions
tik transition KEY STATUS  # Transition to specific status
```

### Create
```bash
tik create "Summary"
  -p PROJ              # Project (default: PROJ)
  -t Task               # Type (default: Task)
  -d "description"      # Description
  -a                    # Assign to me
  -e                    # Add your team (myTeamId)
  -S                    # Add to current sprint
  --sprint <id>         # Add to specific sprint
  --priority 1-5|High   # Set priority
  --points 3            # Story points
  --ac "criteria"       # Acceptance criteria
  --ti "testing"        # Testing instructions
  -i                    # Move to In Progress
```

### Edit
```bash
tik edit [KEY]         # Edit ticket (from branch if no key)
  -s "New title"        # Update summary
  -d "Description"      # Update description
  -a me|none|<id>       # Set assignee (me, unassign, or account ID)
  -p 1-5|High           # Set priority (number or name)
  -e                    # Assign to your team (myTeamId)
  -S                    # Add to current sprint
  --sprint <id>|none    # Add to specific sprint or remove
  --points 3            # Set story points
  --ac "criteria"       # Set acceptance criteria
  --ti "testing"        # Set testing instructions
  --labels "a,b"        # Set labels (comma-separated)
  --add-label "x"       # Add a label
  --remove-label "x"    # Remove a label
```

### Comments
```bash
tik comment [KEY] "msg"  # Add a comment
tik comment [KEY] -m f   # Add comment from file
tik comments [KEY]       # View all comments (bodies capped at 15 lines)
tik comments [KEY] -n 5  # View last 5 comments
tik comments [KEY] --full     # No line cap
tik comments [KEY] --md       # Raw markdown bodies (pipe/redirect friendly)
tik comments [KEY] --no-bots  # Hide CI/automation comments (--bots for only those)
tik comments [KEY] --author X # Filter by author
tik comments [KEY] --json [--raw]  # Parsed (filters applied) or unparsed Jira response
```

Bot authors are matched by substring against `botAuthors` in config.local.json;
defaults cover Continuous Integration, Automation for Jira, GitHub and Zapier.

### Links
```bash
tik link KEY --blocks TARGET        # This blocks that
tik link KEY --is-blocked-by TARGET # This is blocked by that
tik link KEY --relates-to TARGET    # Relates to
tik links [KEY]                     # View links on ticket
```

### Cache Sync
```bash
tik sync               # Incremental sync (changes since last sync)
tik sync -f            # Full sync (ignore last sync time)
tik sync -a            # Include done/closed tickets
tik sync -p PROJ,PORTAL  # Sync specific projects only
tik sync --stats       # Show cache statistics only
tik sync -c            # Refresh changelogs only (skip ticket fetch)
```

The sync command downloads tickets from Jira and stores them in a local SQLite cache (`~/.cache/tik/tickets.db`). By default:
- Only syncs open tickets (excludes Done, Released, etc.)
- Uses incremental sync based on `updated` timestamp
- Fetches in batches of 100 with progress indicator
- Generates vector embeddings via Ollama (best-effort, skipped if Ollama not running)

All read commands use local cache by default. Use `-F` / `--fresh` to sync before running. All commands support `--json` and `--plain` output formats.

### Embeddings (Semantic Search)
```bash
tik embed              # Show embedding stats (total, embedded, pending)
tik embed sync         # Generate embeddings for all pending tickets
tik embed check        # Check Ollama availability and model status
```

Requires Ollama running locally with `nomic-embed-text` model:
```bash
ollama pull nomic-embed-text
ollama serve
```

When embeddings are available, text searches automatically use hybrid search (keyword + semantic vector similarity with RRF ranking). Use `--no-semantic` to disable vector search.

### Log
```bash
tik log                # Changes to my tickets in last 30 hours
tik log sprint         # Changes to my sprint tickets in last 30 hours
tik log sprint -a      # Changes to ALL sprint tickets
tik log -a             # Changes to ALL cached tickets
tik log -h 5           # Last 5 hours instead of default 30
tik log -F             # Sync cache first, then show log
```

### Markdown Support
Rich text fields (`-d`, `--ac`, `--ti`) support full markdown, auto-converted to Jira format:
- Headers (`# H1`, `## H2`, etc.)
- Bold (`**text**`), italic (`*text*`), strikethrough (`~~text~~`)
- Inline code (`` `code` ``) and code blocks (` ```lang `)
- Links (`[text](url)`)
- Bullet lists (`- item`) and numbered lists (`1. item`)
- Blockquotes (`> quote`)
- Tables (`| col | col |`)

### File Input
Pass a file path to read content from a file instead of inline text. Files are auto-detected by path patterns (`/`, `./`, `~/`) or extensions (`.md`, `.txt`):
```bash
tik create "Title" -d ./description.md
tik edit PROJ-123 -d spec.md --ac acceptance.md
tik create title.txt -d ~/docs/description.md   # First line of file used as summary
```

### GitHub PR Integration
```bash
tik --pr              # Show PR status alongside issues
tik sprint --pr       # Sprint view with PR info
tik view KEY --pr     # Single issue with PR details
tik mine --pr         # My tickets with PR status
```

PR status indicators (in list view):
- `○` open / `●` merged / `○` closed (red)
- Review: `✓` approved / `✗` changes requested / `?` review required
- Checks: `✓` passing / `✗` failing / `◌` pending

PRs are matched by ticket key in branch name (e.g., `feature/PROJ-123-*`).

## Architecture

- **main.ts**: CLI entry point with citty command definitions and business logic
  - `Config`: Jira URLs, team IDs, board IDs, transition IDs, synced projects
  - Command functions: `cmdOpen`, `cmdBranch`, `cmdStart`, `cmdSearch`, `cmdTriage`, etc.
  - Global state: output format, PR flag, expand-done flag, grep/type filters

- **ui/**: Ink (React for CLI) rendering layer
  - `render.tsx`: `renderStatic()` for one-shot output, `renderInteractive()` for interactive views with rerender
  - `format.ts`: `StatusCategory` (status groupings with colors), `getStatusColor()`, `formatProjectKey()`, `formatPriority()`, `formatTypeIcon()`, `formatPoints()`, `formatPRStatus()`
  - `table.tsx`: Generic `Table` component with two modes:
    - `selectable` — Table handles its own `useInput` for arrow keys/enter
    - `highlightIndex` — parent component controls highlight (for use alongside other `useInput` hooks)
  - `views.tsx`: View components — `IssueListView`, `SearchResultsView`, `SprintView`, `SprintSummaryView`, `SprintGoalsView`, `LinksView`, `CommentsView`, `HelpView`
  - `timeline.tsx`: `TimelineView` — Gantt-style lane visualization with dependency connections
  - `triage.tsx`: `runTriageInk()` — interactive triage UI with editable fields (status, type, sprint, points, team, assignee)
  - `prompts.tsx`: `promptSelect()` — interactive selection using Table with `selectable=true`
  - `sync.tsx`: `SyncView` — incremental sync progress display

- **lib/**: Shared utilities
  - `index.ts`: Central re-export hub for all lib modules
  - `api.ts`: Jira API helpers (`jiraGet()`, `jiraPost()`, `jiraPut()`, `jiraSearch()`, `jiraSearchPaginated()`, `jiraBulkFetch()`)
  - `cache.ts`: SQLite cache (`~/.cache/tik/tickets.db`), FTS search, key resolution, sync metadata, user mapping
  - `colors.ts`: `C` — ANSI color constants used inside Ink `<Text>` components (not Ink's color props)
  - `credentials.ts`: 1Password credential loading, cached at `/tmp/tik-creds-<uid>`
  - `fuzzy.ts`: `levenshtein()` distance, `highlightTerms()`, `findBestExcerpt()`, `findExcerpts()` for search result highlighting
  - `markdown.ts`: `markdownToAdf()` and `adfToMarkdown()` for Atlassian Document Format conversion
  - `parser.ts`: `parseIssue()`, `parseIssues()`, `parseSprint()`, `parseComments()`, `parseIssueLinks()` → typed data
  - `search.ts`: MiniSearch-based full-text indexing with disk persistence (`~/.cache/tik/search-index.json`), stop word filtering, `searchCacheHybrid()` for RRF-based keyword+vector search
  - `embeddings.ts`: Ollama client (`generateEmbedding()`, `generateEmbeddings()`), `cosineSimilarity()`, `prepareEmbeddingText()`, `isOllamaAvailable()`
  - `embed-sync.ts`: `syncEmbeddings()` batch pipeline, `computeContentHash()` for change detection
  - `terminal.ts`: Terminal width, truncation, loading indicators, ANSI stripping
  - `timeline.ts`: `fetchTimelineDates()`, `extractTimelineDates()`, `expandRelatedTickets()`, `buildGraph()`, `buildTimeline()` — changelog-based timeline with dependency graph
  - `util.ts`: `readFileArg()`, `ticketFromBranch()`, `formatRelativeDate()` (14h, 2d, 1w, 2mo, 1y), `abbreviateName()`, `PriorityMap`, `PriorityNames`

- **github.ts**: GitHub PR integration via `gh` CLI
  - `GithubRepos`: Maps Jira projects → GitHub repos (from `githubRepos` in config)
  - `fetchPRsForTickets()`: Fetches PR data for a list of Jira ticket keys
  - `fetchPRsForRepo()`: Fetches all PRs from a GitHub repo
  - Matches PRs to tickets by extracting ticket key from branch name

## Configuration

All instance, team, project and repo settings live in `~/.config/tik/config.local.json` (see `config.example.json` and the README for every field), loaded and validated by `lib/config.ts`:
- `jiraBase`, `defaultProject`, `syncProjects` are required for every command; a missing file, invalid JSON or a missing required field exits with a message pointing at the config path. `--version` and `--help` work without a config.
- `myTeamId`, `myBoardId`, `inProgressTransitionId`, `reviewTransitionId` are read through `requireSetting()` so only the commands that need them fail when they are unset.
- `githubRepos`, `prBaseBranches`, `projectAliases`, `statuses`, `teamBoardMap`, `teamIdNames`, `users`, `botAuthors` and `confluence` are optional.

## Custom Fields

Jira custom field IDs differ per instance and are read from `customFields` in `config.local.json` (`team`, `sprint`, `storyPoints`, `epicLink`, `acceptanceCriteria`, `testingInstructions`). Reads use `customFields.<name>` from `lib/config.ts`; writes use `requireCustomField("<name>")`, which exits with a clear message when the field is not configured.
