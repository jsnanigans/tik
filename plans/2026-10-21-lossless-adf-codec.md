# Plan: lossless markdown ↔ ADF round trip

## Goal

Every Jira and Confluence rich-text field survives ADF → markdown → ADF with nothing lost: text, marks, colors, attributes, tables, ids. Editing a field through `tik` changes only what the user changed.

Success means (measured by the harness in phase 0, equivalence as defined in `requirements.md` §5):

- **Exact rate** 100% on the Jira corpus, ≥ 99.9% on the Confluence and comment samples, with every remaining case named.
- **Idempotence** 100%: a second round trip changes nothing.
- **Crashes** 0. The reader never throws.
- **No-op identity** 100%: an edit that changes nothing sends nothing.
- **Readable rate** (fields that need no generic fallback, defined below) rising phase by phase. This is the quality metric once exactness is reached.

The order is **exact first, readable second**. Phase 1 makes every construct round-trip, including rare ones, through one generic syntax. Later phases replace that generic syntax with nicer syntax, most common construct first.

`requirements.md` stays the source for requirements (R1–R22). This plan supersedes its §2 claim that readable and exact are a contradiction, and the open questions in §9 about placeholders and annotation syntax.

## Current state

- `lib/markdown.ts` (762 lines) has a hand-written line parser (`markdownToAdf`) and writer (`adfToMarkdown`). Opaque nodes become base64 image placeholders (`tikadf:`, `tikmedia:`), and only when `preserveUnknown` is set.
- **Call sites:**
  - Writes: `markdownToAdf` in `create` (`main.ts:954-986`), `edit` (`main.ts:3016-3101`), `comment` (`main.ts:4552`) and `lib/confluence.ts:115,150`.
  - Display: `adfToMarkdown` in `lib/parser.ts:136-240` (cache and display) and `lib/confluence.ts:87,171`.
  - `preserveUnknown`: only used by `tik doc` edit (`main.ts:5658`).
- **Baseline** (requirements §3): 51.5% exact, 6 crashes, and no edit path that preserves untouched content.

## Corpus usage (2026-10-21, 17,984 ADF fields in the cache)

Number of fields that contain each construct. This sets the order of the readability work.

| Construct | Fields | Construct | Fields |
|---|---|---|---|
| paragraph / text | 17,472 | table attrs (layout, number column) | 619 |
| list item / bullet list | 7,809 / 6,670 | emoji | 548 |
| `code` mark | 5,167 | tableHeader | 461 |
| `strong` mark | 3,665 | mention | 402 |
| inlineCard | 3,535 | textColor | 303 |
| `link` mark | 2,851 | rule | 251 |
| hardBreak | 2,605 | taskList | 239 |
| media / mediaSingle | 2,175 / 2,097 | blockquote | 223 |
| codeBlock (language 1,176) | 1,979 | underline | 194 |
| orderedList (`order` 1,306) | 1,827 | cell colwidth | 125 |
| heading | 1,541 | mediaGroup | 102 |
| em | 661 | cell background | 94 |
| table | 643 | panel | 70 |
| strike | 334 | blockCard 53, status 45, date 45, border 22, expand 14, rowspan/colspan 12, mediaInline 9, subsup 5, embedCard 4 | |

None of these appear in the Jira cache: Confluence constructs (layouts, extensions/macros, annotation marks for inline comments, alignment/indentation/breakout marks, decision lists, nested expands). The cache has only 4 Confluence pages, and comments are not cached at all, so phase 0 fetches samples of both.

## Spike results (2026-10-21, scratchpad)

- `mdast-util-from-markdown` + `mdast-util-to-markdown` with the GFM and directive extensions (`micromark-extension-gfm`, `mdast-util-gfm`, `micromark-extension-directive`, `mdast-util-directive`) run under `bun run` and inside a `bun build --compile` binary. 71 packages including transitive dependencies, all pure ESM.
- **A sample covering panel, mention, status, span, nested marks, an ordered list starting at 3, a GFM table with an escaped pipe, a hard break and literal markup characters:**
  - It serializes deterministically.
  - A second round trip is identical.
  - Plain text holding `- not a list *nor em* :foo[x] | \`c\` [a](b)` is escaped on output and read back as the same text.
- **Gotchas found:**
  - A directive attribute named `id` is written as the `{#value}` shorthand.
  - A `.` inside an id splits off a `class`.
  - Table cells are padded to column width unless `tablePipeAlign: false` is set.

## Design

### Libraries and module layout

- **Parse and serialize:** mdast (the spike stack). The hand-written parser goes away. It is the source of F9–F12: no escaping, no nested marks, crashes.
- **Modules:**
  - `lib/adf-codec.ts`: mdast ↔ ADF mapping in both directions, plus `adfToEditMarkdown(adf)` and `parseMarkdown(md) → { doc, warnings }`. `markdownToAdf(md)` stays as the public name and returns `parseMarkdown(md).doc`.
  - `lib/adf-reconcile.ts`: `canonicalize`, `equivalent`, `reconcile(original, edited)`, `lostConstructs(original, result)`.
  - `lib/markdown.ts`: keeps the display writer (`adfToMarkdown`, used by `view`, `export`, comments and the cache), `jiraWikiToMarkdown` and the `tikmedia` helpers. The old parser and `preserveUnknown` are deleted in phase 7.
- **Serializer options:** `bullet: "-"`, `emphasis: "_"`, `strong: "*"`, `rule: "-"`, `fences: true`, `resourceLink: true`, `tablePipeAlign: false`. Fixed options make the output deterministic.

### The dialect

Native markdown wherever markdown can express the construct exactly. Directives (`:name[label]{attrs}` inline, `::name[label]{attrs}` leaf, `:::name{attrs}` … `:::` container) for everything else.

**Generic rule (phase 1).** Every ADF node or mark without a dedicated spelling uses it:

- **Name:** the directive name is the ADF node type.
- **Children:** inline content goes in the label, block content goes in the container body, and a node without content is a leaf.
- **Attributes:** `attrs` are stored as one JSON attribute, `adf='{"…"}'`, which keeps the value types (numbers, booleans, objects).
- **Marks:**
  - A mark with no dedicated spelling wraps its text in `:span[text]{marks='[…]'}`.
  - Block marks (alignment, indentation, breakout) wrap their block in `:::marks{adf='[…]'}`.

Because the rule is mechanical, it also covers node types Jira adds in future.

**Dedicated spellings** replace the generic rule construct by construct. Named, typed attributes use a schema per directive. ADF attributes named `id` or `class` are written as `_id` and `_class` (spike gotcha).

| ADF | Edit-mode markdown | Phase |
|---|---|---|
| paragraph, text, heading 1–6 | native | 1 |
| strong, em, code, strike, link (`title` too) | `**`, `_`, `` ` ``, `~~`, `[t](href "title")`, nested in a fixed order | 1 |
| hardBreak | `\` at end of line | 1 |
| bulletList, orderedList (`order`), multi-block list items | `-`, `N.`, indented blocks | 1 |
| codeBlock (`language`, `wrap`, `uniqueId`) | fenced block: language in the info string, other attrs in meta (`` ```ts {wrap=true} ``) | 1 |
| blockquote, rule | `>`, `---` | 1 |
| empty paragraph | `::paragraph` | 1 |
| media, mediaSingle, mediaGroup | existing `tikmedia:` placeholder, unchanged | 1 (readable form in 5) |
| inlineCard | `<https://…>` (autolink, detected by source position); `:card[url]` if that proves fragile | 3 |
| emoji | `:emoji[:smile:]{_id=1f604 text=😄}` | 3 |
| mention | `:mention[@Jane Doe]{_id="557058:…"}` (`accessLevel` only if not empty) | 3 |
| textColor, underline, backgroundColor | `:span[text]{color=#ff5630 underline bg=#…}` | 3 |
| blockCard, embedCard | `::card[url]{appearance=block}`, `::card[url]{appearance=embed width=…}` | 3 |
| status, date | `:status[IN QA]{color=blue}`, `:date[2026-11-03]{timestamp=…}` (an edited label wins over a stale timestamp) | 3 |
| table, cells with inline content only | GFM table, wrapped in `:::table{layout=… numbered width=… colwidths="120,300"}` when it has attrs | 4 |
| table, other cases (block or multi-paragraph content, hard breaks, cell background, span, no header row, header column) | `:::::table` / `::::row` / `:::cell{colspan=2 bg=…}` | 4 |
| taskList, taskItem | `- [ ]` / `- [x]`; `localId` restored by reconcile, derived deterministically when new | 5 |
| panel, expand, nestedExpand | `:::panel{type=info}`, `:::expand{title="…"}` | 5 |
| subsup, border | `:span[x]{sub}`, `:span[x]{border=#… size=1}` | 5 |
| media (readable) | `::media[alt]{_id=… collection=… width=… height=… layout=center}`, `tikmedia:` still read | 5 |
| annotation (inline comments), layoutSection, layoutColumn, extensions/macros, decisionList, block marks | `:span[x]{annotation=…}`, `::::layout` / `:::column{width=50}`, `:::macro{key=… params='…'}` | 6 |

**Reader rules**

- **Unknown directives become text.** A directive name the codec does not know is restored as literal text from its source slice and reported as a warning. A user typing `:D` or `:::note` loses nothing.
- **Invalid nesting is normalized.** Markdown that would produce invalid ADF (for example a heading inside a list item, a table inside a list, or `code` combined with a mark ADF forbids) is turned into the nearest valid form, with a warning. The rules are checked against the official ADF JSON schema (see phase 0).
- **No throws.** Any failure while mapping a block makes that block a plain paragraph of its source text, with a warning (R17).

### Reconcile (the patch path)

The edited markdown is parsed to ADF. The result is aligned with the original:

- Top-level blocks are matched by an LCS over their canonical forms. A block that is equivalent to an original block is replaced by **the original node**, byte for byte. This restores `localId`s, attribute order and default attributes.
- Inside a changed block of the same type (lists, tables, quotes, panels), children are aligned the same way, recursively. Editing one list item does not rewrite the rest of the list.
- If the result deep-equals the original, the command reports "no changes" and sends nothing (R3).

Reconcile does not diff markdown text. The codec is exact, so comparing ADF is enough, and it is simpler.

### Edit flow

`edit -d/--ac/--ti` and comment edit on a field that already has content always go through these steps. A full replacement simply reconciles to all-new blocks, so no separate mode is needed (R5).

1. Fetch the live field (not the cache) and its `updated` timestamp.
2. Parse the edited markdown, then reconcile it against the fetched field.
3. If the result is unchanged, report "no changes" and stop.
4. **Loss guard (R14):** list node types, mark types and attributes in the original that are missing from the result. Refuse to write unless `--force` is given.
5. With `--dry-run`, print a unified diff of the edit-mode markdown, the rewritten block paths and the guard result, then stop (R16).
6. Write the backup to `~/.cache/tik/backups/<KEY>/<field>-<ts>.json`, holding the raw ADF and its edit markdown. Abort if the write fails (R15).
7. Re-check `updated`. If it changed, abort with a message.
8. PUT the field.
9. GET the field again and warn if Jira's stored version is not equivalent to what was sent.

How a user or agent edits a field:

- `tik view KEY --edit-md` prints the exact markdown (R22).
- Edit that file, then run `tik edit KEY -d file.md --dry-run`, then run it again without `--dry-run`.
- `--replace "old=>new"` (R6) is the narrow tool for changing a phrase: it edits text runs in the ADF directly, with no markdown involved.

## Phases

Each phase ends with `just check`, the harness numbers recorded in `plans/progress-log.md`, and a commit. Write commands are tested with `--dry-run` only, until the supervised live edit in phase 2.

### Phase 0: measurement (no behavior change)

1. Write `eval/roundtrip.ts` and the `just verify-roundtrip` recipe.
   - It opens the cache with `?immutable=1`, takes every ADF field, and reports: fields tested, exact rate, readable rate, idempotence, crashes and the top differing constructs with one example key each.
   - It writes a JSON report to `reports/roundtrip-<date>.json` so runs can be compared.
   - It runs under one minute.
2. Write `canonicalize` and `equivalent` in `lib/adf-reconcile.ts` (requirements §5). The harness and reconcile share them.
3. Vendor the ADF JSON schema (`@atlaskit/adf-schema` `json-schema/v1/full.json`) into `eval/`.
   - The harness validates every produced ADF against it.
   - It is not a runtime dependency.
4. Write `eval/fetch-samples.ts` (read-only). It saves raw ADF for about 300 Confluence pages across the configured spaces, and for comments on about 300 recently active issues, into `~/.cache/tik/eval/`. The harness picks them up.
5. **Golden fixtures for R20:** run today's `markdownToAdf` on the markdown we rely on (the ticket files in this repo, the AGENTS.md examples, and the markdown edge cases the old parser handled on purpose, such as snake_case and two-space breaks). Save each input and its ADF output as `lib/fixtures/*.json`.
6. Record the baseline with the current codec.

Exit: the baseline numbers are in `progress-log.md` and match requirements §3 within noise.

### Phase 1: exact codec core

1. Add the six mdast packages. Confirm `just build` still produces a working binary.
2. **ADF → mdast → markdown (`adfToEditMarkdown`):**
   - native spellings for the phase 1 rows of the dialect table;
   - the generic rule for everything else;
   - pass-through for `tikmedia:`.
3. **markdown → mdast → ADF (`parseMarkdown`):**
   - the reverse mapping;
   - typed attributes;
   - the unknown-directive-to-text rule;
   - normalization to valid ADF;
   - the no-throw fallback;
   - warnings.
4. **Mark nesting:** ADF marks are a set; markdown needs an order. The writer uses a fixed order (link outermost, then strong, em, strike, span, with code innermost). It splits runs where needed, so canonicalization merges them back.
5. **Determinism:** list items are tight unless they hold several blocks. Fenced code uses a longer fence when the code contains backticks.
6. Switch `markdownToAdf` to the new reader. All golden fixtures must produce the same ADF. Any deliberate difference is listed in the fixture file with a reason.
7. Add `lib/adf-codec.test.ts` (`bun test`).
   - One small golden case per dialect row.
   - A fuzz loop over adversarial strings (`**`, `_`, `|`, a leading `-`, unbalanced brackets, empty list items, stray `:`). Each must parse without throwing, and a second round trip must be stable.
   - Keep it small and readable.

Exit:

- Jira exact rate 100%, or every miss named in the report.
- Idempotence 100%.
- Crashes 0.
- Schema-valid 100%.
- The readable rate is recorded; it is expected to be about 70%, low because of inlineCard and emoji.
- The six requirement crashes (`PROD-1072` and others) round-trip.

### Phase 2: safe editing

1. **`reconcile`** (top-level LCS, then recursion into lists, tables, quotes and panels) and `lostConstructs`.
2. **Edit flow** steps 1–9 above, wired into:
   - `edit -d/--ac/--ti` on existing tickets;
   - `--dry-run`;
   - `--force`.
3. `tik view KEY --edit-md` for description, AC and TI. The flag name is decided against the existing `view` options when implementing.
4. **`--replace "old=>new"`**, repeatable. It works on text runs only and fails when the text is found zero times, found more than once, or split across marks.
5. **Backups:** helpers in `lib/cache.ts`.
6. **Property checks** in the harness, over a sample of 500 fields chosen to cover every construct:
   - no-op → identical;
   - one sentence edited → only that block differs;
   - delete and insert → neighbours identical;
   - guard fires when a panel or table is dropped, and stays quiet when they are kept.

Exit:

- All property checks at 100%.
- **Acceptance:** the seven tickets from the triggering case (PROD-1378 and BACK-6342, 6343, 6347, 6379, 6380, 6381), dry-run with the intended phrase edits from `13 Ticket Orchestration.md`, show only the targeted paragraphs changed.
- One supervised real edit on a throwaway ticket, checked in Jira's editor.

From here on, editing is safe even where the markdown is still ugly. Phases 3–6 only improve readability.

### Phase 3: readable inline nodes (most common first)

In this order, re-running the harness after each: inlineCard (3,535 fields), emoji (548), mention (402), textColor and underline as `span` (303 and 194), blockCard and embedCard (57), status and date (90).

- Test inlineCard as an autolink first, against the risk of plain URL text turning into an autolink: GFM autolink literals must be escaped on output.
- If it is not reliable, fall back to `:card[url]`.

Exit: exact rate is still 100%; readable rate is recorded (expected about 90%).

### Phase 4: readable tables

1. GFM tables for the simple case. Table attrs (619 fields) go in a `:::table{…}` wrapper; colwidths (125) are a comma list.
2. The directive table form for the rest: block or multi-paragraph cells, hard breaks in cells, cell background (94), row and column spans (12), tables without a header row, and header columns.
3. Editing the text of a cell in a wrapped GFM table keeps the wrapper's attrs (reconcile handles cell-level alignment).

Exit: no table needs the generic rule.

### Phase 5: the rest of Jira

1. Task lists (239) as GFM task items. `localId` comes back through reconcile; new items get a `localId` derived from position and text (R13).
2. panel (70), expand and nestedExpand (14), subsup and border spans, mediaInline (9).
3. The readable `::media{…}` form for media (about 2,200 fields). `tikmedia:` keeps being read, because `comment --attach` and `makeMediaPlaceholder` produce it.

Exit: Jira readable rate ≥ 99%. Every remaining generic use is a construct that appears in fewer than 5 fields, and is listed.

### Phase 6: comments and Confluence

1. Comment edit goes through the edit flow (R19). Comment creation uses the new reader (already true after phase 1).
2. `tik doc` edit switches from `preserveUnknown` to `adfToEditMarkdown` and reconcile (R21). Confluence create and update go through the same guard and backup.
3. Run the harness on the phase 0 samples. Add dedicated spellings, by sample frequency, for:
   - annotation marks (inline comments; losing one detaches the comment, so these come first);
   - layoutSection and layoutColumn;
   - extensions and macros (a readable `macro` label, with params as JSON);
   - block marks: alignment, indentation, breakout;
   - decisionList.

Exit: exact rate ≥ 99.9% on both samples, with every miss named. Comment no-op identity is 100%.

### Phase 7: cleanup and docs

1. Delete the old parser, `preserveUnknown`, the `tikadf:` writer (keep the reader for old markdown files) and any code made redundant.
2. Add `tik restore KEY [--field F] [--at TS]`: show the diff, then write through the edit flow (R18).
3. Update `AGENTS.md`, `README.md` and `claude_skill/tik/`: the dialect reference (one table), `--edit-md`, `--replace`, `--force`, `--dry-run` diffs, backups and restore.
4. Decide whether the display writer should become the edit writer with attributes hidden, so there is one codec. This is not required for this goal.

## Risks and open questions

- **ADF validity of hand-written markdown.** Some combinations a user can type have no valid ADF form. Example: `` **`x`** ``, which needs code combined with strong; this is to be checked against the schema. Those inputs are normalized with a warning rather than rejected. They do not affect the round trip, which starts from valid ADF.
- **Jira normalizing on save.** Jira may add `localId`s or default attributes on write. The re-read after a PUT (edit flow step 9) detects this, and canonicalization should absorb it. Watch the first supervised edits.
- **Autolink vs inlineCard.** See phase 3. The fallback is decided by a harness run, not by taste.
- **Attribute typing.** Dedicated directives need a small attribute schema each, or the round trip turns numbers into strings. The harness catches mistakes, because the attributes compare unequal.
- **Display vs edit markdown.** `tik view` keeps showing the readable lossy form. An agent that pastes display markdown into `edit -d` is caught by the loss guard rather than silently losing content. `AGENTS.md` must point agents to `--edit-md`.
- **Dependency size.** Adds about 70 small packages to the binary. Acceptable next to the existing transformers and onnx bundle; checked in phase 1, step 1.
