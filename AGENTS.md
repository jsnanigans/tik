# tik - Agent Guide

`tik` is a terminal Jira CLI. Read commands hit a local SQLite cache (`~/.cache/tik/tickets.db`), so they are instant and work offline; write commands call Jira directly. This file is also printed by `tik --ai`. `tik <command> --help` is always the source of truth for flags.

## Conventions

- **Output**: `--json` for parsing, `--plain` for tab-separated rows (`KEY STATUS SUMMARY ASSIGNEE POINTS`). Both work on every command. `--json` on list commands returns `{"issues": [...]}` with raw Jira fields; `tik sprint --json` returns `{"sprint": {...}, "issues": [...]}`.
- **Fresh data**: reads use the cache. Add `-F` (`--fresh`) to sync from Jira first, or run `tik sync`. Table output of any command that reads the cache ends with `Synced <age> ago` (never in `--json`/`--plain`).
- **Ticket keys**: `PROJ-123`. Most commands fall back to the key in the git branch name (`feature/PROJ-123-foo`) when `KEY` is omitted. A partial key (`123`, or `p123` with a configured project alias) is resolved against the cache. `move`, `link`, `unlink` and `attach embed` always need an explicit key.
- **Short flags**: citty parses `-s` and `-S` as the same key, so no command defines both. Sprint scoping is always the long flag `--current-sprint`.
- **Rich text** (`-d`, `--ac`, `--ti`, comments) takes markdown, converted to Jira's ADF. A value that looks like a path (contains `/`, starts with `./` or `~/`, ends in `.md`/`.txt`/`.markdown`) and exists is read as a file; quote literal text that could be mistaken for one.
- **Nothing is implicit**: `create` and `edit` only touch the fields you pass. Sprint, team, assignee and status are never defaulted.
- **Dry runs**: `create` and `edit` accept `--dry-run` and print the computed fields without writing to Jira. For `-d`, `--ac`, `--ti` and `--replace` on an existing ticket, it reads the live field and prints a diff, the blocks that would change and the loss guard result.
- **Editing existing rich text**: `edit -d/--ac/--ti` reads the live field, keeps every block you did not change as the original node, and sends nothing when nothing changed. Start from `tik view KEY --edit-md -d` (or `--ac`, `--ti`), which prints the exact markdown that `edit` reads back; the display markdown of `view -d` is lossy. The loss guard refuses the write when node types, marks or attributes of the original are missing from the result (`--force` overrides). Before writing, the previous ADF and its markdown are saved to `~/.cache/tik/backups/KEY/FIELD-TIMESTAMP.json`, and the write is refused if the ticket changed in Jira meanwhile.

## Reading

| Command | Purpose |
|---|---|
| `tik`, `tik sprint` | My tickets in the active sprint. `-a` all team, `-e` expand done, `-i` info only, `-g` goals, `--type`, `--grep`, `--team`, `--group-by team` |
| `tik mine` | All my open tickets (`-e`, `--type`, `--grep`, `--team`, `--group-by team`) |
| `tik prio` | P1/P2 tickets in the sprint |
| `tik view [KEY]` | Details. `-d` description, `--ac`, `--ti`, `-A` all three; `--edit-md` with one of `-d`, `--ac`, `--ti` prints that live field as the exact markdown for `edit` |
| `tik export [KEY]` | Full markdown copy fetched live: fields, links, attachments, description, AC, TI, comments, changelog |
| `tik history [KEY]` | Changelog timeline |
| `tik comments [KEY]` | Comments, bodies capped at 15 lines; `-f` full, `--md` raw markdown, `-n N` last N, `--author X`, `--no-bots`/`--bots`, `--json [--raw]` |
| `tik links [KEY]` | Issue links |
| `tik get [KEY] REFS` | Download attachments by id, filename or `tikmedia:` token (`--out DIR`; default is a temp dir) |
| `tik log [sprint]` | Recent changes to my tickets (`--h N` hours, default 30; `-a` everyone's) |
| `tik standup` | Last `--hours` (default 30) of Jira and GitHub activity matched to tickets |
| `tik sprints` | Board sprints (`--state`, default `active,future`) |
| `tik timeline [QUERY]` | Gantt lanes from changelog for a key or search text. `--no-expand` skips related tickets |
| `tik pr [KEY]` | PR state, reviews, CI, merge readiness (`--ci`, `--reviews`, `--merge`, `-a`, `--mine`, `--repo`, `--project`, `--org`, `--state` open, merged, closed or all) |
| `tik open [KEY]`, `tik branch` | Open in browser; show the branch's ticket |
| `tik open-preview app\|pmp [KEY]` | Open the ticket's PR preview deployment (user-frontend). Reads the URL from the PR's deploy comment and stores it locally; `-F` re-reads it. `--plain` prints the URL |
| `tik whoami`, `tik users` | Identity; user directory |

`--pr` on `tik`, `sprint`, `mine`, `view` and `search` adds PR status to tickets.

### Search

```bash
tik search "login bug"                    # fuzzy text over summary + description
tik search "auth" --summary               # summary only
tik search -p PROJ -t Bug -s "In Progress" -a me
tik search --contains "PROJ-822"          # exact substring over summary/description/AC/TI
tik search --contains-any ids.txt         # one token per line (or =- for stdin), JSON result
tik search --jql "project = PROJ AND labels = urgent ORDER BY updated DESC"
tik jql "project = PROJ AND sprint in openSprints()"
```

Text search is not JQL: JQL passed as the query returns nothing. Use `--jql` or `tik jql`.

Filters: `-p` project, `-t` type, `-s` status, `-a` assignee (`me`, `none`, a name), `-l` labels (all comma-separated), `--priority` (1-5 or name), `--epic KEY`, `--points N|>N|1-5|none|any`, `--updated=-7d` (use `=` before a leading `-`).

More filters: `-r` reporter (`me` or a name), `--my-created`, `--created` and `--resolved` (same formats as `--updated`), `--stale N` (not updated in N days), `--parent KEY`, `--my-team`, `--team NAME`, `--current-sprint` (your board's active sprint), `--sprint ID|none`, `--backlog` (no sprint, not done), `--recent`. Invalid values abort the command. `tik timeline` accepts `--current-sprint` and `--sprint` too.

Team: list tables show a team column (name from `teamIdNames`, else the Jira team name, `-` for none). `--team NAME` (a `teamIdNames` value or `teamName`, case-insensitive) filters, and `--group-by team` groups into one section per team (your team first, `No team` last) without the column; both work on `mine`, `sprint` and `search`. `--json` carries `team` and `teamId`; `--plain` is unchanged. On `create` and `edit`, `-e` sets your team and `--team NAME|ID` sets any team: a team id, or a name (case and punctuation insensitive) from `teamIdNames`, `teamName` or the teams on cached tickets. The two cannot be combined.

Output: `--sort updated|created|resolved|priority|status|key` with `--asc`, `-m N` (default 50; `--count` is capped by it), `--keys`, `--count`, `--compact`, `-e` expand done.

Matching: `--no-fuzzy` exact only, `--no-semantic` keyword only, `--min-score N` (default 30). Keyword matching requires all terms first and falls back to any term (OR) when fewer than 5 results. Once embeddings exist, text search is hybrid keyword + vector; `--json` results carry `semantic: true|false`, and table output prints `semantic search off — run tik embed sync` when vector ranking did not run.

## Writing

```bash
tik create "Summary" -p PROJ -t Task -d ./desc.md --ac "- criterion" --ti "1. step" \
  --priority 2 --points 3 -a -e --current-sprint -i
tik edit PROJ-123 -s "New title" --add-label tech-debt
tik edit PROJ-123 --sprint none --dry-run
tik comment PROJ-123 "text"               # KEY is required with a message; -m FILE, --attach IMG, --edit ID, --rm ID,ID
tik start PROJ-123                        # -> In Progress
tik review PROJ-123 --gate-ci             # -> review status; requires open, approved, green PR
tik move PROJ-123 "Done"                  # also: tik transition KEY [STATUS] lists or applies
tik assign PROJ-123 [me|none|ACCOUNT_ID]   # KEY required to pass an assignee
tik link PROJ-123 --blocks PROJ-456       # --is-blocked-by --relates-to --duplicates --is-duplicated-by
tik unlink PROJ-123 PROJ-456              # or --id LINK_ID
tik attach add|rm|embed ...
```

`create` flags: `-p` project (default from config), `-t` type (default Task), `-d`, `-a` assign to me, `-e` your team, `--team NAME|ID` another team, `--current-sprint`, `--sprint ID`, `--priority`, `--points`, `--ac`, `--ti`, `-i` move to In Progress.

`edit` flags: `-s`, `-d`, `-a me|none|ACCOUNT_ID`, `-p`/`--priority` (1-5 or name), `-e`, `--team NAME|ID`, `--current-sprint`, `--sprint ID|none`, `--points`, `--ac`, `--ti`, `--labels a,b`, `--add-label`, `--remove-label`, `--parent KEY|none`, `--status NAME|ID`, `--replace "old=>new"` (repeatable; changes text inside one text run of the description, AC or TI, and aborts unless `old` matches exactly once and sits in a single run; not combinable with `-d`, `--ac`, `--ti`), `--force` (write despite the loss guard). Invalid priority, sprint or points values abort the command.

Priority: 1 Highest, 2 High, 3 Medium, 4 Low, 5 Lowest.

## Git and PR workflow

Run these inside a git repo.

```bash
tik flow start "Title"        # create ticket if needed, branch from base, switch worktree (-w NAME, -p PROJ, --base, -y)
tik flow start PROJ-123
tik flow pr [--open] [--draft]  # push and create a PR with Jira title and link
tik flow status               # ticket, branch, worktree, PR and CI together
tik opr                       # push and open the PR in the browser
```

PRs are matched to tickets by the key in the branch name. Repos come from `githubRepos` in the config; `gh` must be authenticated.

## Maintenance

| Command | Purpose |
|---|---|
| `tik sync` | Incremental sync of tickets (`-f` full, `-p PROJ,PROJ`, `-c` changelogs only, `--users`, `--backfill`, `--stats`) |
| `tik embed [sync]` | Embedding stats; `sync` embeds all pending chunks (full backfill; first run downloads the ~325 MB model) |
| `tik triage [-a]` | Interactive bulk fill of type, sprint, points, team |
| `tik users` | List and edit the user directory |
| `tik doc view\|create\|edit\|search\|sync` | Confluence pages (`search -O` queries Confluence directly) |

## Configuration

`~/.config/tik/config.local.json` (see `config.example.json`). Required: `jiraBase`, `defaultProject`, `syncProjects`. Commands that need `myTeamId`, `myBoardId`, `inProgressTransitionId`, `reviewTransitionId` or a `customFields` entry say which key is missing. Credentials come from 1Password (`op`) and are cached in `/tmp/tik-creds-<uid>`; `--refresh-auth` reloads them.

## Pitfalls

- `view --full` does not exist; use `view -A` to see description, AC and TI.
- `comments` truncates long bodies unless `-f` or `--md` is given.
- `view` and `history` read the cache; `export` reads Jira. After a fresh install or schema change, `tik sync -f` backfills missing fields.
- `tik --ai` is the long form; `-ai` parses as `-a -i`.
