# Code review, 2026-10-08

Full review of `tik` (about 15k lines) by four parallel reviewers, each covering one slice:

- `main.ts` lines 1–3000
- `main.ts` from line 3000 to the end, plus `github.ts`
- `lib/` data and search: cache, api, credentials, config, search, hybrid-search, fuzzy, embeddings
- the rest of `lib/` (markdown, parser, timeline, history, export, confluence, util, terminal) and all of `ui/`

Every finding was checked against the code, and several were reproduced against the live cache or with `bun` scripts. Line numbers refer to commit `890b99b`.

Severity: **H** high, **M** medium, **L** low. The Status column is filled in after the fix pass (see the end of this file).

## High

| # | Where | Defect | Failure scenario |
|---|-------|--------|------------------|
| H1 | `lib/credentials.ts:18-24` | Bun ignores `Bun.write(..., { mode: 0o600 })`, so the credentials cache is created `0644`. | Any local user can read `/tmp/tik-creds-<uid>` and get the Jira email and API token. |
| H2 | `main.ts:2012-2017` | The incremental sync filter `updated >= "<date>"` is built from the UTC ISO string, but Jira reads JQL dates in the profile timezone. | A user in UTC-5 syncs at 14:00 local (19:00 UTC). The next sync asks for `updated >= "19:00"` local time, so tickets updated between 14:00 and 19:00 are never fetched. |
| H3 | `main.ts:3359-3423`, `4123-4183` vs `buildSearchOpts` `main.ts:1511-1640` | These flags are defined and counted in `hasFilters` but never read: `-r`, `--created`, `--resolved`, `--parent`, `--stale`, `--backlog`, `--my-created`, `--my-team`, `--current-sprint`, `--sprint`. | `tik search --backlog` and `tik search --stale 9999` return the unfiltered top tickets and exit 0. |
| H4 | `main.ts:3785`, `main.ts:2677`, `github.ts:504` | `--state` is lowercased, but `getCachedPRs` and `fetchMyPRs` compare it against `OPEN`, `MERGED` and `CLOSED`. | `tik pr --mine --state open` prints nothing. |
| H5 | `github.ts:133-136`, `github.ts:586-600` | `StatusContext` rollup entries have `state` rather than `status`/`conclusion`, so they always count as pending. | Repos with commit-status checks never show passing, and `tik review --gate-ci` always refuses. |
| H6 | `lib/hybrid-search.ts:97-105` | Results that come only from the vector search are re-filtered on project and status alone. | `tik search "payment" -a me -t Bug` returns semantically similar tickets with any assignee or type. |
| H7 | `main.ts:1529, 1662, 4209-4210, 4228` | The code reads `args["no-fuzzy"]`, `args["no-semantic"]` and `args["no-expand"]`, but citty parses `--no-x` as `x: false`. | `--no-fuzzy`, `--no-semantic` and `--no-expand` are no-ops. |
| H8 | `lib/cache.ts:999-1006` | `bm25()` sits in a correlated subquery with no `MATCH`, so every rank is 0. | `tik search "login" --no-fuzzy` returns matches in arbitrary order, and `LIMIT` cuts an arbitrary subset. |
| H9 | `lib/markdown.ts:125` | The italic regex `(\*\|_)…\1` matches inside words. | `my_var_name` becomes `my` + *var* + `name` on every create and edit. |
| H10 | `lib/markdown.ts:510-566`, `lib/confluence.ts:83/146` | The `tik doc` edit round trip (ADF → markdown → ADF) drops or flattens nodes it does not know. | One typo fix on a page removes TOC and Jira macros, status lozenges and dates, and turns mentions and inline cards into plain text. |
| H11 | `main.ts:823-902, 2038, 2113-2123, 4152, 5818`, and others | Decoration and progress text goes to stdout in `--json`/`--plain`, and an ambiguous key opens a readline prompt. | `tik view 123 --json` prints `Resolved 123 → …` before the JSON. An ambiguous key with `--json` hangs. `-F --json` prints sync progress first. |
| H12 | `lib/cache.ts:649-697`, `799` | The persisted MiniSearch index is only invalidated after a successful sync. | After `tik create` or `tik edit`, the default fuzzy search does not find the new ticket, or still matches its old summary. |

## Medium

| # | Where | Defect |
|---|-------|--------|
| M1 | `main.ts:3026-3033` | `--add-label` and `--remove-label` both assign `update.labels`, so the second overwrites the first. |
| M2 | `main.ts:4948-5091` vs `936-1030` | `tik create` copies `createTicketRecord` line for line. Both silently drop an invalid `--priority`, `--points` or `--sprint`, and a missing active sprint. |
| M3 | `main.ts:5071-5075, 3112-3116, 3164` | A transition that fails after a create or PUT throws a raw stack trace, and the new key is never printed, so a retry creates a duplicate. |
| M4 | `main.ts:3190-3193` | `search "text" --jql "…"` re-ranks the whole cache and ignores the JQL. |
| M5 | `main.ts:705-716` | The JSON branch of `formatIssues` ignores `--type`. |
| M6 | `main.ts:2214-2215` | With no QA users configured, `tik triage` builds `assignee in ()`, which is invalid JQL. |
| M7 | `main.ts:1530-1648` | `buildSearchOpts` silently accepts invalid input: NaN `--min-score` and `--points`, an invalid `--updated` is dropped, an unknown `--sort` falls back. |
| M8 | `lib/cache.ts:861-866` | An unresolved "me" drops the assignee filter, so the search returns everyone's tickets. |
| M9 | `main.ts:2679`, `lib/cache.ts:2146`; `main.ts:1424` | PR cache freshness uses `MAX(cached_at)` over all rows, so stale rows from other repos look fresh. `flow status` never refreshes an OPEN PR. |
| M10 | `lib/api.ts:231-246` | `jiraSearch` sends more than 100 ids to `/issue/bulkfetch`, which accepts at most 100. |
| M11 | `lib/api.ts:6-14` | `jiraGet` never checks `res.ok`. There is no 429 retry, so a rate limit aborts a full sync. |
| M12 | `lib/cache.ts:2071-2078`; `main.ts:5691-5693` | `doc search` passes raw text to FTS `MATCH` (a hyphen or colon throws), and the CQL query is not escaped. |
| M13 | `main.ts:332-338` | The fallback in `fetchRecentTicketChanges` swallows every error, so standup silently shrinks. |
| M14 | `lib/timeline.ts:562`, `ui/timeline.tsx:41`; `lib/timeline.ts:92/112` | Dates are parsed as UTC and read in local time, so they show one day early west of UTC. The bulk and fallback changelog paths store dates differently. |
| M15 | `ui/history.tsx:138-140` | `?? current` treats an original `null` as missing, so the Created block shows the current assignee, points or priority. |
| M16 | `lib/markdown.ts` (313, 416, 548, 163/219/274/294, 94, 666) | Nested lists are flattened, `hardBreak` does not round-trip, empty text nodes are emitted, block media placeholders end up inline, and one-line wiki `{code}…{code}` breaks the rest. |
| M17 | `main.ts:4594` | `link --is-duplicated-by` prints "is blocked by". |
| M18 | `main.ts:5447` | `tik sync -a` is dead: `includeDone` is always true. |
| M19 | `lib/timeline.ts:151-163` | `needsChangelogFetch` is true forever for Done tickets without testing or done phase dates, so every full sync re-downloads them. |

## Performance

| # | Where | Defect |
|---|-------|--------|
| P1 | `lib/cache.ts:126-131` | The `issues_au` FTS trigger fires on every UPDATE (changelog flags, timeline, embeddings) and re-tokenizes the full text. |
| P2 | `lib/cache.ts:1593-1632` | `getLocalSprintData` loads and parses about 134 MB of `raw` JSON twice per sprint or board view. |
| P3 | `github.ts:155-159, 345-359, 426-513` | Each PR lookup lists 300 PRs per repo, even for one ticket. `fetchMyPRs` filters by state client-side. |
| P4 | `main.ts:2829-2848` | `--ci`, `--reviews` and `--merge` call `fetchPRDetail` one PR at a time. |
| P5 | `main.ts:5765-5781` | `doc sync` fetches pages one at a time and exits 0 on failure. |
| P6 | `lib/embed-sync.ts:47-51` | Failed embedding batches are counted as synced, and retried with no backoff. |
| P7 | `main.ts:1950` | `getQaAccountIds()` is called inside a per-issue filter. |
| P8 | `lib/cache.ts:1945-1961` | `getIssuesNeedingEmbedding` hashes every issue on each sync, and applies `limit` before the hash filter. |

## Low and cleanup

| # | Where | Defect |
|---|-------|--------|
| L1 | `lib/cache.ts:314`, `lib/search.ts:83` | Rollback journal with no busy timeout on the second connection, so a search during a sync can hit `SQLITE_BUSY`. |
| L2 | `lib/terminal.ts:7-10`, `ui/table.tsx:29`, `ui/format.ts:270` | Width is measured in UTF-16 units: emoji are split, and ⚡ and CJK text misalign. |
| L3 | `lib/markdown.ts:598/603`, `117-146`, `552` | Subscript stripping eats `~~`. Bold links and mentions do not round-trip, and mentions come out as `@@Name`. |
| L4 | `lib/export.ts:55-60, 153` | Headings are demoted inside code fences, and `encodeURI` leaves `#` in file names. |
| L5 | `lib/cache.ts` | Dead exports: `initDb`, `getIdKeyMap`, `clearCache` (which is also wrong), `upsertUser`, `clearPRCache`. |
| L6 | `lib/history.ts:67` / `lib/timeline.ts:70`; `ui/timeline.tsx:205-305`; `ui/views.tsx:60/119`; `ui/table.tsx:17`; `lib/export.ts:73` | Duplicated changelog fetchers, near-identical timeline render blocks, column widths defined twice, unused `Table` props, and `extractSprints` re-implementing `parseSprint`. |
| L7 | `ui/views.tsx:335` | Typo: "✓ 12 ollapsed". |
| L8 | `main.ts:1107, 1301-1314, 2392, 2593` | A redundant `git switch`, a duplicate flow-state upsert, and the unused variables `authorPadded` and `ms`. |
| L9 | `main.ts:5642` | `$EDITOR` with arguments (`code -w`) fails to spawn. |
| L10 | `lib/api.ts:275-280` | Dead `errorMessages` branch, and `total` is always 0 with token pagination. |
| L11 | `main.ts:2733-2750` | Unmapped `--project` values are dropped silently, and `--repo`/`--org` overwrite earlier filters. |

## Fix status (2026-10-08, uncommitted)

**Fixed:** H1–H12; M1–M8, M10–M15, M17–M19; P1, P4, P6, P7; L1, L3, L4, L5, L7, L8, L9.

**Partly fixed:**
- M9: `flow status` now refreshes from GitHub. PR-cache freshness still uses `MAX(cached_at)` over all rows.
- M16: hard breaks inside list items, task items, table cells and headings still break the line on the way back.
- L6: only the duplicate changelog fetcher was removed.
- P3: `fetchMyPRs` filters by state in `gh`. Single-ticket lookups still list 300 PRs per repo.
- L10: the dead `errorMessages` branch was removed. `total` is still always 0.

**Open:** P2 (`getLocalSprintData` JSON parsing), P5 (`doc sync` sequential fetch), P8 (embedding hash scan), L2 (display width), L11 (`pr --project`/`--repo`/`--org` handling). The `sync --backfill`, `sync -c` and `embed sync` progress UIs still render in `--json`.

**Behavior changes worth knowing:**
- Schema version 14: the `issues_au` trigger now only fires on the FTS columns, and the DB uses WAL.
- `tik sync -a` was removed. Sync always includes done tickets, so tickets moving to Done are never missed.
- `tik sync --json` / `--plain` print `{fetched, changed}`.
- `-a` and `-r` accept a name as well as `me`. `--sort resolved|status` works as documented.
- `--json` write commands (`start`, `review`, `transition`, `open`, `edit`) print a JSON result. An ambiguous key errors with `ambiguous_key` instead of prompting.
- Invalid search values (`--updated`, `--points`, `--sort`, `-m`, `--min-score`, `--stale`, `--sprint`) and invalid create values exit 1.
- `adfToMarkdown(adf, { preserveUnknown: true })` encodes unknown ADF nodes as `tikadf:` placeholders. Only `tik doc edit` uses it.
