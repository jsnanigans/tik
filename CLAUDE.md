# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Overview

`tik` is a Bun-based Jira CLI. Commands are defined with `citty`, terminal UI is rendered with Ink (React for CLI), reads come from a local SQLite cache (`~/.cache/tik/tickets.db`) and credentials come from 1Password (`op`), cached in `/tmp/tik-creds-<uid>`.

Usage documentation lives in `AGENTS.md` (also printed by `tik --ai`), `README.md` (setup and overview) and, locally, `claude_skill/jira-cli/` (git-ignored). Keep them in sync with any flag or behavior change.

## Commands

```bash
bun run main.ts [command]   # run from source (or: just run [args])
just check                  # tsc --noEmit
just build                  # compile ./tik via build.ts and codesign it
just install                # build and copy to ~/.local/bin
just clear-cache            # drop the cached credentials
```

There is no test suite. Verify changes with `--dry-run` (`create`, `edit`) and read-only commands.

## Layout

- `main.ts`: entry point. `cmd*` functions first, then the `citty` command tree (`main`), shared state in module-level `global*` variables set by `applyFormat()`. `out()` prints, `emitError()` prints a text or JSON error and exits, `requireTicket()` resolves a key from the argument or the git branch.
- `github.ts`: PR data through the `gh` CLI (`fetchPRsForTickets`, `fetchPRDetail`, `createPullRequest`, `validateReviewGate`, `fetchMyPRs`). Repos come from `githubRepos`; PRs are matched to tickets by the key in the branch name.
- `lib/`
  - `index.ts`: re-export hub.
  - `config.ts`: loads and validates `config.local.json`; `requireSetting()` and `requireCustomField()` fail only the commands that need the missing key.
  - `credentials.ts`: 1Password lookup and the `/tmp` cache.
  - `api.ts`: Jira REST wrappers (`jiraGet/Post/Put/Delete/Upload`, `jiraSearch`, `jiraSearchPaginated`, `jiraBulkFetch`, `jiraBulkChangelog`).
  - `cache.ts`: SQLite schema, sync metadata, local queries, key resolution (`resolveKey`), user directory.
  - `search.ts`, `hybrid-search.ts`, `fuzzy.ts`: MiniSearch index (persisted in `~/.cache/tik/`), RRF merge with vector results, excerpt highlighting.
  - `embeddings.ts`, `embed-sync.ts`: in-process EmbeddingGemma (transformers.js) embedder, issue chunking, and the pending-chunks pipeline.
  - `parser.ts`: raw Jira JSON to typed `IssueData`, `SprintData`, `CommentData`, `IssueLinkData`.
  - `markdown.ts`: markdown to ADF (`markdownToAdf`), ADF and Jira wiki to markdown, `tikmedia:` image placeholders.
  - `history.ts`, `timeline.ts`, `export.ts`: changelog parsing, timeline graph, `tik export` renderer.
  - `confluence.ts`: Confluence pages API for `tik doc`.
  - `terminal.ts`, `colors.ts`, `util.ts`: width and truncation, progress indicators, ANSI constants (`C`), git helpers, `readFileArg`, `PriorityMap`.
- `ui/`: Ink components. `render.tsx` (`renderStatic`, `renderInteractive`), `table.tsx` (generic `Table`, `selectable` or parent-controlled `highlightIndex`), `views.tsx`, `history.tsx`, `timeline.tsx`, `triage.tsx`, `prompts.tsx`, `sync.tsx`, `format.ts`.

## Conventions

- Define flags on the `citty` command next to the other options, read them in `run`, pass typed options to a `cmd*` function.
- Never define two short flags that differ only by case (`-s` and `-S`) on one command. citty folds them into one key, so `-s` also enables `-S`. Use a long name for the second one (`--current-sprint`).
- Write commands must only change what the user passed. No implicit sprint, team, assignee or status.
- Invalid user input aborts with `emitError()`; do not silently skip it.
- Config values that differ per Jira instance (statuses, custom field IDs, transition IDs, teams, repos) belong in `config.local.json`, never in code.
- All JSON and plain output goes through `out()`; do not print progress or decoration when `globalFormat` is not `table`.

## Configuration

Settings live in `~/.config/tik/config.local.json`; `config.example.json` lists every field.

- Required for every command: `jiraBase`, `defaultProject`, `syncProjects`. A missing file, invalid JSON or a missing required field exits with a message naming the path. `--version` and `--help` work without a config.
- Read through `requireSetting()`: `myTeamId`, `myBoardId`, `inProgressTransitionId`, `reviewTransitionId`.
- Optional: `githubRepos`, `prBaseBranches`, `projectAliases`, `statuses`, `teamBoardMap`, `teamIdNames`, `users`, `botAuthors`, `confluence`, `timelineFirstProject`, `teamName`, `myEmail`.
- Custom field IDs are read from `customFields` (`team`, `sprint`, `storyPoints`, `epicLink`, `acceptanceCriteria`, `testingInstructions`). Reads use `customFields.<name>`; writes use `requireCustomField("<name>")`.
