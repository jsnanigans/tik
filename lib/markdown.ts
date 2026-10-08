export type AdfNode = {
  type: string;
  content?: AdfNode[];
  text?: string;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
  attrs?: Record<string, unknown>;
};

// ADF nodes markdown cannot express round-trip as base64 image placeholders (`tikmedia:`/`tikadf:`).
const MEDIA_TYPES = new Set(["mediaSingle", "mediaGroup", "media", "mediaInline"]);
const INLINE_TYPES = new Set([
  "text", "hardBreak", "mention", "emoji", "date", "status", "inlineCard", "mediaInline", "inlineExtension", "placeholder",
]);

function readableText(node: AdfNode): string {
  const attrs = node.attrs ?? {};
  switch (node.type) {
    case "mention":
      return "@" + String(attrs.text || "user").replace(/^@/, "");
    case "status":
      return String(attrs.text ?? "");
    case "date": {
      const date = new Date(Number(attrs.timestamp));
      return isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 10);
    }
    case "inlineCard":
    case "blockCard":
    case "embedCard":
      return String(attrs.url ?? "");
    default:
      return "";
  }
}

function placeholderLabel(node: AdfNode): string {
  const attrs = node.attrs ?? {};
  switch (node.type) {
    case "mediaGroup":
      return "image: " + (node.content ?? []).map((c) => (c.attrs?.alt as string) || "file").join(", ");
    case "mediaSingle":
    case "media":
    case "mediaInline": {
      const media = node.content?.find((c) => c.type === "media") ?? node;
      return "image: " + ((media.attrs?.alt as string) || "image");
    }
    case "status":
    case "date":
      return `${node.type}: ${readableText(node)}`;
    case "extension":
    case "bodiedExtension":
    case "inlineExtension":
      return `macro: ${attrs.extensionKey}`;
    case "expand":
    case "nestedExpand":
      return `expand: ${attrs.title || ""}`;
    default:
      return readableText(node) || node.type;
  }
}

function encodePlaceholder(node: AdfNode): string {
  const label = placeholderLabel(node).replace(/[[\]\n]/g, "");
  const scheme = MEDIA_TYPES.has(node.type) ? "tikmedia" : "tikadf";
  const encoded = Buffer.from(JSON.stringify(node)).toString("base64");
  return `![${label}](${scheme}:${encoded})`;
}

/**
 * Build a tikmedia placeholder string for a newly uploaded attachment,
 * given the media-service id, issue id (for collection), and filename.
 * The result can be pasted directly into markdown that will become a
 * comment or description, and the round-trip (markdownToAdf) will
 * produce a valid media ADF node.
 *
 * @param width Optional display width as a percentage of column (1-100).
 *   Omit or pass 0 for Jira's default sizing.
 * @returns The tikmedia token, or null if mediaId is empty (i.e. the
 *   attachment lacks a media-service entry).
 */
export function makeMediaPlaceholder(mediaId: string, issueId: string, filename: string, width?: number): string | null {
  if (!mediaId) return null;
  const attrs: Record<string, unknown> = {
    id: mediaId,
    type: "file",
    collection: `contentId-${issueId}`,
    alt: filename,
  };
  // `layout` is required on mediaSingle — Jira rejects the whole comment with
  // INVALID_INPUT if `width` is present without it.
  const mediaSingleAttrs: Record<string, unknown> = { layout: "center" };
  if (width && width > 0 && width <= 100) {
    mediaSingleAttrs.width = width;
  }
  const node: AdfNode = {
    type: "mediaSingle",
    attrs: mediaSingleAttrs,
    content: [
      {
        type: "media",
        attrs,
      },
    ],
  };
  return encodePlaceholder(node);
}

export function decodeMediaPlaceholder(base64: string): AdfNode | null {
  try {
    return JSON.parse(Buffer.from(base64, "base64").toString("utf-8"));
  } catch {
    return null;
  }
}

const PLACEHOLDER_RE = /^!\[[^\]]*\]\((?:tikmedia|tikadf):([A-Za-z0-9+/=]+)\)$/;
const PLACEHOLDER_INLINE_RE = /^!\[[^\]]*\]\((?:tikmedia|tikadf):([A-Za-z0-9+/=]+)\)/;

function parseInline(text: string): AdfNode[] {
  const nodes: AdfNode[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    // Hard line break embedded by paragraph-joining (see collectParagraphText)
    if (remaining[0] === "\n") {
      nodes.push({ type: "hardBreak" });
      remaining = remaining.slice(1);
      continue;
    }

    // Opaque node placeholder: ![label](tikmedia:<base64>) or ![label](tikadf:<base64>)
    const placeholderMatch = remaining.match(PLACEHOLDER_INLINE_RE);
    if (placeholderMatch) {
      const node = decodeMediaPlaceholder(placeholderMatch[1]);
      if (node) {
        nodes.push(node);
        remaining = remaining.slice(placeholderMatch[0].length);
        continue;
      }
    }

    // Link: [text](url)
    const linkMatch = remaining.match(/^\[([^\]]+)\]\(([^)]+)\)/);
    if (linkMatch) {
      nodes.push({
        type: "text",
        text: linkMatch[1],
        marks: [{ type: "link", attrs: { href: linkMatch[2] } }],
      });
      remaining = remaining.slice(linkMatch[0].length);
      continue;
    }

    // Bold: **text** or __text__
    const boldMatch = remaining.match(/^(\*\*|__)(.+?)\1/);
    if (boldMatch) {
      nodes.push({ type: "text", text: boldMatch[2], marks: [{ type: "strong" }] });
      remaining = remaining.slice(boldMatch[0].length);
      continue;
    }

    // Italic: *text* or _text_ (underscores only at word boundaries, so snake_case stays literal)
    const italicMatch = remaining.match(/^\*([^*_]+)\*|^_([^*_]+)_(?!\w)/);
    const atWordStart = !/\w/.test(text[text.length - remaining.length - 1] ?? "");
    if (italicMatch && (italicMatch[1] !== undefined || atWordStart)) {
      nodes.push({ type: "text", text: italicMatch[1] ?? italicMatch[2], marks: [{ type: "em" }] });
      remaining = remaining.slice(italicMatch[0].length);
      continue;
    }

    // Inline code: `code`
    const codeMatch = remaining.match(/^`([^`]+)`/);
    if (codeMatch) {
      nodes.push({ type: "text", text: codeMatch[1], marks: [{ type: "code" }] });
      remaining = remaining.slice(codeMatch[0].length);
      continue;
    }

    // Strikethrough: ~~text~~
    const strikeMatch = remaining.match(/^~~(.+?)~~/);
    if (strikeMatch) {
      nodes.push({ type: "text", text: strikeMatch[1], marks: [{ type: "strike" }] });
      remaining = remaining.slice(strikeMatch[0].length);
      continue;
    }

    // Plain text until next special char (stop before "!" too, so a leading "!["
    // media placeholder on the next loop iteration isn't consumed as plain text;
    // stop before "\n" so embedded hard breaks are handled above)
    const plainMatch = remaining.match(/^[^[*_`~!\n]+/);
    if (plainMatch) {
      nodes.push({ type: "text", text: plainMatch[0] });
      remaining = remaining.slice(plainMatch[0].length);
      continue;
    }

    // Single special char that didn't match a pattern
    nodes.push({ type: "text", text: remaining[0] });
    remaining = remaining.slice(1);
  }

  return nodes;
}

function parseBlocks(text: string): AdfNode[] {
  const blocks: AdfNode[] = [];
  let inline: AdfNode[] = [];
  const flush = () => {
    if (inline.length > 0) blocks.push({ type: "paragraph", content: inline });
    inline = [];
  };
  for (const node of parseInline(text)) {
    if (INLINE_TYPES.has(node.type)) {
      inline.push(node);
    } else {
      flush();
      blocks.push(node);
    }
  }
  flush();
  return blocks;
}

function parseBlocksOrEmpty(text: string): AdfNode[] {
  const blocks = parseBlocks(text);
  return blocks.length > 0 ? blocks : [{ type: "paragraph", content: [] }];
}

const LIST_ITEM_RE = /^(\s*)([-*]|\d+\.)\s+(.*)$/;

function parseList(lines: string[], start: number): { node: AdfNode; nextIndex: number } {
  const [, indent, marker] = lines[start].match(LIST_ITEM_RE)!;
  const ordered = /\d/.test(marker);
  const items: AdfNode[] = [];
  let i = start;
  while (i < lines.length) {
    const match = lines[i].match(LIST_ITEM_RE);
    if (!match || match[1].length < indent.length) break;
    if (match[1].length > indent.length) {
      const nested = parseList(lines, i);
      items[items.length - 1].content!.push(nested.node);
      i = nested.nextIndex;
      continue;
    }
    if (/\d/.test(match[2]) !== ordered) break;
    items.push({ type: "listItem", content: parseBlocksOrEmpty(match[3]) });
    i++;
  }
  return { node: { type: ordered ? "orderedList" : "bulletList", content: items }, nextIndex: i };
}

// True when a line starts a block type handled elsewhere in markdownToAdf (or is
// blank) — i.e. it should end a run of paragraph lines rather than joining it.
function isParagraphBreak(line: string): boolean {
  return (
    line.trim() === "" ||
    line.startsWith("```") ||
    /^(#{1,6})\s+(.+)$/.test(line) ||
    PLACEHOLDER_RE.test(line.trim()) ||
    line.startsWith("> ") ||
    (line.includes("|") && line.trim().startsWith("|")) ||
    /^[-*]\s+\[([ x])\]\s/.test(line) ||
    /^[-*]\s+/.test(line) ||
    /^\d+\.\s+/.test(line)
  );
}

// Markdown soft-wraps (a single newline within a paragraph) render as a space;
// a line ending in two-or-more trailing spaces forces a hard line break.
function collectParagraphText(lines: string[], startIndex: number): { text: string; nextIndex: number } {
  let i = startIndex;
  const paraLines: string[] = [];
  while (i < lines.length && !isParagraphBreak(lines[i])) {
    paraLines.push(lines[i]);
    i++;
  }
  let text = paraLines[0]?.replace(/[ \t]+$/, "") ?? "";
  for (let idx = 1; idx < paraLines.length; idx++) {
    const prevIsHardBreak = /  $/.test(paraLines[idx - 1]);
    text += (prevIsHardBreak ? "\n" : " ") + paraLines[idx].replace(/[ \t]+$/, "");
  }
  return { text, nextIndex: i };
}

export function markdownToAdf(markdown: string): AdfNode {
  const lines = markdown.split("\n");
  const content: AdfNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Code block
    if (line.startsWith("```")) {
      const lang = line.slice(3).trim() || undefined;
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) {
        codeLines.push(lines[i]);
        i++;
      }
      const code = codeLines.join("\n");
      content.push({
        type: "codeBlock",
        attrs: lang ? { language: lang } : {},
        content: code ? [{ type: "text", text: code }] : [],
      });
      i++;
      continue;
    }

    // Header
    const headerMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headerMatch) {
      content.push({
        type: "heading",
        attrs: { level: headerMatch[1].length },
        content: parseInline(headerMatch[2]),
      });
      i++;
      continue;
    }

    // Opaque node placeholder on its own line
    if (PLACEHOLDER_RE.test(line.trim())) {
      content.push(...parseBlocks(line.trim()));
      i++;
      continue;
    }

    // Blockquote
    if (line.startsWith("> ")) {
      const quoteLines: string[] = [];
      while (i < lines.length && lines[i].startsWith("> ")) {
        quoteLines.push(lines[i].slice(2).replace(/[ \t]+$/, ""));
        i++;
      }
      content.push({ type: "blockquote", content: parseBlocksOrEmpty(quoteLines.join("\n")) });
      continue;
    }

    // Table
    if (line.includes("|") && line.trim().startsWith("|")) {
      const tableRows: AdfNode[] = [];
      let isHeader = true;
      while (i < lines.length && lines[i].includes("|")) {
        const rowLine = lines[i].trim();
        // Skip separator line
        if (/^\|[-:\s|]+\|$/.test(rowLine)) {
          i++;
          isHeader = false;
          continue;
        }
        const cells = rowLine.split("|").slice(1, -1).map(c => c.trim());
        const cellType = isHeader ? "tableHeader" : "tableCell";
        tableRows.push({
          type: "tableRow",
          content: cells.map(cell => ({
            type: cellType,
            content: parseBlocksOrEmpty(cell),
          })),
        });
        i++;
        isHeader = false;
      }
      content.push({ type: "table", content: tableRows });
      continue;
    }

    // Checklist (task list): - [ ] or - [x]
    if (/^[-*]\s+\[([ x])\]\s/.test(line)) {
      const taskItems: AdfNode[] = [];
      while (i < lines.length && /^[-*]\s+\[([ x])\]\s/.test(lines[i])) {
        const match = lines[i].match(/^[-*]\s+\[([ x])\]\s+(.*)$/);
        if (match) {
          taskItems.push({
            type: "taskItem",
            attrs: { localId: crypto.randomUUID(), state: match[1] === "x" ? "DONE" : "TODO" },
            content: parseInline(match[2]),
          });
        }
        i++;
      }
      content.push({
        type: "taskList",
        attrs: { localId: crypto.randomUUID() },
        content: taskItems,
      });
      continue;
    }

    // Bullet or ordered list
    if (/^([-*]|\d+\.)\s+/.test(line)) {
      const { node, nextIndex } = parseList(lines, i);
      content.push(node);
      i = nextIndex;
      continue;
    }

    // Empty line
    if (line.trim() === "") {
      i++;
      continue;
    }

    // Regular paragraph — join consecutive soft-wrapped lines into one block
    const { text, nextIndex } = collectParagraphText(lines, i);
    content.push(...parseBlocks(text));
    i = nextIndex;
  }

  return { type: "doc", version: 1, content } as AdfNode;
}

/** `preserveUnknown` encodes nodes markdown cannot express as `tikadf:` placeholders, for edit round trips. */
export function adfToMarkdown(adf: AdfNode | null | undefined, options: { preserveUnknown?: boolean } = {}): string {
  if (!adf) return "";

  const lines: string[] = [];

  /** Blocks must be blank-line separated, or a following paragraph is absorbed as list continuation. */
  function endBlock(): void {
    if (lines.length > 0 && lines[lines.length - 1] !== "") lines.push("");
  }

  function processNode(node: AdfNode, indent: string = ""): void {
    switch (node.type) {
      case "doc":
        if (node.content) {
          for (const child of node.content) {
            processNode(child, indent);
          }
        }
        break;

      case "paragraph":
        if (node.content) {
          const text = node.content.map(extractText).join("");
          if (text.trim()) lines.push(...text.split("\n").map((line) => indent + line));
        }
        lines.push("");
        break;

      case "heading":
        if (node.content) {
          const level = (node.attrs?.level as number) || 1;
          const prefix = "#".repeat(level) + " ";
          const text = node.content.map(extractText).join("");
          endBlock();
          lines.push(indent + prefix + text);
          lines.push("");
        }
        break;

      case "bulletList":
        if (node.content) {
          for (const item of node.content) {
            processListItem(item, indent, "- ");
          }
          if (!indent) endBlock();
        }
        break;

      case "orderedList":
        if (node.content) {
          let num = 1;
          for (const item of node.content) {
            processListItem(item, indent, `${num}. `);
            num++;
          }
          if (!indent) endBlock();
        }
        break;

      case "taskList":
        if (node.content) {
          for (const item of node.content) {
            processNode(item, indent);
          }
          endBlock();
        }
        break;

      case "taskItem":
        if (node.content) {
          const check = node.attrs?.state === "DONE" ? "x" : " ";
          const text = node.content.map(extractText).join("");
          lines.push(`${indent}- [${check}] ${text}`);
        }
        break;

      case "codeBlock": {
        const lang = (node.attrs?.language as string) || "";
        const text = (node.content ?? []).map(extractText).join("");
        lines.push(indent + "```" + lang);
        if (text) lines.push(...text.split("\n").map((line) => indent + line));
        lines.push(indent + "```");
        lines.push("");
        break;
      }

      case "blockquote":
        if (node.content) {
          for (const child of node.content) {
            const savedLines = lines.length;
            processNode(child, "");
            for (let i = savedLines; i < lines.length; i++) {
              if (lines[i]) lines[i] = indent + "> " + lines[i];
            }
          }
        }
        break;

      case "table":
        if (node.content) {
          let isFirstRow = true;
          for (const row of node.content) {
            if (row.type === "tableRow" && row.content) {
              const cells = row.content.map((cell) => (cell.content ?? []).map(extractText).join(" "));
              lines.push(indent + "| " + cells.join(" | ") + " |");
              if (isFirstRow) {
                lines.push(indent + "| " + cells.map(() => "---").join(" | ") + " |");
                isFirstRow = false;
              }
            }
          }
          lines.push("");
        }
        break;

      case "rule":
        lines.push(indent + "---");
        lines.push("");
        break;

      default:
        if (options.preserveUnknown || MEDIA_TYPES.has(node.type)) {
          lines.push(indent + encodePlaceholder(node));
        } else if (node.content) {
          for (const child of node.content) processNode(child, indent);
        } else if (readableText(node)) {
          lines.push(indent + readableText(node));
        }
        lines.push("");
    }
  }

  function processListItem(node: AdfNode, indent: string, prefix: string): void {
    const [first, ...rest] = node.content ?? [];
    lines.push(indent + prefix + (first ? extractText(first) : ""));
    for (const child of rest) {
      processNode(child, indent + " ".repeat(prefix.length));
    }
  }

  function extractText(node: AdfNode): string {
    if (node.type === "text") {
      let text = node.text || "";
      if (node.marks) {
        for (const mark of node.marks) {
          switch (mark.type) {
            case "strong": text = `**${text}**`; break;
            case "em": text = `*${text}*`; break;
            case "code": text = `\`${text}\``; break;
            case "strike": text = `~~${text}~~`; break;
            case "link": text = `[${text}](${mark.attrs?.href})`; break;
          }
        }
      }
      return text;
    }
    if (node.type === "hardBreak") {
      return "  \n";
    }
    if (node.type === "emoji") {
      return (node.attrs?.shortName as string) || "";
    }
    if (node.type === "paragraph" || node.type === "heading") {
      return (node.content ?? []).map(extractText).join("");
    }
    if (options.preserveUnknown || MEDIA_TYPES.has(node.type)) {
      return encodePlaceholder(node);
    }
    return node.content ? node.content.map(extractText).join("") : readableText(node);
  }

  processNode(adf);

  return lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// --- Jira Wiki Markup → Markdown ---

function convertWikiInline(text: string): string {
  // 1. Strip {color:...}...{color} pairs, then any remaining lone {color} tags
  text = text.replace(/\{color[^}]*\}([\s\S]*?)\{color\}/g, "$1");
  text = text.replace(/\{color[^}]*\}/g, "");
  // 2. Strip {anchor:...}
  text = text.replace(/\{anchor:[^}]*\}/g, "");
  // 3. {{monospace}} → `monospace` (before other curly-brace patterns)
  text = text.replace(/\{\{(.+?)\}\}/g, "`$1`");
  // 4. [text|url|smart-link] or [text|url] → [text](url)
  text = text.replace(/\[([^|\]]+)\|([^|\]]+?)(?:\|[^\]]*?)?\]/g, "[$1]($2)");
  // 5. [url] bare links → just the URL
  text = text.replace(/\[(https?:\/\/[^\]]+)\]/g, "$1");
  // 6. !image.png|opts! or !image.png! → strip (images can't render in terminal)
  text = text.replace(/!([^!\s]+?)(?:\|[^!]*)?!/g, "");
  // 7. *bold* → **bold** (not at line start to avoid list markers, require non-space after/before *)
  text = text.replace(/(?<=^|[\s(])\*(\S(?:[^*]*?\S)?)\*(?=[\s).,;:!?]|$)/g, "**$1**");
  // 8. _italic_ → *italic*
  text = text.replace(/(?<=^|[\s(])_(\S(?:[^_]*?\S)?)_(?=[\s).,;:!?]|$)/g, "*$1*");
  // 9. -strikethrough- → ~~strikethrough~~
  text = text.replace(/(?<=^|[\s(])-(\S(?:[^-]*?\S)?)-(?=[\s).,;:!?]|$)/g, "~~$1~~");
  // 10. +underline+ → **underline** (no md equivalent)
  text = text.replace(/(?<=^|[\s(])\+(\S(?:[^+]*?\S)?)\+(?=[\s).,;:!?]|$)/g, "**$1**");
  // 11. ^super^ / ~sub~ → strip markers
  text = text.replace(/\^([^^]+)\^/g, "$1");
  text = text.replace(/(?<!~)~([^~]+)~(?!~)/g, "$1");
  // 12. \\ → newline
  text = text.replace(/\\\\/g, "\n");
  return text;
}

type WikiBlockState = "normal" | "code" | "panel" | "quote";

export function jiraWikiToMarkdown(wiki: string): string {
  if (!wiki) return "";
  const inputLines = wiki.split("\n");
  const output: string[] = [];
  let state: WikiBlockState = "normal";
  let codeEndTag = "";

  function pushCode(text: string): void {
    const end = text.indexOf(codeEndTag);
    if (end === -1) {
      output.push(text);
      return;
    }
    if (end > 0) output.push(text.slice(0, end));
    output.push("```");
    state = "normal";
  }

  for (const rawLine of inputLines) {
    const line = rawLine;

    // --- State: inside {code} or {noformat}
    if (state === "code") {
      pushCode(line);
      continue;
    }

    // --- State: inside {panel}
    if (state === "panel") {
      if (/^\{panel\}/.test(line)) {
        state = "normal";
      } else {
        output.push("> " + convertWikiInline(line));
      }
      continue;
    }

    // --- State: inside {quote}
    if (state === "quote") {
      if (/^\{quote\}/.test(line)) {
        state = "normal";
      } else {
        output.push("> " + convertWikiInline(line));
      }
      continue;
    }

    // --- Normal state: detect block openers ---

    // {code:lang}, {code} or {noformat}, possibly closed on the same line
    const codeMatch = line.match(/^\{(code|noformat)(?::([^}]*))?\}(.*)$/);
    if (codeMatch) {
      const [, tag, lang, rest] = codeMatch;
      codeEndTag = `{${tag}}`;
      output.push("```" + (tag === "code" && lang ? lang : ""));
      state = "code";
      if (rest) pushCode(rest);
      continue;
    }

    // {panel} / {panel:...}
    if (/^\{panel(?::[^}]*)?\}/.test(line)) {
      state = "panel";
      continue;
    }

    // {quote}
    if (/^\{quote\}/.test(line)) {
      state = "quote";
      continue;
    }

    // Headings: h1. through h6.
    const headingMatch = line.match(/^h([1-6])\.\s+(.*)/);
    if (headingMatch) {
      const level = parseInt(headingMatch[1], 10);
      output.push("#".repeat(level) + " " + convertWikiInline(headingMatch[2]));
      continue;
    }

    // bq. blockquote
    const bqMatch = line.match(/^bq\.\s+(.*)/);
    if (bqMatch) {
      output.push("> " + convertWikiInline(bqMatch[1]));
      continue;
    }

    // Horizontal rule
    if (/^----\s*$/.test(line)) {
      output.push("---");
      continue;
    }

    // Table header row: ||h||h||
    const tableHeaderMatch = line.match(/^\|\|(.+)\|\|\s*$/);
    if (tableHeaderMatch) {
      const cells = tableHeaderMatch[1].split("||").map(c => c.trim());
      output.push("| " + cells.map(c => convertWikiInline(c)).join(" | ") + " |");
      output.push("| " + cells.map(() => "---").join(" | ") + " |");
      continue;
    }

    // Table data row: |c|c|
    const tableDataMatch = line.match(/^\|(.+)\|\s*$/);
    if (tableDataMatch && !line.startsWith("||")) {
      const cells = tableDataMatch[1].split("|").map(c => c.trim());
      output.push("| " + cells.map(c => convertWikiInline(c)).join(" | ") + " |");
      continue;
    }

    // Unordered list: * / ** / ***
    const ulMatch = line.match(/^(\*+)\s+(.*)/);
    if (ulMatch) {
      const depth = ulMatch[1].length - 1;
      output.push("  ".repeat(depth) + "- " + convertWikiInline(ulMatch[2]));
      continue;
    }

    // Ordered list: # / ## / ###
    const olMatch = line.match(/^(#+)\s+(.*)/);
    if (olMatch) {
      const depth = olMatch[1].length - 1;
      output.push("  ".repeat(depth) + "1. " + convertWikiInline(olMatch[2]));
      continue;
    }

    // Regular line — apply inline conversions
    output.push(convertWikiInline(line));
  }

  return output
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
