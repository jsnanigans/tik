export type AdfNode = {
  type: string;
  content?: AdfNode[];
  text?: string;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
  attrs?: Record<string, unknown>;
};

// ADF nodes markdown cannot express round-trip as base64 image placeholders (`tikmedia:`/`tikadf:`).
const MEDIA_TYPES = new Set(["mediaSingle", "mediaGroup", "media", "mediaInline"]);

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

export function encodePlaceholder(node: AdfNode): string {
  const label = placeholderLabel(node).replace(/[[\]\\`\n]/g, "");
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
