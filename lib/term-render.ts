import boxes from "cli-boxes";
import sliceAnsi from "slice-ansi";
import stringWidth from "string-width";
import wrapAnsi from "wrap-ansi";
import type { Root } from "mdast";
import { adfToMdast, directiveInfo, markdownToMdast, type Directive } from "./adf-codec";
import { decodeMediaPlaceholder, type AdfNode } from "./markdown";
import { headerStyle, renderTable, type TableCell } from "./term-table";
import {
  BAR, BLUE, CODE_BG, CYAN, PANEL, STATUS,
  createPainter, detectColorDepth, detectTheme, hyperlink, parseHex, readableOn,
  type ColorDepth, type Painter, type Style, type Theme,
} from "./term-style";

/** A media node found in a document, as an image provider needs it. */
export type MediaRef = { name: string; id?: string; collection?: string; widthPct?: number; layout?: string };
/** Returns the lines of an inline image for `ref` at most `width` cells wide, or nothing to fall back to the placeholder line. */
export type ImageProvider = { render: (ref: MediaRef, width: number) => string[] | undefined };

export type RenderOptions = { width: number; color: ColorDepth; theme: Theme; links: boolean; images: ImageProvider | null };

type MNode = {
  type: string;
  name?: string;
  value?: string;
  url?: string;
  alt?: string | null;
  lang?: string | null;
  depth?: number;
  ordered?: boolean | null;
  start?: number | null;
  spread?: boolean | null;
  checked?: boolean | null;
  align?: (string | null)[] | null;
  attributes?: Record<string, string | null | undefined>;
  children?: MNode[];
};

type Ctx = { o: RenderOptions; p: Painter; base: Style; level: number };

const BULLETS = ["•", "◦", "‣"];
const NBSP = " ";
const FLAGS = ["bold", "dim", "italic", "underline", "strike"] as const;
const SUPERSCRIPT: Record<string, string> = { ...Object.fromEntries([..."0123456789"].map((c, i) => [c, "⁰¹²³⁴⁵⁶⁷⁸⁹"[i]])), "+": "⁺", "-": "⁻", "=": "⁼", "(": "⁽", ")": "⁾", n: "ⁿ", i: "ⁱ" };
const SUBSCRIPT: Record<string, string> = {
  ...Object.fromEntries([..."0123456789"].map((c, i) => [c, "₀₁₂₃₄₅₆₇₈₉"[i]])),
  "+": "₊", "-": "₋", "=": "₌", "(": "₍", ")": "₎", a: "ₐ", e: "ₑ", o: "ₒ", x: "ₓ", h: "ₕ", k: "ₖ", l: "ₗ", m: "ₘ", n: "ₙ", p: "ₚ", s: "ₛ", t: "ₜ",
};
const PLACEHOLDER = /^(?:tikmedia|tikadf):([A-Za-z0-9+/=]+)$/;
const RAW_PLACEHOLDER = /^!\[[^\]]*\]\(((?:tikmedia|tikadf):[A-Za-z0-9+/=]+)\)$/;
const MEDIA_ICONS: [RegExp, string][] = [[/\.(png|jpe?g|gif|webp|svg|bmp|heic)$/i, "▣"], [/\.(mov|mp4|webm|mkv|avi)$/i, "►"]];

export function resolveOptions(partial: Partial<RenderOptions> = {}, env: Record<string, string | undefined> = process.env): RenderOptions {
  const color = partial.color ?? detectColorDepth(env);
  return {
    width: partial.width ?? (process.stdout.columns || 100) - 4,
    color,
    theme: partial.theme ?? detectTheme(env),
    links: (partial.links ?? process.stdout.isTTY === true) && color !== "none",
    images: partial.images ?? null,
  };
}

// ---------- helpers ----------

const merge = (a: Style, b: Style): Style => {
  const out: Style = { ...a, ...b };
  for (const flag of FLAGS) out[flag] = a[flag] || b[flag];
  return out;
};

/** Control characters from ticket text must not reach the terminal as escape sequences. */
const clean = (text: string) => text.replace(/\t/g, "    ").replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, "");
const safeUrl = (url: string) => url.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").replace(/ /g, "%20");

const wrap = (text: string, width: number): string[] =>
  wrapAnsi(text, Math.max(1, width), { hard: true, trim: true }).split("\n").map((line) => line.replaceAll(NBSP, " "));

const fill = (ctx: Ctx, count: number) => (count > 0 ? ctx.p.paint(" ".repeat(count), ctx.base) : "");
const dim = (ctx: Ctx, text: string) => ctx.p.paint(text, merge(ctx.base, { dim: true }));

function prefixed(lines: string[], first: string, rest: string): string[] {
  return (lines.length > 0 ? lines : [""]).map((line, index) => (index === 0 ? first : rest) + line);
}

function plainText(nodes: MNode[] = []): string {
  return nodes.map((node) => (node.type === "break" ? "\n" : (node.value ?? plainText(node.children)))).join("");
}

const placeholderOf = (url: string): AdfNode | null => {
  const match = url.match(PLACEHOLDER);
  return match ? decodeMediaPlaceholder(match[1]) : null;
};

/** The ADF node behind a media placeholder written as an image (markdown) or as a raw node (the codec's mdast). */
function mediaNodeOf(node: MNode): AdfNode | null {
  if (node.type === "image") return placeholderOf(node.url ?? "");
  const raw = node.type === "raw" ? node.value?.match(RAW_PLACEHOLDER) : null;
  return raw ? placeholderOf(raw[1]) : null;
}

const BLOCK_MEDIA = new Set(["mediaSingle", "mediaGroup"]);

// ---------- media ----------

function refsOfAdf(node: AdfNode): MediaRef[] {
  const single = node.type === "mediaSingle" ? node : undefined;
  const medias = node.type === "media" || node.type === "mediaInline" ? [node] : (node.content ?? []).filter((child) => child.type === "media");
  return medias.map((media) => {
    const attrs = media.attrs ?? {};
    return {
      name: String(attrs.alt || attrs.id || "file"),
      id: typeof attrs.id === "string" ? attrs.id : undefined,
      collection: typeof attrs.collection === "string" ? attrs.collection : undefined,
      widthPct: typeof single?.attrs?.width === "number" ? single.attrs.width : undefined,
      layout: typeof single?.attrs?.layout === "string" ? single.attrs.layout : undefined,
    };
  });
}

function refOfDirective(node: MNode, attrs: Record<string, unknown>): MediaRef {
  const label = plainText(node.children);
  return {
    name: label || String(attrs._id || "file"),
    id: typeof attrs._id === "string" ? attrs._id : undefined,
    collection: typeof attrs.collection === "string" ? attrs.collection : undefined,
    widthPct: typeof attrs.width === "number" ? attrs.width : undefined,
    layout: typeof attrs.layout === "string" ? attrs.layout : undefined,
  };
}

const placeholderLine = (ref: MediaRef) => `${MEDIA_ICONS.find(([pattern]) => pattern.test(ref.name))?.[1] ?? "▤"} ${clean(ref.name)}`;

function mediaBlock(refs: MediaRef[], ctx: Ctx, width: number): string[] {
  return refs.flatMap((ref) => ctx.o.images?.render(ref, width) ?? wrap(dim(ctx, placeholderLine(ref)), width));
}

// ---------- inline ----------

function linkText(url: string, text: string, label: string, ctx: Ctx): string {
  const href = safeUrl(url);
  if (ctx.o.links) return hyperlink(text, href);
  return label === url || !href ? text : `${text} ${dim(ctx, `(${href})`)}`;
}

function script(text: string, table: Record<string, string>): string | null {
  const chars = [...text];
  return chars.every((char) => table[char]) ? chars.map((char) => table[char]).join("") : null;
}

function inline(nodes: MNode[], ctx: Ctx, style: Style): string {
  return nodes.map((node) => inlineNode(node, ctx, style)).join("");
}

const run = (ctx: Ctx, text: string, style: Style) => (text ? ctx.p.paint(clean(text), merge(ctx.base, style)) : "");

function inlineNode(node: MNode, ctx: Ctx, style: Style): string {
  const children = node.children ?? [];
  switch (node.type) {
    case "text":
      return run(ctx, node.value ?? "", style);
    case "strong":
      return inline(children, ctx, { ...style, bold: true });
    case "emphasis":
      return inline(children, ctx, { ...style, italic: true });
    case "delete":
      return inline(children, ctx, { ...style, strike: true });
    case "inlineCode":
      return run(ctx, (node.value ?? "").replaceAll(" ", NBSP), { ...style, bg: CODE_BG[ctx.o.theme] });
    case "break":
      return "\n";
    case "link":
      return linkText(node.url ?? "", inline(children, ctx, { ...style, underline: true, fg: BLUE }), plainText(children), ctx);
    case "image":
    case "raw":
      return rawInline(node, ctx, style);
    case "label":
      return inline(children, ctx, style);
    case "textDirective":
      return directiveInline(node, ctx, style);
    default:
      return children.length > 0 ? inline(children, ctx, style) : run(ctx, node.value ?? "", style);
  }
}

function rawInline(node: MNode, ctx: Ctx, style: Style): string {
  const media = mediaNodeOf(node);
  if (media) return mediaInline(media, ctx);
  if (node.type === "image") {
    const alt = node.alt || node.url || "";
    return linkText(node.url ?? "", run(ctx, alt, { ...style, underline: true, fg: BLUE }), alt, ctx);
  }
  const url = node.value?.match(/^<(.+)>$/)?.[1];
  if (url) return linkText(url, run(ctx, url, { ...style, underline: true, fg: BLUE }), url, ctx);
  return run(ctx, node.value ?? "", style);
}

function mediaInline(media: AdfNode, ctx: Ctx): string {
  const refs = BLOCK_MEDIA.has(media.type) || media.type === "media" || media.type === "mediaInline" ? refsOfAdf(media) : [];
  if (refs.length === 0) return dim(ctx, `‹${media.type}›`);
  return refs.map((ref) => dim(ctx, placeholderLine(ref).replaceAll(" ", NBSP))).join(" ");
}

function directiveInline(node: MNode, ctx: Ctx, style: Style): string {
  const { name, attrs } = directiveInfo(node as unknown as Directive);
  const children = node.children ?? [];
  const label = plainText(children);
  switch (name) {
    case "span":
      return span(node, attrs, ctx, style);
    case "status": {
      const colors = STATUS[String(attrs.color)] ?? STATUS.neutral;
      const pill = `${NBSP}${label.toUpperCase().replaceAll(" ", NBSP)}${NBSP}`;
      return ctx.p.depth === "none" ? `[${label.toUpperCase()}]` : run(ctx, pill, { ...colors, bold: true });
    }
    case "mention":
      return run(ctx, label.startsWith("@") ? label : `@${label}`, { ...style, fg: CYAN });
    case "date":
      return run(ctx, label, { ...style, dim: true });
    case "emoji":
      return run(ctx, String(attrs.text || label), style);
    case "hardBreak":
      return "\n";
    case "empty":
      return "";
    case "placeholder":
      return dim(ctx, clean(String(attrs.text ?? "")));
    case "media": {
      const ref = refOfDirective(node, attrs);
      return dim(ctx, placeholderLine(ref).replaceAll(" ", NBSP));
    }
    case "macro":
      return dim(ctx, `⟨macro ${String(attrs.key ?? attrs.text ?? "")}⟩`);
    default:
      return unknownInline(node, ctx, style);
  }
}

/** A directive that is not an ADF node is prose such as `:foo`, so it is shown as it was written. */
function unknownInline(node: MNode, ctx: Ctx, style: Style): string {
  const children = node.children ?? [];
  if (!("adf" in (node.attributes ?? {})) && !("inline" in (node.attributes ?? {}))) {
    return run(ctx, `:${node.name}`, style) + (children.length > 0 ? `${run(ctx, "[", style)}${inline(children, ctx, style)}${run(ctx, "]", style)}` : "");
  }
  return dim(ctx, `‹${node.name}›`) + inline(children, ctx, style);
}

function span(node: MNode, attrs: Record<string, unknown>, ctx: Ctx, style: Style): string {
  const next: Style = { ...style };
  const bg = typeof attrs.bg === "string" ? parseHex(attrs.bg) : null;
  if (bg) {
    next.bg = attrs.bg as string;
    next.fg = readableOn(bg);
  }
  if (typeof attrs.color === "string" && parseHex(attrs.color)) next.fg = attrs.color;
  if (attrs.underline === true) next.underline = true;
  const children = node.children ?? [];
  const mode = attrs.sup === true ? "sup" : attrs.sub === true ? "sub" : null;
  if (!mode) return inline(children, ctx, next);
  const text = plainText(children);
  const mapped = script(text, mode === "sup" ? SUPERSCRIPT : SUBSCRIPT);
  return run(ctx, mapped ?? `${mode === "sup" ? "^" : "_"}(${text})`, next);
}

// ---------- blocks ----------

function blocks(nodes: MNode[], ctx: Ctx, width: number, tight = false): string[] {
  const out: string[] = [];
  for (const node of nodes) {
    const lines = safeBlock(node, ctx, width);
    if (lines.length === 0) continue;
    if (out.length > 0 && !tight) out.push("");
    out.push(...lines);
  }
  return out;
}

function safeBlock(node: MNode, ctx: Ctx, width: number): string[] {
  try {
    return block(node, ctx, width);
  } catch {
    return wrap(clean(plainText([node])), width);
  }
}

function block(node: MNode, ctx: Ctx, width: number): string[] {
  const children = node.children ?? [];
  switch (node.type) {
    case "paragraph":
      return paragraph(children, ctx, width);
    case "heading":
      return heading(children, node.depth ?? 1, ctx, width);
    case "list":
      return list(node, ctx, width);
    case "blockquote": {
      const bar = ctx.p.paint("▎ ", merge(ctx.base, { fg: BAR }));
      return prefixed(blocks(children, ctx, width - 2), bar, bar);
    }
    case "code":
      return code(node, ctx, width);
    case "thematicBreak":
      return [dim(ctx, "─".repeat(width))];
    case "table":
      return gfmTable(node, ctx, width, false);
    case "leafDirective":
    case "containerDirective":
      return directiveBlock(node, ctx, width);
    default:
      return wrap(inline([node], ctx, {}), width);
  }
}

function paragraph(children: MNode[], ctx: Ctx, width: number): string[] {
  if (children.length === 0) return [""];
  const out: string[] = [];
  let pending: MNode[] = [];
  const flush = () => {
    if (pending.length > 0) out.push(...wrap(inline(pending, ctx, {}), width));
    pending = [];
  };
  for (const child of children) {
    const media = mediaNodeOf(child);
    if (media && BLOCK_MEDIA.has(media.type)) {
      flush();
      out.push(...mediaBlock(refsOfAdf(media), ctx, width));
    } else {
      pending.push(child);
    }
  }
  flush();
  return out;
}

function heading(children: MNode[], depth: number, ctx: Ctx, width: number): string[] {
  const style: Style = depth <= 2 ? { bold: true, fg: BLUE } : { bold: true, dim: depth >= 5 };
  const lines = wrap(inline(children, ctx, style), width);
  if (depth > 2) return lines;
  const rule = (depth === 1 ? "═" : "─").repeat(Math.min(width, Math.max(1, ...lines.map((line) => stringWidth(line)))));
  return [...lines, ctx.p.paint(rule, merge(ctx.base, { fg: BLUE, dim: true }))];
}

function list(node: MNode, ctx: Ctx, width: number, glyph?: string): string[] {
  const items = node.children ?? [];
  const start = node.start ?? 1;
  const numberWidth = node.ordered ? String(start + items.length - 1).length + 1 : 0;
  const lines = items.map((item, index) => {
    const task = typeof item.checked === "boolean";
    const plain = ctx.p.depth === "none";
    const marker = task
      ? item.checked ? (plain ? "[x]" : "☒") : plain ? "[ ]" : "☐"
      : (glyph ?? (node.ordered ? `${start + index}.`.padStart(numberWidth) : BULLETS[ctx.level % BULLETS.length]));
    const base = item.checked ? merge(ctx.base, { dim: true }) : ctx.base;
    const inner = { ...ctx, base, level: ctx.level + 1 };
    const markerWidth = stringWidth(marker) + 1;
    const body = blocks(item.children ?? [], inner, width - markerWidth, !item.spread);
    return prefixed(body, ctx.p.paint(`${marker} `, merge(ctx.base, glyph ? { fg: BLUE } : {})), fill(ctx, markerWidth));
  });
  return lines.flatMap((itemLines, index) => (index > 0 && node.spread ? ["", ...itemLines] : itemLines));
}

function code(node: MNode, ctx: Ctx, width: number): string[] {
  const style: Style = { bg: CODE_BG[ctx.o.theme] };
  const inner = Math.max(1, width - 2);
  const painted = ctx.p.depth !== "none";
  const body = clean(node.value ?? "").split("\n").flatMap((line) => wrapAnsi(line, inner, { hard: true, wordWrap: false, trim: false }).split("\n"));
  const lang = node.lang && /^[\w+#.-]+$/.test(node.lang) ? node.lang : "";
  const row = (text: string, extra: Style = {}) => {
    const padded = painted ? text + " ".repeat(Math.max(0, inner - stringWidth(text))) : text;
    return ctx.p.paint(` ${padded}${painted ? " " : ""}`, merge(style, extra));
  };
  const label = lang ? [row(`${" ".repeat(Math.max(0, inner - stringWidth(lang)))}${lang}`, { dim: true })] : [];
  return [...label, ...body.map((line) => row(line))];
}

// ---------- directives ----------

function directiveBlock(node: MNode, ctx: Ctx, width: number): string[] {
  const { name, attrs } = directiveInfo(node as unknown as Directive);
  const children = node.children ?? [];
  switch (name) {
    case "paragraph":
      return children.length === 0 ? [""] : wrap(inline(children, ctx, {}), width);
    case "panel":
      return panel(children, attrs, ctx, width);
    case "expand":
    case "nestedExpand":
      return expand(children, attrs, ctx, width);
    case "layout":
      return layout(children, ctx, width);
    case "column":
      return blocks(children, ctx, width);
    case "table":
      return directiveTable(children, attrs, ctx, width);
    case "decisions":
      return children[0]?.type === "list" ? list(children[0], ctx, width, "◆") : blocks(children, ctx, width);
    case "marks":
      return marks(children, attrs, ctx, width);
    case "macro":
      return macro(node, attrs, ctx, width);
    case "media":
      return mediaBlock([refOfDirective(node, attrs)], ctx, width);
    case "mediaGroup":
      return mediaBlock(children.flatMap((child) => (child.name === "media" ? [refOfDirective(child, directiveInfo(child as unknown as Directive).attrs)] : [])), ctx, width);
    case "card":
      return card(plainText(children), attrs.appearance === "embed", ctx, width);
    case "blockCard":
    case "embedCard":
      return typeof attrs.url === "string" ? card(attrs.url, name === "embedCard", ctx, width) : genericBlock(node, attrs, ctx, width);
    case "taskList":
      return list(taskListOf(node), ctx, width);
    case "decisionList":
      return list(taskListOf(node, "decisionItem"), ctx, width, "◆");
    default:
      return genericBlock(node, attrs, ctx, width);
  }
}

/** A task or decision list written as generic directives, as a list whose items are checked when their `state` is DONE. */
function taskListOf(node: MNode, itemName = "taskItem"): MNode {
  const items: MNode[] = [];
  for (const child of node.children ?? []) {
    if (child.name === itemName) {
      const { attrs } = directiveInfo(child as unknown as Directive);
      items.push({ type: "listItem", checked: itemName === "taskItem" ? attrs.state === "DONE" : null, spread: false, children: child.children ?? [] });
    } else if (child.name === node.name && items.length > 0) {
      items.at(-1)!.children!.push(taskListOf(child, itemName));
    }
  }
  return { type: "list", ordered: false, spread: false, children: items };
}

function genericBlock(node: MNode, attrs: Record<string, unknown>, ctx: Ctx, width: number): string[] {
  const children = node.children ?? [];
  const label = dim(ctx, `‹${node.name}›`);
  if (node.name === "heading" && node.attributes && "inline" in node.attributes) {
    return heading(children.flatMap((child) => child.children ?? []), Number(attrs.level) || 3, ctx, width);
  }
  if (node.type === "leafDirective" || (node.attributes && "inline" in node.attributes)) {
    const content = node.type === "leafDirective" ? children : children.flatMap((child) => child.children ?? []);
    return wrap(`${label}${content.length > 0 ? " " : ""}${inline(content, ctx, {})}`, width);
  }
  return [label, ...blocks(children, ctx, width)];
}

function panel(children: MNode[], attrs: Record<string, unknown>, ctx: Ctx, width: number): string[] {
  const spec = PANEL[String(attrs.type)];
  const color = typeof attrs.color === "string" && parseHex(attrs.color) ? attrs.color : (spec?.color ?? BAR);
  const icon = [...String(attrs.iconText || spec?.icon || "●")][0];
  const iconWidth = Math.max(1, stringWidth(icon));
  const bar = (text: string) => ctx.p.paint(text, merge(ctx.base, { fg: color }));
  const body = blocks(children, ctx, width - 3 - iconWidth);
  return prefixed(body, `${bar("▎")} ${bar(icon)} `, `${bar("▎")} ${fill(ctx, iconWidth + 1)}`);
}

function expand(children: MNode[], attrs: Record<string, unknown>, ctx: Ctx, width: number): string[] {
  const title = ctx.p.paint(`▾ ${clean(String(attrs.title || "Details"))}`, merge(ctx.base, { bold: true }));
  const bar = dim(ctx, "│ ");
  return [...wrap(title, width), ...prefixed(blocks(children, ctx, width - 2), bar, bar)];
}

function layout(children: MNode[], ctx: Ctx, width: number): string[] {
  const columns = children.filter((child) => child.name === "column");
  if (columns.length === 0) return blocks(children, ctx, width);
  const percents = columns.map((column) => Number(directiveInfo(column as unknown as Directive).attrs.width) || 100 / columns.length);
  if (columns.length > 1 && width >= 100) {
    const available = width - 3 * (columns.length - 1);
    const total = percents.reduce((sum, percent) => sum + percent, 0);
    const widths = percents.map((percent) => Math.max(1, Math.floor((available * percent) / total)));
    const rendered = columns.map((column, index) => blocks(column.children ?? [], ctx, widths[index]));
    const height = Math.max(...rendered.map((lines) => lines.length));
    const separator = dim(ctx, " │ ");
    return Array.from({ length: height }, (_, row) =>
      rendered.map((lines, index) => (lines[row] ?? "") + fill(ctx, widths[index] - stringWidth(lines[row] ?? ""))).join(separator).trimEnd()
    );
  }
  return columns.flatMap((column, index) => [...(index > 0 ? ["", dim(ctx, "┈".repeat(width)), ""] : []), ...blocks(column.children ?? [], ctx, width)]);
}

function marks(children: MNode[], attrs: Record<string, unknown>, ctx: Ctx, width: number): string[] {
  const indent = Math.max(0, Math.min(Number(attrs.indent) || 0, 6)) * 2;
  const inner = Math.max(1, width - indent);
  const lines = blocks(children, ctx, inner);
  const align = attrs.align;
  const shift = (line: string) => (align === "center" ? Math.floor((inner - stringWidth(line)) / 2) : align === "end" ? inner - stringWidth(line) : 0);
  return lines.map((line) => " ".repeat(indent + Math.max(0, shift(line))) + line);
}

function macro(node: MNode, attrs: Record<string, unknown>, ctx: Ctx, width: number): string[] {
  const label = dim(ctx, `⟨macro ${String(attrs.key ?? attrs.text ?? "")}⟩`);
  if (node.type === "leafDirective") return wrap(label, width);
  return [label, ...prefixed(blocks(node.children ?? [], ctx, width - 2), fill(ctx, 2), fill(ctx, 2))];
}

function card(url: string, embed: boolean, ctx: Ctx, width: number): string[] {
  const box = boxes.round;
  const tag = embed ? " embed" : "";
  const room = Math.max(2, width - 6 - tag.length);
  const visible = stringWidth(url) > room ? `${sliceAnsi(url, 0, room - 1)}…` : url;
  const text = `→ ${visible}`;
  const inner = stringWidth(text) + tag.length;
  const link = ctx.o.links ? hyperlink(run(ctx, text, { underline: true, fg: BLUE }), safeUrl(url)) : run(ctx, text, { underline: true, fg: BLUE });
  const edge = (left: string, fillChar: string, right: string) => dim(ctx, left + fillChar.repeat(inner + 2) + right);
  return [
    edge(box.topLeft, box.top, box.topRight),
    `${dim(ctx, box.left)} ${link}${tag ? dim(ctx, tag) : ""} ${dim(ctx, box.right)}`,
    edge(box.bottomLeft, box.bottom, box.bottomRight),
  ];
}

// ---------- tables ----------

function cellBase(bg: unknown, header: boolean, ctx: Ctx): Style | undefined {
  const rgb = typeof bg === "string" ? parseHex(bg) : null;
  const tint: Style = rgb ? { bg: bg as string, fg: readableOn(rgb) } : {};
  return header || rgb ? { ...(header ? headerStyle(ctx.o.theme) : {}), ...tint } : undefined;
}

function gfmTable(node: MNode, ctx: Ctx, width: number, numbered: boolean, hints?: number[]): string[] {
  const aligns = node.align ?? [];
  const rows = (node.children ?? []).map((row, r): TableCell[] =>
    (row.children ?? []).map((cell, c) => ({
      header: r === 0,
      colspan: 1,
      rowspan: 1,
      align: aligns[c] === "center" || aligns[c] === "right" ? (aligns[c] as "center" | "right") : undefined,
      base: cellBase(undefined, r === 0, ctx),
      render: (w, base) => wrap(inline(cell.children ?? [], { ...ctx, base: merge(ctx.base, base) }, {}), w),
    }))
  );
  return renderTable({ rows, width, numbered, hints, painter: ctx.p, theme: ctx.o.theme });
}

function directiveTable(children: MNode[], attrs: Record<string, unknown>, ctx: Ctx, width: number): string[] {
  const numbered = attrs.numbered === true;
  const colwidths = Array.isArray(attrs.colwidths) ? (attrs.colwidths as number[]) : undefined;
  const gfm = children.find((child) => child.type === "table");
  if (gfm) return gfmTable(gfm, ctx, width, numbered, colwidths);
  const rowNodes = children.filter((child) => child.name === "row");
  const infos = rowNodes.map((row) => (row.children ?? []).filter((cell) => cell.name === "cell").map((cell) => ({ cell, attrs: directiveInfo(cell as unknown as Directive).attrs })));
  const rows = infos.map((row) =>
    row.map(({ cell, attrs: cellAttrs }): TableCell => ({
      header: cellAttrs.header === true,
      colspan: Number(cellAttrs.colspan) || 1,
      rowspan: Number(cellAttrs.rowspan) || 1,
      base: cellBase(cellAttrs.bg, cellAttrs.header === true, ctx),
      render: (w, base) => blocks(cell.children ?? [], { ...ctx, base: merge(ctx.base, base) }, w),
    }))
  );
  const first = infos[0] ?? [];
  const hinted = first.flatMap(({ attrs: cellAttrs }) => (Array.isArray(cellAttrs.colwidth) ? (cellAttrs.colwidth as number[]) : [0]));
  const hints = colwidths ?? (hinted.length > 0 && hinted.every((value) => value > 0) ? hinted : undefined);
  return renderTable({ rows, width, numbered, hints, painter: ctx.p, theme: ctx.o.theme });
}

// ---------- entry points ----------

const LINK_OPEN = /\x1b\]8;;[^\x07\x1b]+\x07/g;
const LINK_CLOSE = /\x1b\]8;;\x07/g;

/** Safety net for a line wider than the budget; a hyperlink cut in the middle is closed again. */
function fit(line: string, width: number): string {
  if (stringWidth(line) <= width) return line;
  const cut = sliceAnsi(line, 0, width);
  const unclosed = (cut.match(LINK_OPEN)?.length ?? 0) > (cut.match(LINK_CLOSE)?.length ?? 0);
  return unclosed ? `${cut}\x1b]8;;\x07` : cut;
}

/** Lines of ANSI text for `root`, none wider than `options.width`. */
export function render(root: Root, partial: Partial<RenderOptions> = {}): string[] {
  const o = resolveOptions(partial);
  const ctx: Ctx = { o, p: createPainter(o.color, o.theme), base: {}, level: 0 };
  const width = Math.max(1, o.width);
  const lines = blocks(root.children as unknown as MNode[], ctx, width).map((line) => (line.includes("\x1b_G") ? line : fit(line, width)));
  while (lines.length > 0 && stringWidth(lines[lines.length - 1]) === 0) lines.pop();
  return lines;
}

export const renderAdf = (adf: AdfNode | null | undefined, partial?: Partial<RenderOptions>): string[] => render(adfToMdast(adf), partial);

export const renderMarkdownText = (markdown: string, partial?: Partial<RenderOptions>): string[] => render(markdownToMdast(markdown), partial);
