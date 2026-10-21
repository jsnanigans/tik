# Progress log: search embeddings

All steps done, uncommitted. `just check` green; verified with the compiled binary (`semantic: true`; model cache removed gives `semantic: false` with the dim hint).

- Locked TUNING (`rrfK 20, keywordWeight 1, vectorWeight 1, minSimilarity 0.4`); chunk bonus removed; 256 dims kept. Results table in the plan.
- Open: Brendan to review `eval/queries.json` expected keys (weak: BACK-5874, "appointments not getting cancelled", BACK-4838). `just install` not run.

Suggested commits, in order:
1. `build(cli): bundle onnxruntime in compiled binary` (build.ts, justfile, package.json, bun.lock)
2. `feat(search): relax keyword matching to OR`
3. `feat(search): embed in-process with EmbeddingGemma` (lib/embeddings.ts, lib/index.ts)
4. `feat(search): store and sync per-chunk embeddings` (cache.ts, embed-sync.ts, main.ts embed)
5. `feat(search): tune hybrid ranking and report semantic state` (hybrid-search.ts, main.ts search)
6. `docs(search): document EmbeddingGemma embeddings`

# Progress log: lossless ADF codec

## Phase 0: measurement (baseline, current codec, 2026-10-21)

`just verify-roundtrip` runs in 1.4 s. Report: `reports/roundtrip-2026-10-21.json` (`--preserve-unknown` variant: `reports/roundtrip-2026-10-21-preserve-unknown.json`). Samples fetched read-only by `eval/fetch-samples.ts`: 300 Confluence pages (no `syncSpaces` configured, so the latest pages across all spaces) and 1,016 comments from the 300 most recently updated cached issues.

| Source (default mode) | Fields | Exact | Readable | Idempotent | Schema-valid | Crashes |
|---|---|---|---|---|---|---|
| Jira cache | 17,984 | 54.45% | 51.32% | 99.62% | 99.96% (originals 100%) | 6 |
| Confluence sample | 300 | 5.33% | 4.67% | 82.00% | 99.00% (originals 92%) | 0 |
| Comment sample | 1,016 | 55.81% | 53.25% | 97.44% | 100% (originals 100%) | 0 |

- `--preserve-unknown` exact: Jira 59.53%, Confluence 22.67%, comments 73.13%.
- Readable = exact and no `tikmedia:`/`tikadf:` placeholder in the markdown. Schema-valid = produced ADF passes the vendored `eval/adf-schema-full.json` (`@atlaskit/adf-schema` 57.7.21). Idempotent = a second round trip equals the first.
- Crashes (all `parseList` null destructure): PROD-1072, PROD-1050, PMP-1265, PROD-50, FEWEB-1091 and one more; the report lists the first 5.
- Top Jira differences, in fields: inlineCard 3,531; hardBreak 1,722; emoji 547; mention 402; textColor 302. The report has the full list with example keys.
- Against requirements §3 (51.5% exact, 56.2% with `preserveUnknown`, 6 crashes): the harness applies the §5 defaults rule (absent attribute equals default, so `orderedList order=1` and default table attrs are not losses). With that rule off the same run gives 9,271 exact (51.55%); the remaining gap to 9,257 is the trailing-empty-paragraph rule. Crashes match exactly.
- Golden fixtures for R20: `lib/fixtures/{ticket-pmp-1838,agents-examples,edge-cases}.json` (`name`, `markdown`, `adf`; `localId` stripped because the old parser generates random ones). They record today's output, including its quirks (snake_case split into text runs, ordered start dropped, tables without a separator get a header row).
- `lib/adf-reconcile.ts`: `canonicalize`, `equivalent`. `eval/` is git-ignored, so its files were added with `git add -f`. New dev dependency: `ajv@6` (draft-04 schema support).
- `just check` passes.

## Phase 1: exact codec core (2026-10-21)

`just verify-roundtrip` (now measuring `adfToEditMarkdown` then `markdownToAdf`) runs in 19 s. Report: `reports/roundtrip-2026-10-21-phase1.json`; the phase 0 baseline stays in `reports/roundtrip-2026-10-21.json`.

| Source | Fields | Exact | Readable | Idempotent | Schema-valid | Crashes |
|---|---|---|---|---|---|---|
| Jira cache | 17,985 | 100% (baseline 54.45%) | 65.13% (51.32%) | 100% (99.62%) | 100% (99.96%) | 0 (6) |
| Confluence sample | 300 | 100% (5.33%) | 4.67% (4.67%) | 100% (82.00%) | 92% (99.00%) | 0 |
| Comment sample | 1,016 | 100% (55.81%) | 53.64% (53.25%) | 100% (97.44%) | 100% (100%) | 0 |

- No misses to name. The 5 crashing fields in the baseline report (PROD-1072 and others) round-trip exactly.
- Readable = exact and no `tikmedia:`/`tikadf:` placeholder and no generic directive (`adf=` or `marks=` attributes). Jira 65%, below the 70% estimate: media placeholders count against it and phase 5 replaces them.
- Confluence schema-valid 92% equals the originals' 92%: the vendored schema predates `multiBodiedExtension` and `extensionFrame`, so those originals fail validation before any conversion.
- `bun test`: 51 tests (dialect rows, reader rules, golden fixtures, fuzz). Separate fuzz runs over hundreds of thousands of random strings (not committed) found no throws and no instability except text that spells a valid directive, such as `\[:a{adf='{}'}`.
- `just check` passes. `just build` produces a working binary (`./tik create ... --dry-run` goes through the new reader; 71 packages added, binary 109 MB).

Decisions and deliberate differences:
- Golden fixtures: 5 of the 36 differ from the old reader, each listed with a reason in `lib/fixtures/edge-cases.json` (`deviation`):
  - A newline inside a paragraph stays in the text (195 corpus fields have one), so a hard-wrapped paragraph keeps its newlines where the old reader joined them with a space.
  - The ordered-list start number is kept.
  - A table without a delimiter row is a paragraph.
  - Bold inside a link nests instead of staying literal.
  - Newlines in a quote are no longer hard breaks.
- The old parser is deleted now (nothing used it after the switch) instead of in phase 7. `preserveUnknown` and the `tikadf:` writer stay until phases 6 and 7.
- The reader turns off GFM autolink literals, indented code and raw HTML. The autolink literals rewrite plain text such as `a@b.co` into links, even through a backslash escape, so exactness needs them off. Angle autolinks `<https://…>` still read as links.
- `localId` is left out of the edit markdown (the equivalence ignores it); reconcile restores it in phase 2. New task items get a random `localId` as before.
- codeBlock attributes other than a plain language go in the info string as JSON (``` ```ts {"wrap":true} ```), not `{wrap=true}`; a hard break at the end of a block or in a heading is written `:hardBreak[]`.
- Container directives with inline content (task items) use `:::taskItem{inline adf='…'}` with the text as the body, because a leaf label cannot hold a hard break.
- A directive without `adf` attributes is only accepted for node types that can have none (`paragraph`, `tableRow`, …), so prose like `:status` stays text.

## Phase 2: safe editing (2026-10-21)

`just verify-roundtrip` runs in 21 s. Report: `reports/roundtrip-2026-10-21-phase2.json` (codec numbers unchanged from phase 1: exact 100% on Jira 17,985, Confluence 300 and comments 1,016; idempotent 100%; crashes 0; schema-valid 100% / 92% / 100%, the 92% being the originals' own rate). The harness now also runs the property checks on a sample of 500 fields (coverage-greedy over every construct, filled with an even spread, drawn from Jira, Confluence and comments):

| Property | Passed |
|---|---|
| No-op identity (render, no edit, reconcile: byte-identical to the original) | 500/500 (100%) |
| One sentence edited: only that block differs | 408/408 (100%) |
| Loss guard quiet after that edit | 408/408 (100%) |
| Block deleted: neighbours byte-identical | 224/224 (100%) |
| Block inserted: neighbours byte-identical | 224/224 (100%) |
| Guard fires when a table is dropped | 47/47 (100%) |
| Guard fires when a panel is dropped | 17/17 (100%) |

- Sanity check of the checks: with `reconcile` replaced by "return the edited document", no-op identity falls to 70.4% and the edit, delete and insert properties to 55-72%.
- Delete and insert skip positions where removing a block would put two lists or quotes of the same type next to each other, which markdown merges into one.
- Acceptance (dry-run only, live read of the seven tickets, nothing written): the phrase edits from `13 Ticket Orchestration.md` (stale FEWEB-2801 references) on PROD-1378 and BACK-6342 through `edit -d` on the `--edit-md` markdown, and on BACK-6343, 6347, 6379, 6380 and 6381 through `--replace`. Each result differs from the live description in exactly the blocks that hold an edited phrase (PROD-1378: block 5 of 19; BACK-6342: 4 and 7 of 38; BACK-6343: 5 and 21 of 25; BACK-6347: 6 of 9; BACK-6379: 4 of 16; BACK-6380: 7 of 25; BACK-6381: 7 of 21) and inside those only the one paragraph or list item changes; the loss guard is quiet on all. A no-op `edit -d` of the unedited `--edit-md` output reports "No changes" on PROD-1378 and BACK-6342.
- Guard check on a live ticket: replacing BACK-6342's description with one line shows `Loss guard: would refuse without --force` listing heading, list, rule, table and mark types.
- `bun test`: 57 tests (6 new for reconcile, loss guard and `replaceInText`). `just check` passes.
- Pending for Brendan (not done by design): the supervised real edit on a throwaway ticket, checked in Jira's editor. The write path (backup, `updated` re-check, PUT, re-read warning) and the non-dry-run loss-guard refusal were therefore not exercised against Jira; the backup helper was run against a temporary HOME.

Decisions:
- `reconcile` aligns blocks with an LCS over canonical forms, recurses into same-type containers (lists, items, quotes, panels, expands, tables, rows, cells, task and decision lists, layouts) by position inside each changed gap, and keeps the original's trailing empty paragraphs. A paired node takes the original's `localId`.
- The loss guard compares presence, not counts: it fires when a node type, mark type or attribute name occurs in the original and nowhere in the result. Dropping the only panel or table fires; dropping one of two does not (the dry-run diff shows it).
- `--replace "old=>new"` splits on the first `=>`, searches description, AC and TI together and must match exactly once across them (the plan's "per field" is read as per rich-text field of the ticket, not a per-field flag); a match that spans text runs aborts. It cannot be combined with `-d`, `--ac` or `--ti`.
- `view --edit-md` needs exactly one of `-d`, `--ac`, `--ti` and prints the live field with no header, so the output can be edited and passed back to `edit -d FILE`.
- Dry-run does not abort on the guard; it reports it. A real write aborts unless `--force`.
- Backups are `~/.cache/tik/backups/KEY/FIELD-TIMESTAMP.json` (`key`, `field`, `savedAt`, raw `adf`, edit `markdown`), written with exclusive create; a field without existing content has nothing to back up.
- Flag docs (AGENTS.md, README.md, local skill) got the short version now, as CLAUDE.md requires; the full dialect reference stays in phase 7.
