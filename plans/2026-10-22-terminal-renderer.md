# Plan: terminal renderer for the markdown dialect (with kitty images)

## Goal

`tik view`, `comments`, `history` and `doc view` show rich text the way Jira shows it, as far as a terminal can: colors, panels, status pills, tables, layouts, task lists, links and, in a kitty-capable terminal, embedded PNGs. One renderer replaces `glow` and `marked-terminal`.

Success means:

- **Every construct in the dialect has a rendering**, listed in the table below and covered by a test. Unknown constructs render their text and never throw.
- **Corpus**: all 17,984 cached ADF fields, the Confluence and comment samples render with 0 throws, no line wider than the requested width (by `string-width`), and no raw `:name[` or `tikmedia:` text in the output except where the source is literal text.
- **Same output on every machine**: no dependence on `glow` being installed.
- **Plain mode** (`NO_COLOR`, or `--plain`-style callers) has no ESC bytes, and its text is still structured.
- **Speed**: p95 render of one field under 5 ms at width 100, images excluded.

## Design

### One pipeline, mdast as the shared IR

```
ADF ──► blocksToMdast ──┐
                        ├──► render(root, opts) ──► string[] (ANSI lines)
markdown ──► fromMarkdown ──┘
```

- The codec already builds mdast from ADF (`blocksToMdast`, `adf-codec.ts:128`) and reads markdown into mdast (`fromMarkdown` with `readOptions`). The renderer consumes that tree, so display from ADF skips the string round trip, and any markdown string (changelog text, wiki-converted text, `--edit-md` previews) uses the same code.
- The dialect is lossless (round-trip harness: 100% exact), so an mdast renderer can show every ADF construct.
- The renderer is one-way. No ANSI→md or ANSI→ADF: ANSI has no structure and depends on width and color depth.
- Fallback nodes the codec writes (`:::nodeType{adf='json'}`, `:span{marks='[json]'}`) render their children with a dim `‹type›` label.

### Codec changes (small, additive)

In `lib/adf-codec.ts`:

- Export `adfToMdast(adf): Root` (the first half of `adfToEditMarkdown`) and `markdownToMdast(markdown): Root` (the `fromMarkdown` call inside `parseMarkdown`, never throwing: on failure a paragraph of the source text).
- Export `directiveInfo(node): { name; attrs: Record<string, string | number | boolean | number[] | unknown> }`. It decodes the string attributes using the existing tables (`DEDICATED`, `CONTAINERS`, `TABLE_ATTRS`, `CELL_ATTRS`, `MEDIA_ATTRS`, `SINGLE_ATTRS`, `BORDER_ATTRS`, `BLOCK_MARKS`, `MACRO_ATTRS`) so the renderer never copies the spec. `numbers` → `number[]`, `flag` → `true`, `json` → parsed value, `adf` → parsed attrs.
- Unit tests: `directiveInfo` decodes one directive of every spec table.

### Renderer structure

Flat files in `lib/`, following the project layout:

| File | Responsibility |
|---|---|
| `lib/term-render.ts` | Entry points (`renderAdf`, `renderMarkdownText`), block walker, inline walker, wrapping |
| `lib/term-style.ts` | SGR helpers, color depth (truecolor / 256 / 16 / none), hex → nearest color, OSC 8 links, contrast clamp, ADF palette (status, panel, text colors) |
| `lib/term-table.ts` | Table layout: column widths, spans, box drawing |
| `lib/kitty.ts` | Capability detection, PNG header reader, transmit / place sequences, tmux wrapping, on-disk media cache |

Options: `{ width, color: "truecolor" | "256" | "16" | "none", theme: "dark" | "light", links: boolean, images: ImageProvider | null }`, with defaults from the environment (`getTerminalWidth`, `COLORTERM`, `NO_COLOR`, `COLORFGBG`, `isTTY`).

Core idea: **blocks render to `string[]` at a given width, containers compose by rendering children at a narrower width and prefixing lines.** Quote prefix `▎ `, list indent, panel bar and cell padding are all "render children at `width - prefix`, then prefix every line". Inline content renders to one styled string, then `wrap-ansi` wraps it (hard wrap, trim off). `string-width` measures, `slice-ansi` truncates. All three, plus `cli-boxes`, come in through Ink today; declare them in `package.json` (pinned to the versions in `bun.lock`).

### Construct table

| Dialect | Rendering |
|---|---|
| Paragraph | wrapped text, blank line between blocks |
| Heading 1-6 | h1/h2 bold + color with an underline rule (`═` / `─`), h3-h6 bold, h5-h6 dim |
| Bold, italic, strike, underline, `code` | SGR 1, 3, 9, 4; code on a subtle background with no wrapping inside |
| Link, `<url>` autolink | OSC 8 hyperlink with underlined blue text; without TTY or `links: false`, `text (url)` when they differ |
| `:span{color= bg= underline sup sub}` | truecolor fg / bg through the contrast clamp; sup/sub as Unicode super/subscripts when every character has one, else `^(x)` / `_(x)` |
| Hard break, empty paragraph | newline, blank line |
| Bullet / ordered lists | `•`, `◦`, `▪` by depth; ordered keeps the start number, right-aligned numbers per list; wrapped lines hang-indent |
| Task list | `☐` / `☑` (`[ ]` / `[x]` in plain mode); done items dim |
| Decision list | `◆` prefix with a dim label |
| Blockquote | `▎` bar in dim gray, content in the normal style |
| Rule | `─` to width, dim |
| Code block | language label top right, full-width dark background block, syntax highlight via `cli-highlight` (already a `marked-terminal` dependency; kept only if it bundles, else no highlight) |
| `:::panel{type=…}` | left bar and icon by type: info `ℹ` blue, note `✎` purple, success `✔` green, warning `⚠` yellow, error `✖` red; custom `color` / `iconText` honored |
| `::::expand{title=}` / `nestedExpand` | `▾ title` followed by the body, indented, dim bar; `--collapse-expands` is out of scope |
| `:status[text]{color=}` | pill: colored background with `text` uppercase, padded one space each side |
| `:mention[@x]` | `@x` in cyan; `:date[…]` as the plain label (`2026-11-03`) in dim; `:emoji{text=}` uses `text` (the glyph) else `:shortName:` |
| `::card[url]{appearance=}` and `<url>` inline card | inline: hyperlink; block / embed: boxed one-liner `↗ url`, `appearance=embed` with a dim `embed` tag |
| Table (GFM or `:::::table`) | box drawing; header row bold on a tinted background; `colwidth` proportions, `bg` cells, `colspan` / `rowspan` best effort; numbered column; cell content is rendered blocks; falls back to a stacked `key: value` layout when the table cannot fit at 40 columns |
| `::::layout` / `:::column{width=}` | side-by-side columns separated by a dim `│` when `width ≥ 100`; each column gets its percent of the width; stacked with a dim `┈` between below that |
| `:::marks{align indent breakout}` | `align=center|end` pads lines; `indent` indents; `breakout` ignored |
| `::macro{key=…}`, `:::macro` | dim label `⟨macro key⟩` followed by the body when bodied; known simple ones (`toc`, `children`) are labels only |
| `::media[alt]{…}`, `:::mediaGroup`, `:media` | image if available (phase 4), else the placeholder line below |
| `![…](tikmedia:…)` placeholder | decoded with `decodeMediaPlaceholder`, rendered like media |
| `:hardBreak[]`, `:::taskItem` etc. | the codec's own spelling, handled through `directiveInfo` |
| Unknown directive / generic `adf=` block | children plus dim `‹name›` label |

Media placeholder line (no image): `▣ filename · 4.2 MB` in dim, with ` · tik get KEY name` when the key is known and the file is not an image the terminal can show. Type icon by MIME: `▣` image, `▶` video, `▤` pdf and other files.

### Colors and contrast

- ADF colors come from Atlassian's palette and are tuned for a white page. A dark navy `#172b4d` is unreadable on a dark terminal, so every user-supplied foreground goes through a **contrast clamp**: if its contrast ratio against the assumed background is under 4.5, its lightness is moved (not its hue) until it passes. Same for backgrounds against the foreground.
- The assumed background comes from `COLORFGBG` when set, else dark, and can be forced with a config key. No OSC 11 query (it needs raw TTY reads and breaks under pipes and tmux).
- Color depth: `COLORTERM=truecolor|24bit` → 24-bit; `TERM` containing `256` → nearest xterm-256; else nearest of 16; `NO_COLOR` set or `color: "none"` → no SGR at all (structure glyphs stay).

### Images (kitty graphics protocol)

Scope and limits, as agreed:

- **PNG only** (`image/png`, 97% of corpus images). Kitty takes PNG directly (`f=100`); no decoder dependency. JPEG, GIF, WebP, SVG, video and PDF render the placeholder line.
- **Size cap** `terminal.maxImageBytes`, default 2 MB, checked against the cached attachment `size` before any download. Over the cap renders `▣ name.png · 12 MB · too large (tik get KEY name)`.
- **Matching a media node to an attachment**: by `alt` filename on the ticket's attachments, as `tik get` does (the ADF `id` is a media-service UUID that attachments only carry when resolved). No match → placeholder line.
- **Fetch**: `/rest/api/3/attachment/content/{id}` with the auth header, as `get` does; saved to `~/.cache/tik/media/{attachmentId}.png`; cache hit never refetches. Fetches in a render run in parallel, with a per-image timeout; a failure renders the placeholder with a dim `(download failed)`.
- **Sizing**: read width and height from the PNG IHDR (bytes 16-24). Target columns = the `mediaSingle` `width` percent of the available width (default: image's natural width in cells, 1 cell ≈ 8 × 16 px), capped at 80% of the width and `terminal.maxImageRows` (default 20). Rows from the aspect ratio. Pass `c=` and `r=` so the terminal scales.
- **Detection** (`kitty.ts`): `process.stdout.isTTY`, then env: `KITTY_WINDOW_ID`, `GHOSTTY_RESOURCES_DIR` / `TERM` containing `ghostty` / `kitty`, `WEZTERM_EXECUTABLE`, `TERM_PROGRAM` of `WezTerm`. Inside tmux (`TMUX` set) additionally require `tmux show -gv allow-passthrough` to be `on` or `all`. Overrides: global flags `--images` / `--no-images` and config `terminal.images: "auto" | "off"`. No terminal query (APC `a=q` needs a raw read and an answer timeout); env is enough for the terminals in use.
- **Transmission**: base64 in 4096-byte chunks (`m=1` / `m=0`), `q=2` to silence replies. Under tmux every escape is wrapped `\ePtmux;` with ESC doubled, `\e\\`.
- **Placement**, two modes behind one `ImageProvider` interface:
  1. **Direct placement** (`a=T`): one sequence at the cursor, then `rows` newlines. Simple. Under tmux the image is not tracked, so it breaks on scroll and pane switches.
  2. **Unicode placeholders** (`U=1` virtual placement, image id in the foreground color, `U+10EEEE` with row / column diacritics): the image becomes ordinary text cells, so it scrolls with tmux, survives pane redraws, and passes through Ink's line counting in `comments` (a raw APC sequence inside an Ink `<Text>` corrupts its layout). Needs the 297-entry diacritics table (~100 lines) and the upload `a=t,i=ID` written to stdout before the text.
  - Phase 4 builds direct placement first behind the interface, then placeholders if the spike confirms Ghostty 1.3.1 honors them through tmux. If it does, placeholders become the default everywhere (one code path); direct placement stays only as the non-tmux option if placeholders prove flaky.
- **Pager use** (`| less -R`): not a TTY → no images, no OSC 8; styles stay. Documented.

### Wiring

- `parseIssue` / `parseComments` keep the raw ADF next to the markdown (`descriptionAdf`, `acceptanceCriteriaAdf`, `testingInstructionsAdf`, `bodyAdf`). The markdown fields stay: FTS, search, `--md` and `--json` use them. `getCachedIssue(...).raw` already holds the ADF, so `view` needs no new fetch.
- `view` (`main.ts:701-709`), `comments` (`main.ts:4897`) and `ui/history.tsx:104` call `renderAdf` when they have ADF, else `renderMarkdown(md)`.
- `renderMarkdown(md, opts)` keeps its name and becomes `markdownToMdast` + `render`, so the five call sites outside `view` need no change. The `glow` code (`hasGlow`, `renderWithGlow`), `getMarked` and the `marked` / `marked-terminal` dependencies are removed.
- `doc view` (`main.ts:5864`): `page.body` is markdown from `adfToMarkdown`. Phase 3 checks whether the page cache keeps the ADF (`lib/confluence.ts:88`); if so it uses it, if not it renders the markdown (still better than today) and the ADF is a follow-up.
- `CommentsView` truncates by line count (`COMMENT_PREVIEW_LINES`) over `renderedBody.split("\n")`. With multi-line images that cut would split an image; the renderer returns lines and image blocks are atomic, so the truncation counts an image as one unit (phase 4).
- Width: callers pass the width they have (`getTerminalWidth() - 4` for `view`, the 66 columns inside the comment box). The renderer never reads the terminal itself except through the defaults in options.
- Config (`LocalConfig`, optional): `terminal?: { images?: "auto" | "off"; maxImageBytes?: number; maxImageRows?: number; theme?: "dark" | "light" }`.

## Phases

Each phase ends with `just check`, `bun test` and the harness, and is committed on its own.

### Phase 0: baseline and spike

- Snapshot the current display of the fixtures (`lib/fixtures/*.json`, the PMP-1838 ticket) to `reports/render-baseline/` so the before / after comparison is visible.
- **User-run spike in Ghostty + tmux** (decides the image path): a 2×2 red PNG via passthrough direct placement and via Unicode placeholders; scroll, split pane and detach / reattach. Record results in the progress log.
- Declare `wrap-ansi`, `string-width`, `slice-ansi`, `cli-boxes` in `package.json`; confirm `bun build --compile` still works (`just build`).
- Acceptance: baseline files committed, spike result recorded.

### Phase 1: renderer core

- Codec exports (`adfToMdast`, `markdownToMdast`, `directiveInfo`) with tests.
- `term-style.ts` and `term-render.ts`: paragraphs, headings, marks, links, lists, task and decision lists, quote, rule, code block, panel, status, mention, date, emoji, cards, hard breaks, spans, unknown fallback.
- A basic table (box drawing, equal-ish widths, header style); spans, `colwidth` and fallbacks come in phase 3.
- Tests: `lib/term-render.test.ts`, one small test per row of the construct table, asserting on `stripAnsi` output plus a handful of ANSI assertions (status pill background, link OSC 8, contrast clamp on `#172b4d`). Width wrapping, hanging indents and nested containers each get one test.
- Acceptance: all unit tests pass; `eval/render.ts` (new, modeled on `eval/roundtrip.ts`, `just verify-render`) runs the corpus with 0 throws and 0 lines over width.

### Phase 2: wire in and remove glow

- Keep ADF in `parseIssue` / `parseComments`; switch `view`, `comments`, `history` to the renderer; reimplement `renderMarkdown` on it.
- Delete `glow` and `marked` code and the two dependencies; `bun install`; `just build` and compare the binary size.
- Visual check against the baseline on PMP-1838: the `**Me**` literal asterisks, doubled `[ ]  [ ]` and 4-space code blocks are gone.
- Acceptance: `grep -rn "marked\|glow" lib ui main.ts package.json` empty; `tik view PMP-1838 -A`, `tik comments`, `tik history` look right in Ghostty (user check).

### Phase 3: tables, layouts, expands, macros

- `term-table.ts`: column widths from `colwidth` (proportional), min width per column from the longest word, shrink-to-fit with wrapping, `colspan` / `rowspan`, `bg` cells, numbered column, stacked fallback under 40 columns.
- Layout columns side by side; `:::marks` alignment; expand; macro labels.
- Confluence: use cached ADF for `doc view` if available.
- Tests: table with spans and widths, a narrow-width fallback, layout at 80 and 120 columns, expand nested in a table cell.
- Acceptance: corpus harness still 0 throws / 0 overflow; the Confluence sample pages (layouts, macros) show correctly in the terminal.

### Phase 4: images

- `kitty.ts`: detection, PNG header reader, chunked transmit, tmux wrapper, disk cache, size cap; `--images` / `--no-images` global flags; config keys.
- `ImageProvider` plumbing into the renderer (async pre-resolve step: collect media nodes, fetch / cache in parallel, then render synchronously).
- Direct placement first; Unicode placeholders if the Phase 0 spike supports them; make them the default if they work through tmux.
- `CommentsView`: image blocks counted as one unit in the 15-line preview; with placeholders the Ink layout is unaffected.
- Tests: PNG header parse, cap logic (cached size over limit → no fetch), tmux wrapping, chunking boundary (payload of exactly 4096 and 4097 bytes), detection from env tables, `NO_COLOR` / non-TTY → none.
- Acceptance (user check in Ghostty + tmux): a ticket with PNGs in description and comments shows them inline at the right size; scrolling and splitting panes keep them correct (placeholders); a 35 MB image and a `.mov` render the labeled placeholder without a download.

### Phase 5: hardening and docs

- Property pass over fuzz markdown and the corpus: never throws; output width bound; idempotence of the plain-mode output.
- Timing on the corpus (p95 target).
- Docs: `AGENTS.md` (display notes, `--images`, `terminal` config), `README.md`, and update `requirements.md` §166 ("display output stays as it is"), the progress log, and `.claude` skill text if it describes the display.
- Acceptance: all success criteria above met and recorded in `plans/progress-log.md`.

## Risks

| Risk | Mitigation |
|---|---|
| Directive attributes are strings and the spec tables live in the codec | `directiveInfo` is the one decoder, tested against every table; a spec change fails its test |
| Dark-on-dark text from Jira colors | Contrast clamp with tests; theme override |
| Images under tmux misplace or leak escape text | Spike first; placeholders as default if they work; `--no-images` always available |
| Raw APC sequences inside Ink output break `comments` layout | Placeholders (text-only) or print images outside Ink; decided by the spike result |
| Wide characters (CJK, emoji) break column math | `string-width` for every measurement; one table test with emoji and CJK |
| Giant table or code block in a field | Per-block line cap is not applied (the user asked for the content); tables fall back to stacked layout, code lines wrap hard |
| Renderer drifts from the dialect | Every dialect row in `adf-codec.test.ts` is also rendered in a test that asserts no `:name[` leaks into the output |
| Bundle size or compile issues from new deps | Phase 0 compile check; removing `marked-terminal` and its `cli-highlight` / `highlight.js` offsets the additions |

## Decisions (defaults unless changed)

- Styles are on unless `NO_COLOR`, matching how the rest of `tik` emits color today. Images and OSC 8 links require a TTY.
- PNG only for images, 2 MB cap, 20 rows max, off when not detected.
- No terminal queries; detection is from env and tmux settings.
- Syntax highlighting is a nice-to-have: dropped if `cli-highlight` does not bundle cleanly.
- `renderMarkdown` keeps its name so existing call sites do not change.

## Out of scope

- Editing or interaction (collapsing expands, clicking links beyond OSC 8).
- JPEG, GIF, WebP, SVG, video, PDF previews.
- Light / dark detection by terminal query.
- Changing `--json`, `--plain`, `--md` output.
- Rendering Jira wiki markup directly (still converted by `jiraWikiToMarkdown` first).
