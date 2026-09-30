# tik

A fast Jira CLI for the terminal. Reads come from a local SQLite cache, so they are instant and work offline.

## Features

- Sprint board, your tickets, ticket details and markdown export
- Fuzzy and semantic search with filters
- Interactive triage and Gantt-style timelines
- Create, edit, transition and comment from the command line
- GitHub PR and CI status next to your tickets
- Branch, worktree and PR workflow (`tik flow`)

## Requirements

- [Bun](https://bun.sh) and [just](https://github.com/casey/just)
- [1Password CLI](https://developer.1password.com/docs/cli/) with an item named `atlassian api token` that has `username` (your Atlassian email) and `token` ([API token](https://id.atlassian.com/manage-profile/security/api-tokens)) fields
- Optional: [GitHub CLI](https://cli.github.com/) for PR status, [Ollama](https://ollama.com/) with `nomic-embed-text` for semantic search

## Setup

```bash
git clone https://github.com/jsnanigans/tik.git && cd tik
mkdir -p ~/.config/tik && cp config.example.json ~/.config/tik/config.local.json
just install     # builds and copies the binary to ~/.local/bin
tik sync         # fill the local cache
```

Edit `~/.config/tik/config.local.json` for your Jira instance. `jiraBase`, `defaultProject` and `syncProjects` are required; `tik` names any other key a command needs. Workflow statuses, custom field IDs, teams, project aliases and GitHub repos are all set there. See `config.example.json`.

## Usage

```bash
tik                      # current sprint
tik mine                 # your open tickets
tik view PROJ-123        # ticket details
tik search "login bug"   # search
tik start PROJ-123       # move to In Progress
tik flow start "Title"   # ticket + branch + worktree
tik --help               # all commands
```

Every command supports `--json` and `--plain`; `-F` syncs first.

## License

MIT
