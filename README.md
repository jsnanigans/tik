# tik

A fast Jira CLI for the terminal. Reads come from a local SQLite cache, so they are instant and work offline; writes go straight to Jira.

## Features

- Sprint board, your open tickets, ticket details and a full markdown export
- Fuzzy, exact and semantic search with filters, plus raw JQL
- Create, edit, transition, comment, link and attach from the command line
- Interactive triage and Gantt-style timelines built from the changelog
- GitHub PR, review and CI status next to your tickets
- Ticket, branch, worktree and PR workflow in one command (`tik flow`)
- Confluence pages (`tik doc`)
- `--json` and `--plain` output on every command

## Requirements

- [Bun](https://bun.sh) and [just](https://github.com/casey/just)
- [1Password CLI](https://developer.1password.com/docs/cli/) with an item named `atlassian api token` that has `username` (your Atlassian email) and `token` ([API token](https://id.atlassian.com/manage-profile/security/api-tokens)) fields
- Optional: [GitHub CLI](https://cli.github.com/) for PR status and `tik flow`

## Setup

```bash
git clone https://github.com/jsnanigans/tik.git && cd tik
mkdir -p ~/.config/tik && cp config.example.json ~/.config/tik/config.local.json
just install     # builds and copies the binary to ~/.local/bin
tik sync         # fill the local cache
```

Edit `~/.config/tik/config.local.json` for your Jira instance. `jiraBase`, `defaultProject` and `syncProjects` are required; any other command-specific key is named in the error when it is missing. Everything instance-specific lives there: workflow statuses, transition IDs, custom field IDs, teams, project aliases and GitHub repos. `config.example.json` lists every field.

## Usage

```bash
tik                          # my tickets in the current sprint
tik sprint -a                # the whole team's sprint
tik mine                     # my open tickets
tik view PROJ-123 -A         # details with description, AC and testing instructions
tik search "login bug"       # fuzzy text search
tik search -p PROJ -t Bug -s "In Progress" -a me
tik search --jql "project = PROJ ORDER BY updated DESC"

tik create "Title" -p PROJ -t Bug --priority 2 -a --current-sprint
tik edit PROJ-123 -s "New title" --add-label tech-debt
tik start PROJ-123           # move to In Progress
tik comment PROJ-123 "text"

tik flow start "Title"       # ticket + branch + worktree
tik flow pr --open           # push and open a PR with the Jira link
tik pr PROJ-123              # PR state, reviews, CI

tik export PROJ-123          # full local markdown copy
tik triage                   # fill missing type, sprint, points, team
tik timeline PROJ-123
```

Commands that take a ticket key fall back to the key in the current git branch name. `create` and `edit` only change what you pass and accept `--dry-run`.

Reads use the cache; add `-F` to sync first or run `tik sync`. `tik --help` lists every command and `tik <command> --help` its flags. [AGENTS.md](AGENTS.md) is the complete reference and is also printed by `tik --ai`.

### Semantic search

```bash
tik embed sync   # first run downloads the ~325 MB EmbeddingGemma model
tik embed        # embedding stats
```

Once embeddings exist, text search combines keyword and vector ranking. Plain search never downloads the model; without embeddings it uses keywords only.

## License

MIT
