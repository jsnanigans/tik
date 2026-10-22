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

## Phase 3: readable inline nodes (2026-10-21)

`just verify-roundtrip` runs in 21 s. Report: `reports/roundtrip-2026-10-21-phase3.json`. Exact, idempotence, schema-valid and crashes did not move at any step (Jira 100% / 100% / 100% / 0; Confluence 100% / 100% / 92% (the originals' own rate) / 0; comments 100% / 100% / 100% / 0). The phase 2 property checks are unchanged (all 100%).

Readable rate after each step (Jira 17,985 fields, Confluence 300, comments 1,016):

| Step | Jira | Confluence | Comments |
|---|---|---|---|
| Phase 1 | 65.13% | 4.67% | 53.64% |
| inlineCard as `<url>` | 78.47% | 5.00% | 57.09% |
| emoji | 79.81% | 5.33% | 62.30% |
| mention | 81.01% | 5.33% | 75.49% |
| textColor, underline, backgroundColor spans | 82.55% | 7.00% | 75.79% |
| blockCard, embedCard, status | 82.84% | 7.00% | 76.08% |
| date | 83.03% | 11.00% | 76.08% |

- Below the ~90% estimate. Every inline construct in scope is now readable; the rest of the Jira gap is what phases 4 and 5 replace, counted in fields: media placeholders 2,183, tables 619 (cells 153 and 134 more), task items 239, panels 70, headings with extra attributes 45 (`heading adf`, not in the plan), expand 14, other marks on spans (annotation) 5. Media alone is 12.1%.
- inlineCard as an autolink is reliable, so `:card[url]` is not needed for inline cards. `<url>` is written for a card whose only attribute is a `url` that is a valid autolink (scheme, no whitespace, `<` or `>`); the reader takes a link whose source starts with `<` and whose text equals its url. `[url](url)` stays a link mark. Plain URL text never turns into a link because the reader has GFM autolink literals off.
- A card with other attributes or a url that is not an autolink uses the generic rule.
- Dedicated spellings (`DEDICATED` in `lib/adf-codec.ts`, a small table of node type, directive name, label attribute and typed attributes): `:emoji[:cross_mark:]{_id=… text=…}`, `:mention[@Jane Doe]{_id=…}`, `:status[IN QA]{color=blue style=bold}`, `::card[url]{appearance=block layout=center}` and `::card[url]{appearance=embed width=100 originalWidth=…}`. A node that has an attribute outside the table, an attribute of the wrong type or a multi-line value falls back to the generic rule, and a directive with an `adf` attribute always reads as generic.
- `:date[2026-11-03]`: the label is the UTC day; `timestamp` is written only when it is not that day's midnight. If the label's day differs from `timestamp`, the label wins. A label that is not `YYYY-MM-DD` is text.
- Spans: one `:span[x]{color=#ff5630 underline bg=#fdd0ec}` carries textColor, underline and backgroundColor; any other mark on the same text stays in the generic `marks='[…]'` attribute of the same span.
- The writer uses `preferUnquoted`, so short values are written bare (`_id=557058:ab`); `&` in attribute values and in leaf labels is written as a character reference. `accessLevel: ""` is not written (it is the default; `DEFAULT_ATTRS` is now exported from `lib/adf-reconcile.ts`).
- The placeholder writer became a generic `raw` mdast node (also used for `<url>`).
- Checked beyond the corpus with a scratch loop (not committed): 7,500 documents with hostile strings (`]`, `&amp;`, quotes, backslashes, newlines, empty values, `:`, `<>`, `{}`) in every dedicated attribute and label all round-trip exactly.
- `bun test`: 62 tests (5 new: inline atoms, spans, cards, date label wins, prose that resembles a directive; fuzz pieces extended). `just check` passes.

## Phase 4: readable tables (2026-10-21)

`just verify-roundtrip` runs in 22 s. Report: `reports/roundtrip-2026-10-21-phase4.json` (it now also lists `genericUses`: fields per generic directive, placeholders counted as `placeholder`). Exact, idempotence, schema-valid and crashes did not move (Jira 100% / 100% / 100% / 0; Confluence 100% / 100% / 92% (the originals' own rate) / 0; comments 100% / 100% / 100% / 0). The phase 2 property checks are unchanged (all 100%).

| Source | Fields | Readable (phase 3) | Readable (phase 4) |
|---|---|---|---|
| Jira cache | 17,985 | 83.03% | 86.08% |
| Confluence sample | 300 | 11.00% | 16.33% |
| Comment sample | 1,016 | 76.08% | 81.20% |

- Exit met: no table uses the generic rule in any of the three sources (`genericUses` has no `table`, `tableRow`, `tableCell` or `tableHeader` entry). Jira's 826 tables: 391 as GFM tables (128 of them in a `:::table{…}` wrapper), 435 in the directive form.
- Remaining Jira generic uses, in fields: media placeholders 2,183, taskItem 239, panel 70, heading 45, expand 14, span 5. Phase 5 covers them; the 45 headings with extra attributes and the 5 spans (annotation marks) are not named in the plan's phase 5 list.
- Spelling: `:::table{layout=wide width=760 numbered colwidths=120,300}` around a GFM table; the directive form is `:::::table{…}` / `::::row` / `:::cell{header colspan=2 rowspan=2 bg=#e3fcef valign=top colwidth=100,200}`. Table attributes: `layout`, `width`, `numbered` (`isNumberColumnEnabled`), `displayMode`. `valign` and `displayMode` appear only in the Confluence sample and cost one spec entry each.
- A GFM table is written only when its text reads back equivalent. This one guard covers pipes, hard breaks, block cells, cell attributes and every other case the plan lists for the directive form. Requirements for trying it: a header row of `tableHeader` cells, body rows of `tableCell`, one paragraph per cell. The widths of the first row are `colwidths`.
- `table` is no longer in the attribute-less generic node list: a `:::table` without `adf` is read by the table spelling, or kept as text when its attributes or children do not fit (rows only, cells in rows). Old `:::::table` / `::::tableRow` / `:::tableCell` markdown still reads.
- Reconcile: a paired node keeps the original's attributes when they are equivalent (this restores `localId`, `layout: default` and the like on a table, row or cell whose cell text was edited), otherwise only its `localId`. It used to lose a table's `localId` when the edited table had no attributes. Dry-run check on BACK-6044 (live read, nothing written): editing one cell of a wrapped table gives `block 5.4.2.1 paragraph changed`, one diff line, guard quiet.
- `bun test`: 65 tests (3 table dialect rows replace the one generic table row; 1 reconcile test; table pieces added to the fuzz). A separate 200,000-input fuzz with table pieces (not committed) found no throws and no instability. Text that holds a backslash before a newline, kept as text after an unknown directive, is unstable; it predates this phase (the same happens with `:::note`) and is not in the corpus.
- `just check` passes.

## Phase 5: the rest of Jira (2026-10-21)

`just verify-roundtrip` runs in 23 s. Report: `reports/roundtrip-2026-10-21-phase5.json`. Exact, idempotence, schema-valid and crashes did not move (Jira 100% / 100% / 100% / 0; Confluence 100% / 100% / 92% (the originals' own rate) / 0; comments 100% / 100% / 100% / 0). The phase 2 property checks are unchanged (all 100%).

| Source | Fields | Readable (phase 4) | Readable (phase 5) |
|---|---|---|---|
| Jira cache | 17,985 | 86.08% | 99.98% |
| Confluence sample | 300 | 16.33% | 32.33% |
| Comment sample | 1,016 | 81.20% | 100% |

- Exit: Jira readable rate 99.98% (>= 99%) is met, and the one remaining generic use, in Jira fields, is media with a `link` mark: 3 fields (PROD-820), fewer than 5. Both sub-criteria are met after the review fix below.
- Spellings:
  - Task list: `- [ ] text` / `- [x] text`. An item must have inline content only and the `state` attribute; anything else uses the generic rule.
  - `:::panel{type=info}` (also `color`, `icon`, `iconId`, `iconText`, from the Confluence sample), `:::expand{title=…}`, `:::nestedExpand{title=…}`. A panel needs `type`; an expand may have no attributes.
  - Sub and superscript: `:span[2]{sup}`, `:span[i]{sub}`.
  - Media: `::media[alt]{_id=… type=file collection=… originalWidth=… originalHeight=… layout=center width=… widthType=…}` is a mediaSingle holding one media (`layout` required to use it, else the placeholder). Inside `:::mediaGroup` the same leaf is the media itself. `:media[alt]{…}` is a mediaInline. The media's own `width` and `height` are written `originalWidth` and `originalHeight`, as on embed cards, because `width` is the mediaSingle's. `tikmedia:` and `tikadf:` are still read.
- Deviations from the plan:
  - `border` is spelled on the media (`border=#… borderSize=2`), not as `:span[x]{border=…}`: ADF allows the border mark only on media and mediaInline (22 Jira fields, all on media).
  - Empty headings (45 fields, `heading` with no content, not named in the plan) are written `#`; they were the "heading" generic use of phase 4.
  - Empty string attribute values are now allowed in the typed attributes (`collection=""` is the corpus's value on 2,100 media), written as a bare `collection`.
- Leaf directive labels (`::card[url]`, `::media[alt]`) were not escaped by the writer, because a leaf label is not written inside a paragraph, so `Refine _fastpass UII_.png` read back as emphasis. A small `label` node now writes them with phrasing escapes (this also fixes cards whose url starts or ends with `_`).
- New task and decision ids are derived from a counter and the text (sha1 formatted as a UUID), so the same markdown always produces the same ids; reconcile still restores the original ids.
- Scratch check (not committed): 20,000 documents with hostile strings in every media, panel, expand, sub/sup and task attribute and label all round-trip exactly.
- `bun test`: 70 tests (5 new dialect rows, 1 reader test for placeholders and derived ids, fuzz pieces extended). `just check` passes. `create --dry-run` with a task list, a panel and `::media` produces the expected ADF.
- The harness writes `reports/roundtrip-<date>.json`, which overwrote the phase 0 baseline of the same name when run on the same day; the baseline was restored from git and the phase 5 report renamed.

### Phase 5 review fix (2026-10-21)

- The review found 6 fields with empty task items (and so the generic form), over the limit of 5. Two spellings fix it: an empty item is written `- [ ] :empty` (GFM has no empty checkbox item; the reader treats a paragraph that is only `:empty` as no content), and a `taskList` nested in a `taskList` is a list under the item before it (`- [x] a\n  - [x] b`). A nested list after anything but a task item (two in a row) stays generic, because markdown would merge them.
- Jira readable 99.98%; generic uses: placeholder 3 (PROD-820). Exact, idempotent, schema-valid 100% on Jira; Confluence 100% / 100% / 92% (originals 92%); comments 100%; crashes 0; property checks all 100%. Confluence readable 33%.
- The harness report is now `reports/roundtrip-<date>-<time>.json`, so a run no longer overwrites the phase 0 baseline.
- `bun test`: 71 tests (1 new row for empty and nested tasks). `just check` passes.

## Phase 6: comments and Confluence (2026-10-21)

`just verify-roundtrip` runs in 21 s. Report: `reports/roundtrip-2026-10-21-phase6.json`. The harness now also reports no-op identity per source (render, parse, reconcile: byte-identical to the original).

| Source | Fields | Exact | Idempotent | Schema-valid | No-op identity | Crashes | Readable (phase 5) | Readable (phase 6) |
|---|---|---|---|---|---|---|---|---|
| Jira cache | 17,985 | 100% | 100% | 100% | 100% | 0 | 99.98% | 99.98% |
| Confluence sample | 300 | 100% | 100% | 92% (originals 92%) | 100% | 0 | 32.33% | 71.67% |
| Comment sample | 1,016 | 100% | 100% | 100% | 100% | 0 | 100% | 100% |

The phase 2 property checks are unchanged (all 100%).

- Exit met: exact 100% on the Confluence and comment samples (>= 99.9%, no misses to name); comment no-op identity 100% (1,016/1,016).
- Edit flow for comments: `comment KEY --edit ID` reads the live comment, reconciles, applies the loss guard (`--force`), saves a backup (`backups/KEY/comment-ID-TIMESTAMP.json`), re-checks `updated`, PUTs, reads back and warns. `--dry-run` prints the diff and guard result; it is refused without `--edit` or with `--attach` (an upload is a write). `--edit ID --edit-md` prints the comment's exact markdown (the plan does not name this flag; without it there is no exact starting point for a comment edit). Comment creation is unchanged.
- `tik doc edit ID` now writes `adfToEditMarkdown` to the editor file, reconciles the result with the live ADF, and goes through the loss guard, backup (`backups/confluence-ID/body-TIMESTAMP.json`), a version re-check before the PUT, and a read-back warning. It takes `--dry-run` and `--force`. `getConfluencePageAdf` returns the raw ADF next to the page; `updateConfluencePage` takes an ADF. `doc create` still uses `markdownToAdf`; it has no original to guard or back up. `preserveUnknown` has no caller now; phase 7 deletes it.
- Dedicated spellings, by sample frequency (fields in the Confluence sample; generic before, readable after):
  - Annotation (inline comments, 34): `:span[x]{annotation=ID}`; overlapping comments are a comma list, `annotation=ID1,ID2`. It is written only when every annotation on the text is an inline comment with a plain id without commas or spaces, otherwise all stay in `marks`. Real samples have overlapping comments (9 fields).
  - Layout (55): `::::layout` holding `:::column{width=33.33 valign=…}`.
  - Extensions (72 extension, 64 bodiedExtension, 7 inlineExtension): `::macro{type=… key=… layout=… text=… params='{json}'}`, `:::macro{…}` with blocks for a bodiedExtension, `:macro{…}` inline. `type` and `key` are required, `params` is the parameters object as JSON.
  - Block marks (alignment 23, indentation 9, breakout 48): `:::marks{align=center indent=2 breakout=wide breakoutWidth=1800}`; other marks stay in `marks='[…]'` of the same wrapper. The older `adf='[…]'` spelling is still read.
  - decisionList (0 in the samples, named in the plan): `:::decisions` holding a bullet list, `- :empty` for an empty item; only `DECIDED` items use it. Covered by a dialect row and a 20,000-document scratch loop, not by the corpus.
- Reconcile now recurses into `bodiedExtension`, `multiBodiedExtension` and `extensionFrame`, so editing a paragraph inside a Page Properties macro keeps the other children and their ids. Dry-run check on page 1402273794 (live read, nothing written): changing one phrase that occurs in annotated table cells shows only those paragraphs, annotations intact, guard quiet; a no-op is "No changes detected"; replacing the page with one line lists the lost constructs (heading, table, `mark:annotation`, `mark:breakout`, …).
- Dry-run check on comment BACK-6383/65843 (table, heading, date, code): a no-op reports unchanged, a one-word edit gives one heading diff and a quiet guard, a one-line replacement lists the lost constructs, and without `--force` the write is refused. No backups directory was created.
- Remaining generic uses in the Confluence sample, in fields, not in the plan's list for this phase: `placeholder` nodes 58 (template pages) and media with a caption 8 (placeholder form), blockCard with a `datasource` 7, taskItem with hard breaks 5, annotation on a non-text node (a status) 5 and the `fragment` and `fontSize` block marks 5 (the `marks` rows), multiBodiedExtension 1, bodiedSyncBlock 1. Jira: media with a `link` mark 3 (PROD-820).
- Scratch check (not committed): 20,000 documents with hostile strings in every macro, block mark, annotation, layout and decision attribute and label all round-trip exactly. Two identical annotation marks on one text merge on read, as identical marks always did.
- `bun test`: 77 tests (6 new dialect rows, 1 reconcile test; fuzz pieces extended). `just check` passes.

## Phase 7: cleanup and docs (2026-10-21)

`just verify-roundtrip` runs in 21 s. Report: `reports/roundtrip-2026-10-21-phase7.json`. Numbers are unchanged from phase 6 (no codec change in this phase).

| Source | Fields | Exact | Idempotent | Schema-valid | No-op identity | Crashes | Readable |
|---|---|---|---|---|---|---|---|
| Jira cache | 17,985 | 100% | 100% | 100% | 100% | 0 | 99.98% |
| Confluence sample | 300 | 100% | 100% | 92% (originals 92%) | 100% | 0 | 71.67% |
| Comment sample | 1,016 | 100% | 100% | 100% | 100% | 0 | 100% |

Property checks (sample of 500): no-op identity 500/500, one sentence edited 408/408, guard quiet 408/408, delete 224/224, insert 224/224, guard fires on a dropped table 47/47 and panel 17/17 (all 100%).

- Exit: this phase has no exit criteria of its own; the codec numbers did not move, `just check` passes and `bun test` is 78 tests.
- Deleted: `preserveUnknown` and the `tikadf:` writer (`adfToMarkdown` takes no options, `encodePlaceholder` writes only `tikmedia:`, and its label code lost the status, date, macro and expand cases). The reader still decodes `tikadf:` in old markdown. The old parser was already gone in phase 1; `eval/roundtrip.ts` stopped counting `tikadf:` as a placeholder.
- `tik restore KEY [--field F] [--at TS] [--dry-run] [--force]`: `findFieldBackup` in `lib/cache.ts` takes the newest backup of the ticket (optionally of one field, and among those whose file-name timestamp starts with `--at`). The command renders the backup's ADF with `adfToEditMarkdown`, prints the diff and loss guard, and writes through `cmdEdit` (description, AC, TI) or `cmdEditComment` (`comment-ID`), so the guard, a new backup, the `updated` re-check and the read-back all apply. Confluence page backups are not restorable with it; the docs say to pass the markdown to `tik doc edit`.
  - Checked with `--dry-run` only on BACK-6342 (live read, nothing written) against a hand-made backup in `~/.cache/tik/backups`, removed afterwards: the diff and guard list print, `--field` with no backup and an `--at` with no match give `no_backup`, `--json` carries the dry-run payload. The write path was not run against Jira.
  - `readFileArg` no longer throws on a long single-line value that contains `/` (`Bun.file().exists()` raised ENAMETOOLONG); restore passes markdown as a value, so it needed that.
- Docs: `AGENTS.md` has the dialect table and the restore description; `README.md` mentions backups and restore; the local skill (`claude_skill/tik/`, git-ignored) has the same table, a `restore` section and a command row.
- Item 4 (single codec) skipped as instructed.
- `bun test`: 78 tests (1 new, `lib/backup.test.ts`). `just check` passes.

# Progress log: terminal renderer (2026-10-22)

Branch `feature/terminal-renderer`, one commit per phase. `just verify-render` runs the corpus (about 50 s); reports `reports/render-2026-10-22-phase{1,3,5}.json`. `bun test` is 159 tests, `just check` passes, `just build` works (binary 114.7 MB to 112.5 MB after dropping `marked`, `marked-terminal` and their `cli-highlight` tree).

| Source | Fields | Throws | Over width 100 / 40 | Leaks | ESC in plain | p50 | p95 |
|---|---|---|---|---|---|---|---|
| Jira cache | 18,024 | 0 | 0 / 0 | 0 | 0 | 0.20 ms | 2.2 ms |
| Confluence sample | 300 | 0 | 0 / 0 | 0 | 0 | 3.8 ms | 20 ms |
| Comment sample | 1,016 | 0 | 0 / 0 | 0 | 0 | 0.09 ms | 3.2 ms |

Fuzz (3,000 random markdown documents at widths 20, 40 and 100): 0 throws, 0 lines over width. Plain output is repeatable on 1,900/1,900 fields.

- Speed: the 5 ms p95 target holds for Jira fields and comments. Confluence pages are about 10x larger (median 15 KB of ADF); their time is proportional to size (`wrap-ansi` is most of it, `adfToMdast` table round trips the rest). A line that already fits skips `wrap-ansi`, which cut the Confluence total by 40%.
- Phase 0: baseline of the old display in `reports/render-baseline/`. The Ghostty + tmux spike is **not done** (needs your terminal), so direct placement is the only image mode and Unicode placeholders are not built.
- Phase 1: `adfToMdast`, `markdownToMdast`, `directiveInfo` in the codec (tested against every spec table); `term-style.ts` (depth, theme, contrast clamp), `term-render.ts`, `term-table.ts`. Text from tickets has control characters removed, so ticket content cannot inject escape sequences or end a hyperlink early.
- Phase 2: `view`, `comments`, `history` use the renderer; `renderMarkdown` keeps its name and is built on it. `grep marked\|glow` over `lib ui main.ts package.json` is empty.
- Phase 3: tables (colspan, rowspan, `colwidth` proportions, numbered column, labelled-row fallback), layouts (side by side from 100 columns), expands, macros, marks. Generic task and decision lists, block cards and Confluence `placeholder` nodes get a real rendering (they were the most common `‹name›` fallbacks in the corpus).
- Phase 4: `kitty.ts`, `term-media.ts`, `--images` / `--no-images`, `terminal.*` settings. Run through a pseudo-terminal with `KITTY_WINDOW_ID=1` on BACK-6017: the 608 KB PNG was fetched, cached in `~/.cache/tik/media/`, and printed as 4 KB chunks wrapped for tmux (this shell is inside tmux with passthrough on) followed by 19 reserved rows. Not looked at in a real terminal.

Differences from the plan:

- ADF is read next to `IssueData` (`parseIssueAdf`, `parseCommentBodies`) instead of added to it, because several commands print `IssueData` / `CommentData` as `--json`.
- Wrapping trims (`wrap-ansi` `trim: true`); with trim off, every wrapped line began with a stray space and broke hanging indents.
- Glyphs: `ℹ ✔ ⚠ ✖ ☑ ▪ ↗ ▶` are counted as two cells by `string-width` but drawn as one, which misaligns indents, so the renderer uses `ⓘ ✓ ▲ ✘ ☒ ‣ → ►`.
- No syntax highlighting (`cli-highlight` dropped with `marked-terminal`; the plan allowed it).
- `doc view` renders the cached markdown: the page cache keeps no ADF, so Confluence layouts, panels and macros show only as far as the old markdown kept them. Caching the ADF (a `body_adf` column) is the follow-up.
- `comments` prints media placeholders with sizes but no inline images: a direct-placement sequence inside Ink corrupts its layout. The 15-line preview counts lines, which is correct while there are no image blocks.
- "Idempotence of the plain output" is checked as repeatability; re-reading the plain text as markdown cannot be stable because it drops indentation.

Open, for you:

1. Look at `tik view PMP-1838 -A`, `tik comments` and `tik history` in Ghostty (phase 2 and 3 acceptance).
2. Run the Ghostty + tmux spike (2x2 PNG, direct placement and Unicode placeholders; scroll, split, detach). Direct placement under tmux does not track scrolling; if placeholders work, they are the follow-up and would also allow images in `comments`.
3. `tik view` on a ticket with PNGs, one over 2 MB and a `.mov` (phase 4 acceptance).
4. `just install` not run.
