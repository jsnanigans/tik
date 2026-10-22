# Requirements: Safe Markdown Round Trip for Jira Rich Text

Status: scoping only, no code yet. Written 2026-10-21.

## 1. Why this exists

`tik` edits Jira rich text (description, acceptance criteria, testing instructions, comments) by converting markdown to Atlassian Document Format (ADF) and replacing the whole field. That is fine for text the user wrote from scratch. It is not fine for editing a ticket that someone else wrote in Jira's editor, because the markdown conversion cannot express a lot of what the editor produces. Anything it cannot express is silently dropped or reshaped when the field is written back.

The trigger was a real case. We wanted to change a few phrases in seven existing tickets (PROD-1378, BACK-6342, 6343, 6347, 6379, 6380, 6381). A local test that converted each live description to markdown and back showed that horizontal rules disappear in six of the seven, tables gain extra cells in four, and text changes in six. Because `tik edit -d` replaces the whole description, applying the edit would have damaged tickets we only meant to touch in two or three sentences. We stopped and did not write anything to Jira.

The goal of this work: **editing an existing ticket through `tik` must never change anything the user did not intend to change.**

## 2. Is 100% safe possible?

Two different claims hide inside "the round trip is 100% safe". They have different answers.

1. **Every ADF document survives ADF → markdown → ADF unchanged.** Not achievable with readable markdown. ADF has constructs markdown has no syntax for: panels, text color, underline, table column widths and merged cells, smart cards, mentions, status lozenges, expand sections. Carrying them through markdown exactly means encoding them as opaque placeholders, which keeps them intact but makes the markdown unreadable in those spots. A faithful codec can get close to exact for everything markdown can express, and exact for the rest through placeholders, but "readable and exact for all inputs" is a contradiction.
2. **Editing a ticket never damages content the user did not touch.** Achievable, and it is the property that actually matters. The way to get it is to stop depending on the codec for untouched content: compare the edited markdown with the markdown that was generated from the original, and write back only the blocks that changed, reusing the original ADF nodes untouched for everything else. The codec's gaps then only affect the blocks being edited, and a loss guard can warn when a changed block contains something the codec cannot carry.

This document therefore asks for both: a much more faithful codec (so the changed blocks are also safe in almost all cases), and a patching layer (so untouched content is safe in all cases). "Slight style changes are acceptable" is taken to mean the equivalence defined in section 5.

## 3. Evidence from the current implementation

Measured on 2026-10-21 against the local cache (`~/.cache/tik/tickets.db`, 11,762 issues). Every description, acceptance criteria and testing instructions field that holds ADF was converted with `adfToMarkdown` and back with `markdownToAdf`, then compared after a light normalisation (adjacent text runs with the same marks merged, `localId` and `id` attributes ignored). Comments are not in the cache and were not measured.

| Measure | Default mode | `preserveUnknown` mode |
|---|---|---|
| Rich-text fields tested | 17,984 | 17,984 |
| Identical after the round trip | 9,257 (51.5%) | 10,114 (56.2%) |
| Different | 8,727 | 7,870 |
| Parser crashes | 6 | 6 |

`preserveUnknown` is only used by the Confluence code path; no Jira command uses it. Even the better mode loses about 44% of fields in some way.

Constructs whose counts changed, in number of fields affected (default mode): smart links (`inlineCard`) 3,531; hard line breaks 1,722; ordered-list start number 1,303; table attributes (layout, number column) 618; emoji 547; mentions 402; text color 302; horizontal rules 250; underline 193; table column widths 125; panels 70; block cards 52. Inline code, emphasis and strong marks also change in a few hundred fields, which points at the nested-mark problem described below.

The crash is a null dereference in `parseList` (`lib/markdown.ts`): a line that the paragraph-break check treats as a list item but the list-item pattern rejects. Example field: `PROD-1072` description.

## 4. Failure catalogue

Each item is a distinct cause. Section 6 turns them into requirements.

**Writer (ADF → markdown)**

- F1. Nodes with no markdown form are flattened or dropped: panels, expands, extensions, status, date, mention, inline and block cards, emoji attributes. Only media is preserved.
- F2. Marks with no markdown form are dropped: underline, text color, background color, sub/superscript, alignment, indentation, breakout.
- F3. Horizontal rules are written as `---` but the reader has no rule syntax, so they vanish.
- F4. Table cells are joined with a space. Multi-paragraph cells, lists in cells, hard breaks in cells, and `|` in cell text break the row or merge content. Column widths, background, layout, number column, header column, colspan and rowspan are lost.
- F5. Ordered lists always restart at 1; the list's start number is dropped.
- F6. List items keep only their first child as inline text; paragraphs and nested blocks in an item are re-indented and not reliably restored.
- F7. Blank structure is collapsed: empty paragraphs, runs of blank lines, trailing hard breaks.
- F8. Task and decision lists get new random `localId` values on every conversion, so two conversions of the same input differ.
- F9. Text is not escaped. A literal `*`, `_`, `` ` ``, `[`, `~`, `|`, or a paragraph starting with `-`, `#`, `1.`, `>` is reread as markup.

**Reader (markdown → ADF)**

- F10. Inline parsing does not recurse: `**bold with `code`**`, `**[link](u)**`, `*em **strong***` lose or misplace marks.
- F11. Only a subset of markdown is understood (no rule, no strikethrough edge cases, no autolinks, no numbered start, no loose lists, no setext headings, no tables with alignment), and nothing signals what was ignored.
- F12. The parser can throw (see the crash above). A thrown error aborts the command after the user has finished their edit.

**Workflow**

- F13. There is no get-modify-put flow. `edit -d` takes markdown and replaces the field, so every edit pays the full codec cost.
- F14. No backup of the previous content is written before a field is replaced.
- F15. No guard compares the result with the original, so loss is silent.

## 5. Definition of "equivalent"

The requirements below use one equivalence, so it is written down once.

Two ADF documents are **equivalent** when, after canonicalisation, they are identical. Canonicalisation:

- merge adjacent text nodes that carry the same marks;
- order marks on a node in a fixed order;
- ignore `localId` on task and decision items and `id` on other nodes, unless the node was reused from the original (reused nodes are compared byte for byte);
- treat an absent attribute and an attribute equal to its documented default as the same;
- ignore trailing empty paragraphs and the difference between one and several blank lines between blocks;
- ignore the choice of list marker (`-` or `*`) and of emphasis marker (`*` or `_`).

Everything else, including text, mark types and values, link targets, node types, attributes, table structure, list nesting and order, must match. Whitespace inside text runs is preserved exactly.

## 6. Requirements

Priority: **M** must have, **S** should have, **C** could have.

### 6.1 Patch-based editing (the guarantee)

- R1 (M). Add an edit path that works on an existing ticket's content: fetch the current ADF, render it to markdown, accept the edited markdown, and write back an ADF in which every block that did not change is **the original ADF node, untouched**, including all attributes and ids.
- R2 (M). Change detection works at block level (heading, paragraph, list, table, code block, quote, rule, and so on) by comparing the original rendering of each block with the edited markdown. Nested lists and tables are compared at their own level when the top-level block changed, so editing one list item does not rewrite the rest of the list.
- R3 (M). A no-op edit (markdown unchanged, or only whitespace outside text runs) produces an ADF identical to the original and sends nothing to Jira. The command reports "no changes".
- R4 (M). Blocks the user changed or added go through the codec (section 6.2). Blocks the user deleted are removed.
- R5 (M). The existing way of passing a full replacement (`-d TEXT_OR_FILE` on a new or existing ticket) keeps working for content written by hand. It must be clear in help text that it replaces the field, and `edit -d` on a field that currently holds content must warn when the replacement would drop constructs from the current content (R14).
- R6 (S). Add `tik edit KEY --replace "old=>new"` (repeatable, per field) that substitutes text inside existing text runs and touches nothing else. It fails if the old text is not found exactly once, or is split across marks, and says which. This is the narrow tool for fixing a phrase in a ticket.

### 6.2 Codec fidelity (the quality)

A new **edit mode** of the codec produces the markdown shown to the user and the markdown read back. The existing display output (`tik view`, `export`, `comments`) keeps its current readable, lossy form unless a requirement says otherwise.

- R7 (M). Everything markdown can express round-trips exactly under the equivalence in section 5: paragraphs, headings, bold, italic, strikethrough, inline code, links, bullet and ordered lists with nesting and with several blocks per item, task lists, block quotes with several blocks, fenced code with language, horizontal rules, hard breaks, tables whose cells hold inline content.
- R8 (M). Inline marks nest: any order and combination of strong, em, strike, code and link on one text run, and a link or code span inside bold, round-trip.
- R9 (M). Text is escaped on output and unescaped on input, so literal markup characters, a leading list marker, heading marker, quote marker, table pipe or code fence in plain text never turn into markup.
- R10 (M). Constructs with no markdown form are carried as opaque placeholders (the existing `tikadf:` mechanism) in edit mode, with a short readable label so the user can see what it is and leave it alone. This covers panels, expands, extensions, status, date, mention, inline and block cards, emoji, and any node type not known to the codec (forward compatibility with new Jira node types).
- R11 (M). Marks with no markdown form (underline, text color, background color, sub/superscript, alignment, indentation) and table attributes (column widths, background, layout, number column, header column, colspan, rowspan) are carried through without loss, either as placeholders around the affected run or as a small attribute annotation attached to the node. The choice is a design decision; the requirement is that nothing is lost and that editing the text of an annotated run keeps its annotation.
- R12 (M). Ordered lists keep their start number. Empty paragraphs are preserved. Hard breaks inside list items, table cells and quotes are preserved. Multi-paragraph and list content inside table cells is preserved.
- R13 (S). Conversion is deterministic and idempotent: converting the same ADF twice gives the same markdown, and a second round trip changes nothing. Task and decision list ids are preserved from the original where the node is unchanged and derived deterministically where new.

### 6.3 Robustness and safety rails

- R14 (M). **Loss guard.** Before writing, compare the original and resulting ADF. If any node type, mark type or attribute present in an unchanged region of the original is missing from the result, refuse to write and print which constructs would be lost. An explicit flag overrides it. In patch mode the guard can only fire for changed blocks.
- R15 (M). **Backup.** Before any write to a rich-text field (edit, comment edit, delete), save the previous raw ADF and its markdown rendering to `~/.cache/tik/backups/<KEY>/<field>-<timestamp>.json`. Writing a field never succeeds without the backup existing.
- R16 (M). **Dry run.** `--dry-run` for edit shows a unified diff of the markdown before and after, a list of the blocks that will be rewritten, and the loss-guard result. It sends nothing.
- R17 (M). The parser never throws on any input. Unparseable or unsupported text falls back to a plain paragraph and is reported as a warning. The six corpus crashes are fixed by this.
- R18 (S). `tik restore KEY [--field F] [--at TIMESTAMP]` writes a backup back, after showing a diff.
- R19 (S). Comments follow the same rules as descriptions: editing an existing comment (`comment --edit`) uses the patch path, and comment creation uses the edit-mode reader for escaping.

### 6.4 Compatibility and scope

- R20 (M). Markdown already accepted today keeps producing the same ADF where the old result was correct. Golden fixtures capture the current behavior for the cases we rely on (the ticket files written in this project's session are good examples) and any deliberate difference is listed.
- R21 (M). Applies to Jira description, acceptance criteria, testing instructions and comments. The Confluence code path (`tik doc`) shares the codec and must not regress; it may adopt the patch path later.
- R22 (S). `tik view`, `export` and `comments` gain an `--edit-md` option (or equivalent) that prints the edit-mode markdown, so a user can start from exactly what the patch path will diff against.

## 7. Verification

Verification must be runnable by anyone with the local cache and must produce numbers, not impressions. Nothing in it writes to Jira.

### 7.1 Corpus round-trip harness

A repeatable command (for example `just verify-roundtrip`, running a script under `eval/`) that reads every rich-text field in the local cache and reports:

- fields tested, and fields skipped (not ADF);
- **codec exact rate**: share of fields whose edit-mode round trip is equivalent (section 5);
- **codec exact rate excluding placeholders**: share that is equivalent without relying on opaque placeholders, to show how readable the markdown stays;
- **idempotence**: share where a second round trip equals the first;
- **crashes**: count and first examples;
- the top constructs still differing, with one example key each.

Targets for sign-off: crashes 0; codec exact rate at least 99.5%; every remaining difference explained by a documented construct; idempotence 100%. The baseline to beat is the table in section 3. The harness stores its report so runs can be compared.

### 7.2 Patch-path property checks

For a sample of at least 500 fields chosen to include every construct in the failure catalogue (the harness can select them by node-type coverage):

- **No-op identity.** Render, make no edit, patch: the result is byte-identical to the original ADF. Target 100%.
- **Single-block edit.** Change one sentence in one block, patch: every other block is byte-identical to the original and only the edited block differs. Target 100%.
- **Delete and insert.** Remove a block, add a block in the middle, patch: the surrounding blocks stay byte-identical.
- **Loss guard.** Replace a field with markdown that omits a panel or a table: the guard fires and nothing is written. Replace with an edit that keeps them: it does not fire.

### 7.3 Golden and fuzz tests

- A small set of golden fixtures, one per construct in sections 4 and 6.2, each a pair of ADF and expected markdown with an assertion of equivalence in both directions. Kept small and readable.
- A fuzz pass over random markdown (including adversarial text such as `**`, `_`, `|`, leading `-`, unbalanced brackets, empty list items) asserting that the reader never throws and that rendering its output and reading it again is stable.

### 7.4 Live read-only acceptance

- For the seven tickets from the triggering case, run the patch path in dry-run mode for the exact edits we wanted (the phrase changes listed in `13 Ticket Orchestration.md` of the RX Now notes). The dry run must show that only the targeted paragraphs differ, and the result must be identical elsewhere. These are the acceptance cases.
- Fetch a sample of live tickets directly (not from the cache), run a no-op edit, and confirm that no request would be sent.
- After the work ships, perform one supervised real edit on a throwaway ticket, view it in Jira's editor, and confirm that nothing outside the edited text changed, including tables and rules.

### 7.5 Regression

- `just check` passes.
- Existing commands (`view`, `export`, `comments`, `comment`, `create`, `edit -d`, `doc`) produce the same output as before for inputs that were handled correctly, apart from the intentional differences listed with R20.

## 8. Non-goals

- Rendering every ADF construct nicely in the terminal. This was left out of the codec work and is done by the terminal renderer (`plans/2026-10-22-terminal-renderer.md`).
- Full CommonMark or GitHub-flavored markdown compliance. The dialect is whatever the codec defines, as long as it is documented and tested.
- Editing media (images, attachments) beyond preserving what is there.
- Real-time collaborative editing or conflict resolution. If the ticket changed in Jira between fetch and write, the write is refused with a message (R1 compares the version it started from).

## 9. Risks and open questions

- **Placeholder readability.** Carrying panels, colors and cards through placeholders makes edit-mode markdown noisier. Decide the label format and whether long placeholders can be shortened to an id with the payload held in a sidecar file or in the backup.
- **Attribute annotation syntax (R11).** Inline placeholder, HTML-style comment, or sidecar map keyed by block index. The sidecar keeps the markdown clean but is fragile if the user reorders blocks. Needs a short design note and a spike against the corpus before committing.
- **Concurrent edits.** The patch path needs the issue version or the `updated` timestamp from fetch time, and a clear failure message if Jira has moved on.
- **Block matching after heavy edits.** If the user rewrites most of a field, block matching degrades to rewriting most blocks. That is acceptable (the user asked for it), but the dry-run must make it visible.
- **Comments.** Not in the local cache, so the corpus harness cannot cover them. Decide whether to extend the cache or add a one-off fetch of a comment sample for verification.
- **Performance.** The harness runs over about 18,000 fields; it should finish in under a minute so it can run before each release.

## 10. Suggested order of work

1. **Harness first** (7.1, the baseline report). Nothing else is measurable without it.
2. **Parser robustness** (R17), a small fix with an immediate measurable result.
3. **Patch path with no-op identity** (R1 to R4, R14 to R16), built on the existing codec. This alone delivers the safety guarantee for untouched content, even before the codec improves.
4. **`--replace`** (R6), which is mostly a special case of the patch path and unblocks the seven tickets from the triggering case.
5. **Codec fidelity** in order of corpus impact: smart cards, mentions, emoji, hard breaks and ordered-list start, table content and attributes, rules, nested marks, escaping, then panels and other opaque nodes (R7 to R13), re-running the harness after each.
6. **Comments, restore, `--edit-md`** (R18, R19, R22) and documentation updates (`AGENTS.md`, `README.md`, the skill docs), per the repository's rule that flag changes are documented where they are made.
