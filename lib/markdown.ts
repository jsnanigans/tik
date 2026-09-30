export type AdfNode = {
  type: string;
  content?: AdfNode[];
  text?: string;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
  attrs?: Record<string, unknown>;
};

// --- Media (image) round-trip support ---
//
// ADF media nodes (mediaSingle/mediaGroup/media/mediaInline) reference Confluence-hosted
// attachments by opaque id + collection; there's no way to synthesize a valid one from
// scratch, and no public URL to render. Instead of dropping them, encode the exact original
// node as a base64 blob inside a markdown image placeholder — visible as a placeholder when
// read, and losslessly reconstructed on the way back to ADF so editing unrelated text and
// re-uploading never strips a page's images.
function encodeMediaPlaceholder(node: AdfNode): string {
  let alt: string;
  if (node.type === "mediaGroup") {
    alt = (node.content ?? []).map((c) => (c.attrs?.alt as string) || "file").join(", ");
  } else {
    const media =
      node.content?.find((c) => c.type === "media") ??
      (node.type === "media" || node.type === "mediaInline" ? node : undefined);
    alt = (media?.attrs?.alt as string) || "image";
  }
  const encoded = Buffer.from(JSON.stringify(node)).toString("base64");
  return `![image: ${alt}](tikmedia:${encoded})`;
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
  return encodeMediaPlaceholder(node);
}

export function decodeMediaPlaceholder(base64: string): AdfNode | null {
  try {
    return JSON.parse(Buffer.from(base64, "base64").toString("utf-8"));
  } catch {
    return null;
  }
}

const MEDIA_PLACEHOLDER_RE = /^!\[image:[^\]]*\]\(tikmedia:([A-Za-z0-9+/=]+)\)$/;
const MEDIA_PLACEHOLDER_INLINE_RE = /^!\[image:[^\]]*\]\(tikmedia:([A-Za-z0-9+/=]+)\)/;

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

    // Media placeholder: ![image: alt](tikmedia:<base64>)
    const mediaInlineMatch = remaining.match(MEDIA_PLACEHOLDER_INLINE_RE);
    if (mediaInlineMatch) {
      const node = decodeMediaPlaceholder(mediaInlineMatch[1]);
      if (node) {
        nodes.push(node);
        remaining = remaining.slice(mediaInlineMatch[0].length);
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

    // Italic: *text* or _text_
    const italicMatch = remaining.match(/^(\*|_)([^*_]+)\1/);
    if (italicMatch) {
      nodes.push({ type: "text", text: italicMatch[2], marks: [{ type: "em" }] });
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

  return nodes.length > 0 ? nodes : [{ type: "text", text: "" }];
}

// True when a line starts a block type handled elsewhere in markdownToAdf (or is
// blank) — i.e. it should end a run of paragraph lines rather than joining it.
function isParagraphBreak(line: string): boolean {
  return (
    line.trim() === "" ||
    line.startsWith("```") ||
    /^(#{1,6})\s+(.+)$/.test(line) ||
    MEDIA_PLACEHOLDER_RE.test(line.trim()) ||
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
      content.push({
        type: "codeBlock",
        attrs: lang ? { language: lang } : {},
        content: [{ type: "text", text: codeLines.join("\n") }],
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

    // Media placeholder (image), on its own line: ![image: alt](tikmedia:<base64>)
    const mediaBlockMatch = line.trim().match(MEDIA_PLACEHOLDER_RE);
    if (mediaBlockMatch) {
      const node = decodeMediaPlaceholder(mediaBlockMatch[1]);
      if (node) {
        content.push(node);
        i++;
        continue;
      }
    }

    // Blockquote
    if (line.startsWith("> ")) {
      const quoteLines: string[] = [];
      while (i < lines.length && lines[i].startsWith("> ")) {
        quoteLines.push(lines[i].slice(2));
        i++;
      }
      content.push({
        type: "blockquote",
        content: [{ type: "paragraph", content: parseInline(quoteLines.join("\n")) }],
      });
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
            content: [{ type: "paragraph", content: parseInline(cell) }],
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

    // Unordered list
    if (/^[-*]\s+/.test(line)) {
      const listItems: AdfNode[] = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i])) {
        const itemText = lines[i].replace(/^[-*]\s+/, "");
        listItems.push({
          type: "listItem",
          content: [{ type: "paragraph", content: parseInline(itemText) }],
        });
        i++;
      }
      content.push({ type: "bulletList", content: listItems });
      continue;
    }

    // Ordered list
    if (/^\d+\.\s+/.test(line)) {
      const listItems: AdfNode[] = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i])) {
        const itemText = lines[i].replace(/^\d+\.\s+/, "");
        listItems.push({
          type: "listItem",
          content: [{ type: "paragraph", content: parseInline(itemText) }],
        });
        i++;
      }
      content.push({ type: "orderedList", content: listItems });
      continue;
    }

    // Empty line
    if (line.trim() === "") {
      i++;
      continue;
    }

    // Regular paragraph — join consecutive soft-wrapped lines into one block
    const { text, nextIndex } = collectParagraphText(lines, i);
    content.push({ type: "paragraph", content: parseInline(text) });
    i = nextIndex;
  }

  return { type: "doc", version: 1, content } as AdfNode;
}

export function adfToMarkdown(adf: AdfNode | null | undefined): string {
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
          if (text.trim()) lines.push(indent + text);
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
            processNode(item, indent);
          }
          endBlock();
        }
        break;

      case "orderedList":
        if (node.content) {
          let num = 1;
          for (const item of node.content) {
            processListItem(item, indent, `${num}. `);
            num++;
          }
          endBlock();
        }
        break;

      case "listItem":
        if (node.content) {
          const firstPara = node.content[0];
          if (firstPara?.content) {
            const text = firstPara.content.map(extractText).join("");
            lines.push(indent + "- " + text);
          }
          for (const child of node.content.slice(1)) {
            processNode(child, indent + "  ");
          }
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

      case "codeBlock":
        if (node.content) {
          const lang = (node.attrs?.language as string) || "";
          lines.push(indent + "```" + lang);
          const text = node.content.map(extractText).join("");
          for (const line of text.split("\n")) {
            lines.push(indent + line);
          }
          lines.push(indent + "```");
          lines.push("");
        }
        break;

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
              const cells = row.content.map((cell) => {
                if (cell.content) {
                  return cell.content
                    .map((p) => (p.content ? p.content.map(extractText).join("") : ""))
                    .join(" ");
                }
                return "";
              });
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

      case "mediaSingle":
      case "mediaGroup":
      case "media":
        lines.push(indent + encodeMediaPlaceholder(node));
        lines.push("");
        break;

      case "hardBreak":
        break;

      case "rule":
        lines.push(indent + "---");
        lines.push("");
        break;

      default:
        if (node.content) {
          for (const child of node.content) {
            processNode(child, indent);
          }
        }
    }
  }

  function processListItem(node: AdfNode, indent: string, prefix: string): void {
    if (node.content) {
      const firstPara = node.content[0];
      if (firstPara?.content) {
        const text = firstPara.content.map(extractText).join("");
        lines.push(indent + prefix + text);
      }
      for (const child of node.content.slice(1)) {
        processNode(child, indent + "   ");
      }
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
      return "\n";
    }
    if (node.type === "mention") {
      return "@" + ((node.attrs?.text as string) || "user");
    }
    if (node.type === "emoji") {
      return (node.attrs?.shortName as string) || "";
    }
    if (node.type === "inlineCard" || node.type === "link") {
      return (node.attrs?.url as string) || "";
    }
    if (node.type === "mediaInline" || node.type === "media") {
      return encodeMediaPlaceholder(node);
    }
    if (node.content) {
      return node.content.map(extractText).join("");
    }
    return "";
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
  text = text.replace(/~([^~]+)~/g, "$1");
  // 12. \\ → newline
  text = text.replace(/\\\\/g, "\n");
  return text;
}

type WikiBlockState = "normal" | "code" | "noformat" | "panel" | "quote";

export function jiraWikiToMarkdown(wiki: string): string {
  if (!wiki) return "";
  const inputLines = wiki.split("\n");
  const output: string[] = [];
  let state: WikiBlockState = "normal";
  let codeLang = "";

  for (const rawLine of inputLines) {
    const line = rawLine;

    // --- State: inside {code}
    if (state === "code") {
      if (/^\{code\}/.test(line)) {
        output.push("```");
        state = "normal";
      } else {
        output.push(line);
      }
      continue;
    }

    // --- State: inside {noformat}
    if (state === "noformat") {
      if (/^\{noformat\}/.test(line)) {
        output.push("```");
        state = "normal";
      } else {
        output.push(line);
      }
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

    // {code:lang} or {code}
    const codeMatch = line.match(/^\{code(?::([^}]*))?\}/);
    if (codeMatch) {
      codeLang = codeMatch[1] || "";
      output.push("```" + codeLang);
      state = "code";
      continue;
    }

    // {noformat}
    if (/^\{noformat\}/.test(line)) {
      output.push("```");
      state = "noformat";
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
