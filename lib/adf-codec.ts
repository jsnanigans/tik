import { createHash } from "crypto";
import { fromMarkdown } from "mdast-util-from-markdown";
import { toMarkdown, type Handle, type Options as ToMarkdownOptions } from "mdast-util-to-markdown";
import { gfm } from "micromark-extension-gfm";
import { gfmFromMarkdown, gfmToMarkdown } from "mdast-util-gfm";
import { directive } from "micromark-extension-directive";
import { directiveFromMarkdown, directiveToMarkdown } from "mdast-util-directive";
import type { ContainerDirective, LeafDirective, TextDirective } from "mdast-util-directive";
import type { Link, List, ListItem, Paragraph, PhrasingContent, Root, RootContent, Table } from "mdast";
import { DEFAULT_ATTRS, equivalent, mergeText } from "./adf-reconcile";
import { decodeMediaPlaceholder, encodePlaceholder, type AdfNode } from "./markdown";

type Mark = NonNullable<AdfNode["marks"]>[number];
type Attrs = Record<string, unknown>;
type Directive = LeafDirective | ContainerDirective | TextDirective;
type Context = { source: string; warnings: string[]; ids: number };
type Wrapper = { key: string; make: (children: PhrasingContent[]) => PhrasingContent };

export type ParseResult = { doc: AdfNode; warnings: string[] };

/** Node types that can have no attributes: only these are written, and read, as a directive without `adf`. */
const ATTRLESS_NODES = new Set(
  ("paragraph hardBreak tableRow tableCell tableHeader mediaGroup layoutSection extensionFrame caption taskList " +
    "decisionList bulletList orderedList listItem blockquote rule").split(" ")
);
const INLINE_NODES = new Set([
  "text", "hardBreak", "mention", "emoji", "date", "status", "inlineCard", "mediaInline", "inlineExtension", "placeholder",
]);
const MEDIA_NODES = new Set(["mediaSingle", "mediaGroup", "media"]);
const LOCAL_ID_NODES = new Set(["taskList", "taskItem", "decisionList", "decisionItem"]);
const LIST_ITEM_CHILDREN = new Set(["paragraph", "codeBlock", "mediaSingle", "bulletList", "orderedList", "taskList"]);
const QUOTE_CHILDREN = new Set(["paragraph", "bulletList", "orderedList", "codeBlock", "mediaGroup", "mediaSingle"]);
const CODE_EXCLUDES = new Set(["strong", "em", "strike", "underline", "textColor", "backgroundColor", "subsup"]);
const SAFE_LANGUAGE = /^[^\s`{][^\s`]*$/;
const AUTOLINK = /^[A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>\u0000-\u001f\u007f]*$/;

/** Readable spellings, `:name[label]{attrs}`; every other node uses the generic rule. `label` names the attribute shown as the label. */
type Dedicated = { type: string; name: string; label: string; attrs: Record<string, "string" | "number">; block?: true; variant?: Record<string, string> };
const DEDICATED: Dedicated[] = [
  { type: "emoji", name: "emoji", label: "shortName", attrs: { id: "string", text: "string" } },
  { type: "mention", name: "mention", label: "text", attrs: { id: "string", accessLevel: "string" } },
  { type: "blockCard", name: "card", label: "url", attrs: { layout: "string", width: "number" }, block: true, variant: { appearance: "block" } },
  {
    type: "embedCard", name: "card", label: "url", block: true, variant: { appearance: "embed" },
    attrs: { layout: "string", width: "number", originalWidth: "number", originalHeight: "number" },
  },
  { type: "status", name: "status", label: "text", attrs: { color: "string", style: "string" } },
];

/** Table, row and cell attributes: ADF name to directive name and value kind. A node with any other attribute uses the generic rule. */
type Kind = "string" | "number" | "flag" | "numbers";
type AttrSpec = Record<string, [string, Kind]>;
const TABLE_ATTRS: AttrSpec = { layout: ["layout", "string"], width: ["width", "number"], displayMode: ["displayMode", "string"], isNumberColumnEnabled: ["numbered", "flag"] };
const CELL_ATTRS: AttrSpec = { colspan: ["colspan", "number"], rowspan: ["rowspan", "number"], background: ["bg", "string"], valign: ["valign", "string"], colwidth: ["colwidth", "numbers"] };
const EXPAND_ATTRS: AttrSpec = { title: ["title", "string"] };
const CONTAINER_ATTRS: Record<string, AttrSpec> = {
  panel: { panelType: ["type", "string"], panelColor: ["color", "string"], panelIcon: ["icon", "string"], panelIconId: ["iconId", "string"], panelIconText: ["iconText", "string"] },
  expand: EXPAND_ATTRS,
  nestedExpand: EXPAND_ATTRS,
};
/** `::media[alt]{…}` is a mediaSingle holding one media; inside `:::mediaGroup` it is the media itself, and `:media[alt]{…}` is a mediaInline. */
const MEDIA_ATTRS: AttrSpec = {
  id: ["_id", "string"], type: ["type", "string"], collection: ["collection", "string"], occurrenceKey: ["occurrenceKey", "string"], url: ["url", "string"],
  width: ["originalWidth", "number"], height: ["originalHeight", "number"],
};
const SINGLE_ATTRS: AttrSpec = { layout: ["layout", "string"], width: ["width", "number"], widthType: ["widthType", "string"] };
const BORDER_ATTRS: AttrSpec = { color: ["border", "string"], size: ["borderSize", "number"] };

const parseJson = (value: string | null | undefined): unknown => {
  try {
    return value === undefined || value === null ? undefined : JSON.parse(value);
  } catch {
    return undefined;
  }
};

const asObject = (value: unknown): Attrs | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Attrs) : undefined;

// ---------- ADF to markdown ----------

/** `&` is encoded because directive attribute values and code info strings decode character references. */
const encodeAmpersands = (text: string) => text.replace(/&/g, "&#x26;");
const encodeJson = (value: unknown) => encodeAmpersands(JSON.stringify(value));

/** `localId` is left out: reconcile restores it from the original node. */
function attrsOf(node: { attrs?: Attrs }): Attrs {
  const { localId: _localId, ...attrs } = node.attrs ?? {};
  return attrs;
}

const noAttrs = (node: { attrs?: Attrs }) => Object.keys(attrsOf(node)).length === 0;

function directiveAttributes(node: AdfNode): Record<string, string> {
  const attrs = attrsOf(node);
  return Object.keys(attrs).length > 0 || !ATTRLESS_NODES.has(node.type) ? { adf: encodeJson(attrs) } : {};
}

/** A custom mdast node written verbatim: a media placeholder keeps the `![label](tikmedia:…)` form that `makeMediaPlaceholder` produces. */
const raw = (value: string) => ({ type: "raw", value }) as unknown as PhrasingContent;
const writeRaw = Object.assign((node: { value: string }) => node.value, { peek: (node: { value: string }) => node.value });
/** A leaf directive label is not written inside a paragraph, so the writer would not escape `_` or `*` in it; this node does. */
const labelNode = (value: string) => ({ type: "label", children: [{ type: "text", value }] }) as unknown as PhrasingContent;
const writeLabel: Handle = (node, _parent, state, info) => {
  const exit = state.enter("phrasing");
  const out = state.containerPhrasing(node as never, info);
  exit();
  return out;
};
const placeholderOf = (node: AdfNode) => raw(encodePlaceholder(node));

function blocksToMdast(nodes: AdfNode[] = []): RootContent[] {
  return nodes.map(blockToMdast);
}

function blockToMdast(node: AdfNode): RootContent {
  if (MEDIA_NODES.has(node.type)) return mediaToMdast(node) ?? { type: "paragraph", children: [placeholderOf(node)] };
  if (node.marks?.length) {
    return {
      type: "containerDirective",
      name: "marks",
      attributes: { adf: encodeJson(node.marks) },
      children: [blockToMdast({ ...node, marks: undefined })] as ContainerDirective["children"],
    };
  }
  return nativeBlock(node) ?? dedicatedToMdast(node) ?? genericBlock(node);
}

function nativeBlock(node: AdfNode): RootContent | undefined {
  const children = node.content ?? [];
  const attrs = attrsOf(node);
  switch (node.type) {
    case "paragraph":
      return noAttrs(node) && children.length ? { type: "paragraph", children: inlineToMdast(children) } : undefined;
    case "heading": {
      const level = attrs.level;
      const valid = Object.keys(attrs).length === 1 && Number.isInteger(level) && (level as number) >= 1 && (level as number) <= 6;
      return valid ? { type: "heading", depth: level as 1, children: inlineToMdast(children, true) } : undefined;
    }
    case "bulletList":
    case "orderedList":
      return listToMdast(node);
    case "codeBlock":
      return codeToMdast(node);
    case "blockquote":
      return noAttrs(node) && children.length ? { type: "blockquote", children: blocksToMdast(children) as never } : undefined;
    case "taskList":
      return taskListToMdast(node);
    case "panel":
    case "expand":
    case "nestedExpand":
      return containerToMdast(node);
    case "rule":
      return noAttrs(node) && !children.length ? { type: "thematicBreak" } : undefined;
    case "table":
      return tableToMdast(node);
  }
}

const orderOf = (node: AdfNode) => (attrsOf(node).order as number | undefined) ?? 1;

function listToMdast(node: AdfNode): List | undefined {
  const ordered = node.type === "orderedList";
  const attrs = attrsOf(node);
  const order = orderOf(node);
  const validOrder = Object.keys(attrs).every((key) => key === "order") && Number.isInteger(order) && order >= 0 && order < 1e9;
  const validAttrs = ordered ? validOrder : noAttrs(node);
  const items = node.content ?? [];
  if (!validAttrs || !items.length || !items.every((item) => item.type === "listItem" && noAttrs(item) && item.content?.length)) {
    return undefined;
  }
  const children = items.map((item): ListItem => {
    const [first, second] = item.content!;
    const nestedList = second && (second.type === "bulletList" || (second.type === "orderedList" && orderOf(second) === 1));
    const tight = item.content!.length === 1 || (item.content!.length === 2 && first.type === "paragraph" && nestedList);
    return { type: "listItem", spread: !tight, checked: null, children: blocksToMdast(item.content) as ListItem["children"] };
  });
  return { type: "list", ordered, start: ordered ? orderOf(node) : null, spread: children.some((item) => item.spread), children };
}

/** Items are inline-only with a `state`; anything else (nested lists, other attributes, an empty item) uses the generic rule. */
function taskListToMdast(node: AdfNode): List | undefined {
  const items = node.content ?? [];
  const simple = (item: AdfNode) =>
    item.type === "taskItem" && Object.keys(attrsOf(item)).length === 1 && ["TODO", "DONE"].includes(attrsOf(item).state as string) &&
    Boolean(item.content?.length) && item.content!.every((child) => INLINE_NODES.has(child.type));
  if (!noAttrs(node) || !items.length || !items.every(simple)) return undefined;
  const children = items.map((item): ListItem => ({
    type: "listItem", spread: false, checked: attrsOf(item).state === "DONE", children: [{ type: "paragraph", children: inlineToMdast(item.content!) }],
  }));
  return { type: "list", ordered: false, start: null, spread: false, children };
}

function codeToMdast(node: AdfNode): RootContent | undefined {
  const children = node.content ?? [];
  if (!children.every((child) => child.type === "text" && !child.marks)) return undefined;
  const { language, ...rest } = attrsOf(node);
  const safeLanguage = typeof language === "string" && SAFE_LANGUAGE.test(language);
  if (language !== undefined && !safeLanguage) rest.language = language;
  const json = Object.keys(rest).length > 0 ? encodeJson(rest) : null;
  return {
    type: "code",
    lang: safeLanguage ? encodeAmpersands(language) : json,
    meta: safeLanguage ? json : null,
    value: children.map((child) => child.text).join(""),
  };
}

/** ADF `id` and `class` attributes are written `_id` and `_class`, because the directive syntax gives those names a meaning. */
const markdownName = (name: string) => (name === "id" || name === "class" ? `_${name}` : name);

const isPlainText = (value: unknown): value is string => typeof value === "string" && !/[\r\n]/.test(value);

const isoDate = (timestamp: number) => new Date(timestamp).toISOString().slice(0, 10);

/** The label is the UTC day; the timestamp is only written when it is not that day's midnight. */
function dateToMdast(node: AdfNode): TextDirective | undefined {
  const { timestamp, ...other } = attrsOf(node);
  if (Object.keys(other).length > 0 || typeof timestamp !== "string" || !/^\d{1,13}$/.test(timestamp)) return undefined;
  const day = isoDate(Number(timestamp));
  const attributes = String(Date.parse(day)) === timestamp ? {} : { timestamp };
  return { type: "textDirective", name: "date", attributes, children: [{ type: "text", value: day }] };
}

function dedicatedToMdast(node: AdfNode): TextDirective | LeafDirective | undefined {
  if (node.type === "date") return dateToMdast(node);
  const spec = DEDICATED.find((candidate) => candidate.type === node.type);
  if (!spec || node.content?.length) return undefined;
  const attributes: Record<string, string> = { ...spec.variant };
  let text: string | undefined;
  for (const [name, value] of Object.entries(attrsOf(node))) {
    if (value === DEFAULT_ATTRS[node.type]?.[name]) continue;
    if (name === spec.label && isPlainText(value) && value) text = value;
    else if (spec.attrs[name] === "string" && isPlainText(value)) attributes[markdownName(name)] = encodeAmpersands(value);
    else if (spec.attrs[name] === "number" && typeof value === "number" && Number.isFinite(value)) attributes[markdownName(name)] = String(value);
    else return undefined;
  }
  const children = text ? [spec.block ? labelNode(text) : { type: "text" as const, value: text }] : [];
  return { type: spec.block ? "leafDirective" : "textDirective", name: spec.name, attributes, children } as TextDirective | LeafDirective;
}

const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

function encodeAttr(value: unknown, kind: Kind): string | undefined {
  switch (kind) {
    case "string":
      return isPlainText(value) ? encodeAmpersands(value) : undefined;
    case "number":
      return isNumber(value) ? String(value) : undefined;
    case "flag":
      return value === true ? "" : undefined;
    case "numbers":
      return Array.isArray(value) && value.length > 0 && value.every(isNumber) ? value.join(",") : undefined;
  }
}

function attributesOf(node: AdfNode, spec: AttrSpec): Record<string, string> | undefined {
  const attributes: Record<string, string> = {};
  for (const [name, value] of Object.entries(attrsOf(node))) {
    if (value === DEFAULT_ATTRS[node.type]?.[name]) continue;
    const [key, kind] = spec[name] ?? [];
    const text = kind && encodeAttr(value, kind);
    if (text === undefined) return undefined;
    attributes[key] = text;
  }
  return attributes;
}

const container = (name: string, attributes: Record<string, string>, children: unknown[]) =>
  ({ type: "containerDirective", name, attributes, children }) as ContainerDirective;

function cellToMdast(cell: AdfNode): ContainerDirective | undefined {
  const attributes = cell.type === "tableCell" || cell.type === "tableHeader" ? attributesOf(cell, CELL_ATTRS) : undefined;
  return attributes && container("cell", cell.type === "tableHeader" ? { header: "", ...attributes } : attributes, blocksToMdast(cell.content));
}

function directiveTable(rows: AdfNode[], attributes: Record<string, string>): ContainerDirective | undefined {
  const rowDirectives = rows.map((row) => {
    const cells = row.content!.map(cellToMdast);
    return cells.every(Boolean) ? container("row", {}, cells) : undefined;
  });
  return rowDirectives.every(Boolean) ? container("table", attributes, rowDirectives) : undefined;
}

/** Header row of `tableHeader` cells, then rows of `tableCell`, one paragraph per cell. The widths of the first row are the column widths. */
function gfmTable(rows: AdfNode[], attributes: Record<string, string>): RootContent | undefined {
  const [head, ...body] = rows;
  const cells = (row: AdfNode, type: string) => row.content!.every((cell) => cell.type === type && cell.content?.length === 1 && cell.content[0].type === "paragraph");
  if (!cells(head, "tableHeader") || !body.every((row) => cells(row, "tableCell"))) return undefined;
  const table: Table = {
    type: "table",
    align: head.content!.map(() => null),
    children: rows.map((row) => ({
      type: "tableRow",
      children: row.content!.map((cell) => ({ type: "tableCell", children: inlineToMdast(cell.content![0].content ?? []) })),
    })),
  };
  const widths = head.content!.map((cell) => (cell.attrs?.colwidth as unknown[] | undefined)?.[0]);
  const withWidths: Record<string, string> = widths.every(isNumber) ? { ...attributes, colwidths: widths.join(",") } : attributes;
  return Object.keys(withWidths).length > 0 ? container("table", withWidths, [table]) : table;
}

/** A GFM table is written only when it reads back equivalent; hard breaks, block cells and cell attributes use the directive form. */
function tableToMdast(node: AdfNode): RootContent | undefined {
  const attributes = attributesOf(node, TABLE_ATTRS);
  const rows = node.content ?? [];
  if (!attributes || !rows.every((row) => row.type === "tableRow" && noAttrs(row) && row.content?.length) || !rows.length) return undefined;
  const simple = gfmTable(rows, attributes);
  if (simple) {
    const text = toMarkdown({ type: "root", children: [simple] }, writeOptions);
    if (equivalent(parseMarkdown(text).doc, { type: "doc", version: 1, content: [node] } as AdfNode)) return simple;
  }
  return directiveTable(rows, attributes);
}

/** A panel needs its `type`; the others may have no attributes. */
function containerToMdast(node: AdfNode): ContainerDirective | undefined {
  const attributes = attributesOf(node, CONTAINER_ATTRS[node.type]);
  return attributes && (node.type !== "panel" || "type" in attributes) ? container(node.type, attributes, blocksToMdast(node.content)) : undefined;
}

/** `alt` is the label; a border mark and, for a mediaSingle, its own attributes share the attribute list. */
function mediaDirective(kind: "leafDirective" | "textDirective", media: AdfNode, single?: AdfNode): LeafDirective | TextDirective | undefined {
  const { alt, ...rest } = attrsOf(media);
  const [border, ...otherMarks] = media.marks ?? [];
  if (otherMarks.length > 0 || (border && border.type !== "border") || (alt !== undefined && !(isPlainText(alt) && alt))) return undefined;
  const parts = [
    attributesOf({ type: "media", attrs: rest }, MEDIA_ATTRS),
    border ? attributesOf({ type: "border", attrs: border.attrs }, BORDER_ATTRS) : {},
    single ? attributesOf(single, SINGLE_ATTRS) : {},
  ];
  if (!parts.every(Boolean)) return undefined;
  const children = typeof alt === "string" ? [kind === "leafDirective" ? labelNode(alt) : { type: "text" as const, value: alt }] : [];
  return { type: kind, name: "media", attributes: Object.assign({}, ...parts), children } as LeafDirective | TextDirective;
}

/** A mediaSingle needs its `layout`, which the reader would otherwise default. */
function mediaToMdast(node: AdfNode): RootContent | undefined {
  if (node.marks?.length) return undefined;
  const content = node.content ?? [];
  if (node.type === "mediaSingle") {
    const [media] = content;
    return media?.type === "media" && content.length === 1 && typeof node.attrs?.layout === "string" ? (mediaDirective("leafDirective", media, node) as LeafDirective) : undefined;
  }
  const children = content.map((media) => (media.type === "media" ? mediaDirective("leafDirective", media) : undefined));
  return node.type === "mediaGroup" && noAttrs(node) && children.length > 0 && children.every(Boolean) ? container("mediaGroup", {}, children) : undefined;
}

function genericBlock(node: AdfNode): RootContent {
  const children = node.content ?? [];
  const attributes = directiveAttributes(node);
  if (!children.length) return { type: "leafDirective", name: node.type, attributes, children: [] };
  if (children.some((child) => INLINE_NODES.has(child.type))) {
    return {
      type: "containerDirective",
      name: node.type,
      attributes: { inline: "", ...attributes },
      children: [{ type: "paragraph", children: inlineToMdast(children) }],
    };
  }
  return { type: "containerDirective", name: node.type, attributes, children: blocksToMdast(children) as ContainerDirective["children"] };
}

/** The mark wrappers of one inline node, outermost first, and whether its text is inline code (innermost). */
function wrappersOf(node: AdfNode): { chain: Wrapper[]; code: boolean } {
  const marks = [...(node.marks ?? [])];
  const isText = node.type === "text";
  const take = (type: string, accept: (mark: Mark) => boolean) => {
    const index = isText ? marks.findIndex((mark) => mark.type === type && accept(mark)) : -1;
    return index < 0 ? undefined : marks.splice(index, 1)[0];
  };
  const plain = (mark: Mark) => !mark.attrs || Object.keys(mark.attrs).length === 0;
  const isColor = (mark: Mark) => Object.keys(mark.attrs ?? {}).length === 1 && isPlainText(mark.attrs?.color) && mark.attrs?.color !== "";
  const link = take("link", (mark) => {
    const { href, title, ...other } = mark.attrs ?? {};
    return typeof href === "string" && (title === undefined || typeof title === "string") && Object.keys(other).length === 0;
  });
  const strong = take("strong", plain);
  const em = take("em", plain);
  const strike = take("strike", plain);
  const code = node.text && !/[\r\n]/.test(node.text) ? take("code", plain) : undefined;

  const chain: Wrapper[] = [];
  if (link) {
    const { href, title } = link.attrs as { href: string; title?: string };
    chain.push({ key: `link ${href} ${title}`, make: (children) => ({ type: "link", url: href, title: title ?? null, children }) });
  }
  if (strong) chain.push({ key: "strong", make: (children) => ({ type: "strong", children }) });
  if (em) chain.push({ key: "em", make: (children) => ({ type: "emphasis", children }) });
  if (strike) chain.push({ key: "strike", make: (children) => ({ type: "delete", children }) });
  const attributes: Record<string, string> = {};
  const color = take("textColor", isColor);
  if (color) attributes.color = encodeAmpersands(color.attrs!.color as string);
  if (take("underline", plain)) attributes.underline = "";
  const script = take("subsup", (mark) => Object.keys(mark.attrs ?? {}).length === 1 && (mark.attrs?.type === "sub" || mark.attrs?.type === "sup"));
  if (script) attributes[script.attrs!.type as string] = "";
  const background = take("backgroundColor", isColor);
  if (background) attributes.bg = encodeAmpersands(background.attrs!.color as string);
  if (marks.length > 0) attributes.marks = encodeJson(marks);
  if (Object.keys(attributes).length > 0) {
    chain.push({ key: `span ${JSON.stringify(attributes)}`, make: (children) => ({ type: "textDirective", name: "span", attributes, children }) });
  }
  return { chain, code: Boolean(code) };
}

/** A hard break at the end of a block or inside a heading has no markdown form, so it is written as `:hardBreak`. */
function leafToMdast(node: AdfNode, asDirective: boolean, code: boolean): PhrasingContent {
  if (node.type === "text") return code ? { type: "inlineCode", value: node.text ?? "" } : { type: "text", value: node.text ?? "" };
  if (node.type === "mediaInline") return (mediaDirective("textDirective", { ...node, marks: undefined }) as TextDirective | undefined) ?? placeholderOf(node);
  const url = attrsOf(node).url;
  if (node.type === "inlineCard" && Object.keys(attrsOf(node)).length === 1 && typeof url === "string" && AUTOLINK.test(url)) return raw(`<${url}>`);
  if (node.type === "hardBreak" && noAttrs(node) && !asDirective) return { type: "break" };
  const dedicated = dedicatedToMdast(node);
  if (dedicated) return dedicated as TextDirective;
  const attributes = directiveAttributes(node);
  const children = inlineToMdast(node.content ?? []);
  // An empty text child makes the writer emit `[]`, which keeps `:hardBreak:hardBreak` apart.
  return { type: "textDirective", name: node.type, attributes, children: children.length > 0 || "adf" in attributes ? children : [{ type: "text", value: "" }] };
}

function nest(items: { chain: Wrapper[]; leaf: PhrasingContent }[], depth = 0): PhrasingContent[] {
  const out: PhrasingContent[] = [];
  for (let start = 0; start < items.length; ) {
    const wrapper = items[start].chain[depth];
    if (!wrapper) {
      out.push(items[start++].leaf);
      continue;
    }
    let end = start;
    while (end < items.length && items[end].chain[depth]?.key === wrapper.key) end++;
    out.push(wrapper.make(nest(items.slice(start, end), depth + 1)));
    start = end;
  }
  return out;
}

/** Marks form a nested chain in a fixed order (link, strong, em, strike, span, code); neighbours with the same outer marks share a wrapper. */
function inlineToMdast(nodes: AdfNode[], inHeading = false): PhrasingContent[] {
  return nest(
    nodes.map((node, index) => {
      const { chain, code } = wrappersOf(node);
      return { chain, leaf: leafToMdast(node, inHeading || index === nodes.length - 1, code) };
    })
  );
}

// GFM without its autolink literals (the first extension), which would turn plain text such as `a@b.co` into links on read.
const gfmWriter = gfmToMarkdown({ tablePipeAlign: false }).extensions!.slice(1);

const writeOptions: ToMarkdownOptions = {
  extensions: [...gfmWriter, directiveToMarkdown({ quote: "'", preferUnquoted: true })],
  handlers: { raw: writeRaw, label: writeLabel } as ToMarkdownOptions["handlers"],
  bullet: "-",
  emphasis: "_",
  strong: "*",
  rule: "-",
  fences: true,
  resourceLink: true,
};

export function adfToEditMarkdown(adf: AdfNode | null | undefined): string {
  if (!adf) return "";
  const root: Root = { type: "root", children: blocksToMdast(adf.content) };
  // The parser drops a leading byte order mark, so it is written as a character reference.
  return toMarkdown(root, writeOptions).replace(/\n+$/, "").replace(/^\uFEFF/, "&#xFEFF;");
}

// ---------- markdown to ADF ----------

const readOptions = {
  extensions: [
    gfm({ singleTilde: false }),
    directive(),
    { disable: { null: ["codeIndented", "htmlFlow", "htmlText", "wwwAutolink", "protocolAutolink", "emailAutolink"] } },
  ],
  mdastExtensions: [...gfmFromMarkdown().slice(1), directiveFromMarkdown()],
};

const sourceOf = (node: { position?: { start: { offset?: number }; end: { offset?: number } } }, ctx: Context) =>
  ctx.source.slice(node.position?.start.offset, node.position?.end.offset).replace(/[\r\n]+$/, "");

const emptyParagraph = (): AdfNode => ({ type: "paragraph", content: [] });

/** Text with `code` plus a mark ADF forbids next to it keeps only the code mark. */
function textNode(text: string, marks: Mark[]): AdfNode[] {
  if (!text) return [];
  const kept = marks.some((mark) => mark.type === "code") ? marks.filter((mark) => !CODE_EXCLUDES.has(mark.type)) : marks;
  return [{ type: "text", text, ...(kept.length > 0 ? { marks: kept } : {}) }];
}

function withMark(marks: Mark[], mark: Mark): Mark[] {
  return marks.some((existing) => JSON.stringify(existing) === JSON.stringify(mark)) ? marks : [...marks, mark];
}

/** A directive is an ADF node when it carries `adf` attributes or names a node type that can have none; anything else is plain text. */
function directiveSpec(node: Directive): AdfNode | undefined {
  const { adf } = node.attributes ?? {};
  if (adf === undefined || adf === null) return ATTRLESS_NODES.has(node.name) ? { type: node.name } : undefined;
  const attrs = asObject(parseJson(adf));
  if (!attrs) return undefined;
  return Object.keys(attrs).length > 0 ? { type: node.name, attrs } : { type: node.name };
}

const plainText = (nodes: PhrasingContent[], ctx: Context): string =>
  nodes.map((node) => (node.type === "textDirective" ? sourceOf(node, ctx) : "value" in node ? node.value : "children" in node ? plainText(node.children, ctx) : "")).join("");

/** An edited label wins over a stale timestamp. */
function dateNode(node: TextDirective, ctx: Context): AdfNode | undefined {
  const label = plainText(node.children, ctx);
  const { timestamp, ...other } = node.attributes ?? {};
  const day = Date.parse(label);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(label) || Number.isNaN(day) || Object.keys(other).length > 0) return undefined;
  const keep = typeof timestamp === "string" && /^\d{1,13}$/.test(timestamp) && isoDate(Number(timestamp)) === label;
  return { type: "date", attrs: { timestamp: keep ? timestamp : String(day) } };
}

/** A dedicated directive reads its label and typed attributes; one that does not fit its spelling is not an ADF node. */
function dedicatedNode(node: Directive, ctx: Context): AdfNode | undefined {
  const attributes = node.attributes ?? {};
  if (node.name === "date" && node.type === "textDirective" && !("adf" in attributes)) return dateNode(node, ctx);
  const spec = DEDICATED.find(
    (candidate) =>
      candidate.name === node.name &&
      !("adf" in attributes) &&
      (candidate.block ? node.type === "leafDirective" : node.type === "textDirective") &&
      Object.entries(candidate.variant ?? {}).every(([name, value]) => attributes[name] === value)
  );
  if (!spec) return undefined;
  const names = Object.fromEntries(Object.keys(spec.attrs).map((name) => [markdownName(name), name]));
  const attrs: Attrs = {};
  const label = plainText(node.children as PhrasingContent[], ctx);
  if (label) attrs[spec.label] = label;
  for (const [name, value] of Object.entries(attributes)) {
    if (spec.variant && name in spec.variant) continue;
    const type = spec.attrs[names[name]];
    const number = Number(value);
    if (!type || typeof value !== "string" || (type === "number" && (value === "" || Number.isNaN(number)))) return undefined;
    attrs[names[name]] = type === "number" ? number : value;
  }
  return Object.keys(attrs).length > 0 ? { type: spec.type, attrs } : undefined;
}

/** A new task or decision node gets an id derived from its position in the document and its text, so parsing the same markdown twice gives the same ids. */
function finish(node: AdfNode, ctx: Context): AdfNode {
  if (LOCAL_ID_NODES.has(node.type)) {
    const text = (node.content ?? []).map((child) => child.text ?? "").join("");
    const hex = createHash("sha1").update(`${ctx.ids++}:${node.type}:${text}`).digest("hex");
    const localId = [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20, 32)].join("-");
    node.attrs = { localId, ...node.attrs };
  }
  return node;
}

function placeholderNode(url: string): AdfNode | null {
  const match = url.match(/^(?:tikmedia|tikadf):([A-Za-z0-9+/=]+)$/);
  return match ? decodeMediaPlaceholder(match[1]) : null;
}

function unknownDirective(node: Directive, ctx: Context): void {
  ctx.warnings.push(`line ${node.position?.start.line}: unknown directive "${node.name}" kept as text`);
}

/** `<url>` is an inlineCard; `[url](url)` stays a link mark. */
const isAutolink = (node: Link, ctx: Context) =>
  ctx.source[node.position?.start.offset ?? -1] === "<" && node.children.length === 1 && node.children[0].type === "text" && node.children[0].value === node.url;

function inlineFromMdast(nodes: PhrasingContent[], marks: Mark[], ctx: Context): AdfNode[] {
  const out: AdfNode[] = [];
  for (const node of nodes) {
    switch (node.type) {
      case "text":
        out.push(...textNode(node.value, marks));
        break;
      case "strong":
        out.push(...inlineFromMdast(node.children, withMark(marks, { type: "strong" }), ctx));
        break;
      case "emphasis":
        out.push(...inlineFromMdast(node.children, withMark(marks, { type: "em" }), ctx));
        break;
      case "delete":
        out.push(...inlineFromMdast(node.children, withMark(marks, { type: "strike" }), ctx));
        break;
      case "inlineCode":
        out.push(...textNode(node.value, withMark(marks, { type: "code" })));
        break;
      case "link": {
        if (isAutolink(node, ctx)) {
          out.push({ type: "inlineCard", attrs: { url: node.url }, ...(marks.length > 0 ? { marks } : {}) });
          break;
        }
        const attrs = { href: node.url, ...(node.title ? { title: node.title } : {}) };
        out.push(...inlineFromMdast(node.children, withMark(marks, { type: "link", attrs }), ctx));
        break;
      }
      case "break":
        out.push({ type: "hardBreak" });
        break;
      case "image": {
        const decoded = placeholderNode(node.url);
        if (decoded) out.push(decoded);
        else out.push(...textNode(node.alt || node.url, withMark(marks, { type: "link", attrs: { href: node.url } })));
        break;
      }
      case "textDirective":
        out.push(...inlineDirective(node, marks, ctx));
        break;
      default:
        out.push(...textNode(sourceOf(node, ctx), marks));
    }
  }
  return mergeText(out);
}

/** A span is `color`, `bg`, `underline`, `sub` and `sup` attributes, plus the generic `marks` JSON for every other mark. */
function marksOfSpan(node: TextDirective): Mark[] | undefined {
  const { color, bg, underline, sub, sup, marks, ...other } = node.attributes ?? {};
  const generic = marks === undefined || marks === null ? [] : parseJson(marks);
  if (Object.keys(other).length > 0 || !Array.isArray(generic)) return undefined;
  const result: Mark[] = generic.filter((mark): mark is Mark => typeof mark?.type === "string");
  if (color) result.push({ type: "textColor", attrs: { color } });
  if (bg) result.push({ type: "backgroundColor", attrs: { color: bg } });
  if (underline !== undefined && underline !== null) result.push({ type: "underline" });
  if (sub !== undefined && sub !== null) result.push({ type: "subsup", attrs: { type: "sub" } });
  else if (sup !== undefined && sup !== null) result.push({ type: "subsup", attrs: { type: "sup" } });
  return result.length > 0 ? result : undefined;
}

function inlineDirective(node: TextDirective, marks: Mark[], ctx: Context): AdfNode[] {
  if (node.name === "span") {
    const spanMarks = marksOfSpan(node);
    if (spanMarks) return inlineFromMdast(node.children, spanMarks.reduce(withMark, marks), ctx);
  } else {
    const dedicated = dedicatedNode(node, ctx) ?? (node.name === "media" ? mediaFromDirective(node, "mediaInline", ctx) : undefined);
    if (dedicated) return [{ ...dedicated, ...(marks.length > 0 ? { marks: [...(dedicated.marks ?? []), ...marks] } : {}) }];
    const spec = directiveSpec(node);
    if (spec) {
      if (node.children.length > 0) spec.content = inlineFromMdast(node.children, [], ctx);
      if (marks.length > 0) spec.marks = marks;
      return [finish(spec, ctx)];
    }
  }
  unknownDirective(node, ctx);
  return textNode(sourceOf(node, ctx), marks);
}

/** Markdown can nest what ADF cannot (a heading in a list item, a table in a quote); the offender is flattened to what it holds. */
function coerce(nodes: AdfNode[], allowed: Set<string>, ctx: Context): AdfNode[] {
  const out = nodes.flatMap((node) => {
    if (allowed.has(node.type)) return [node];
    ctx.warnings.push(`${node.type} is not allowed here and was flattened`);
    return node.type === "heading" ? [{ type: "paragraph", content: node.content }] : coerce(node.content ?? [], allowed, ctx);
  });
  return out.length > 0 ? out : [emptyParagraph()];
}

/** A placeholder that decodes to a block node (a mediaSingle) ends the paragraph around it. */
function paragraphFromMdast(node: Paragraph, ctx: Context): AdfNode[] {
  const out: AdfNode[] = [];
  let run: PhrasingContent[] = [];
  const flush = () => {
    const content = inlineFromMdast(run, [], ctx);
    if (content.length > 0) out.push({ type: "paragraph", content });
    run = [];
  };
  for (const child of node.children) {
    const decoded = child.type === "image" ? placeholderNode(child.url) : null;
    if (decoded && !INLINE_NODES.has(decoded.type)) {
      flush();
      out.push(decoded);
    } else {
      run.push(child);
    }
  }
  flush();
  return out;
}

/** Task items hold inline content only, so blocks nested in an item end the task list and follow it. */
function taskListFromMdast(items: ListItem[], ctx: Context): AdfNode[] {
  const out: AdfNode[] = [];
  let tasks: AdfNode[] = [];
  const flush = () => {
    if (tasks.length > 0) out.push(finish({ type: "taskList", content: tasks }, ctx));
    tasks = [];
  };
  for (const item of items) {
    const [first, ...rest] = item.children;
    const label = first?.type === "paragraph" ? first : undefined;
    const content = label ? inlineFromMdast(label.children, [], ctx) : [];
    tasks.push(finish({ type: "taskItem", attrs: { state: item.checked ? "DONE" : "TODO" }, content }, ctx));
    const nested = blocksFromMdast(label ? rest : item.children, ctx);
    if (nested.length > 0) {
      flush();
      out.push(...nested);
    }
  }
  flush();
  return out;
}

function plainListFromMdast(items: ListItem[], ordered: boolean, start: number, ctx: Context): AdfNode {
  const content = items.map((item) => ({
    type: "listItem",
    content: coerce(blocksFromMdast(item.children, ctx), LIST_ITEM_CHILDREN, ctx),
  }));
  return ordered ? { type: "orderedList", ...(start !== 1 ? { attrs: { order: start } } : {}), content } : { type: "bulletList", content };
}

/** A run of checkbox items becomes a task list, a run of the others a bullet or ordered list. */
function listFromMdast(node: List, ctx: Context): AdfNode[] {
  const isTask = (item: ListItem) => typeof item.checked === "boolean";
  const runs: ListItem[][] = [];
  for (const item of node.children) {
    const last = runs[runs.length - 1];
    if (last && isTask(last[0]) === isTask(item)) last.push(item);
    else runs.push([item]);
  }
  return runs.flatMap((items, index) =>
    isTask(items[0]) ? taskListFromMdast(items, ctx) : [plainListFromMdast(items, Boolean(node.ordered), index === 0 ? (node.start ?? 1) : 1, ctx)]
  );
}

/** The info string is `language` or `language {json attrs}`; the writer puts a language it cannot spell in the json. */
function codeFromMdast(lang: string | null | undefined, meta: string | null | undefined, value: string): AdfNode {
  const info = [lang, meta].filter(Boolean).join(" ");
  const json = lang?.startsWith("{") ? asObject(parseJson(info)) : meta ? asObject(parseJson(meta)) : {};
  const attrs = json ? { ...(lang && !lang.startsWith("{") ? { language: lang } : {}), ...json } : { language: info };
  return {
    type: "codeBlock",
    ...(Object.keys(attrs).length > 0 ? { attrs } : {}),
    content: value ? [{ type: "text", text: value }] : [],
  };
}

function tableFromMdast(node: Table, ctx: Context): AdfNode {
  return {
    type: "table",
    content: node.children.map((row, index) => ({
      type: "tableRow",
      content: row.children.map((cell) => ({
        type: index === 0 ? "tableHeader" : "tableCell",
        content: [{ type: "paragraph", content: inlineFromMdast(cell.children, [], ctx) }],
      })),
    })),
  };
}

function decodeAttr(value: string | null | undefined, kind: Kind): unknown {
  if (typeof value !== "string") return undefined;
  const numbers = value.split(",").map((part) => (part === "" ? NaN : Number(part)));
  switch (kind) {
    case "string":
      return value;
    case "number":
      return numbers.length === 1 && Number.isFinite(numbers[0]) ? numbers[0] : undefined;
    case "flag":
      return value === "" ? true : undefined;
    case "numbers":
      return numbers.every(Number.isFinite) ? numbers : undefined;
  }
}

function attrsFrom(attributes: Record<string, string | null | undefined>, spec: AttrSpec): Attrs | undefined {
  const names = Object.fromEntries(Object.entries(spec).map(([name, [key]]) => [key, name]));
  const attrs: Attrs = {};
  for (const [key, value] of Object.entries(attributes)) {
    const name = names[key];
    const decoded = name ? decodeAttr(value, spec[name][1]) : undefined;
    if (decoded === undefined) return undefined;
    attrs[name] = decoded;
  }
  return attrs;
}

const TABLE_DIRECTIVES = new Map<string, AttrSpec>([["table", TABLE_ATTRS], ["row", {}], ["cell", CELL_ATTRS]]);

/** `table`, `row` and `cell` without `adf`. A table holds either a GFM table or rows; `colwidths` is applied to the cells of each row. */
function tableDirective(node: ContainerDirective, ctx: Context): AdfNode | undefined {
  const { adf, colwidths, header, ...attributes } = node.attributes ?? {};
  const spec = TABLE_DIRECTIVES.get(node.name);
  const unset = (value: unknown) => value === undefined || value === null;
  const widths = unset(colwidths) ? [] : decodeAttr(colwidths, "numbers");
  const attrs = spec && attrsFrom(attributes, spec);
  const misplaced = !unset(adf) || (!unset(colwidths) && node.name !== "table") || (!unset(header) && node.name !== "cell");
  if (!attrs || !Array.isArray(widths) || misplaced) return undefined;
  const content = blocksFromMdast(node.children, ctx);
  const gfm = node.name === "table" && content.length === 1 && content[0].type === "table";
  const children = gfm ? content[0].content! : content;
  const expected = { table: ["tableRow"], row: ["tableCell", "tableHeader"] }[node.name as "table" | "row"];
  if (expected && (children.length === 0 || !children.every((child) => expected.includes(child.type)))) return undefined;
  const withAttrs = (type: string): AdfNode => ({ type, ...(Object.keys(attrs).length > 0 ? { attrs } : {}), content: children });
  if (node.name !== "table") return withAttrs(node.name === "row" ? "tableRow" : unset(header) ? "tableCell" : "tableHeader");
  for (const row of children) {
    row.content?.forEach((cell, index) => {
      if (isNumber(widths[index])) cell.attrs = { ...cell.attrs, colwidth: [widths[index]] };
    });
  }
  return withAttrs("table");
}

const keysOf = (spec: AttrSpec) => Object.values(spec).map(([key]) => key);

/** The attributes split over the media, border and (for a mediaSingle) mediaSingle specs; a key in none of them, or no media attribute, is not a media. */
function mediaFromDirective(node: LeafDirective | TextDirective, kind: "mediaSingle" | "media" | "mediaInline", ctx: Context): AdfNode | undefined {
  const attributes = node.attributes ?? {};
  const specs = kind === "mediaSingle" ? [MEDIA_ATTRS, BORDER_ATTRS, SINGLE_ATTRS] : [MEDIA_ATTRS, BORDER_ATTRS];
  const parts = specs.map((spec) => attrsFrom(Object.fromEntries(Object.entries(attributes).filter(([key]) => keysOf(spec).includes(key))), spec));
  if (!parts.every(Boolean) || !Object.keys(attributes).every((key) => specs.some((spec) => keysOf(spec).includes(key)))) return undefined;
  const [mediaAttrs, border, single] = parts as Attrs[];
  const alt = plainText(node.children as PhrasingContent[], ctx);
  if (Object.keys(mediaAttrs).length === 0) return undefined;
  const media: AdfNode = {
    type: kind === "mediaSingle" ? "media" : kind,
    attrs: { ...mediaAttrs, ...(alt ? { alt } : {}) },
    ...(Object.keys(border).length > 0 ? { marks: [{ type: "border", attrs: border }] } : {}),
  };
  return kind === "mediaSingle" ? { type: "mediaSingle", attrs: { layout: "center", ...single }, content: [media] } : media;
}

function mediaGroupDirective(node: ContainerDirective, ctx: Context): AdfNode | undefined {
  if (node.name !== "mediaGroup" || Object.keys(node.attributes ?? {}).length > 0) return undefined;
  const content = node.children.map((child) => (child.type === "leafDirective" && child.name === "media" ? mediaFromDirective(child, "media", ctx) : undefined));
  return content.length > 0 && content.every(Boolean) ? { type: "mediaGroup", content: content as AdfNode[] } : undefined;
}

/** `panel`, `expand` and `nestedExpand` without `adf`; a panel needs its `type`. */
function containerDirective(node: ContainerDirective, ctx: Context): AdfNode | undefined {
  const spec = CONTAINER_ATTRS[node.name];
  const attrs = spec && attrsFrom(node.attributes ?? {}, spec);
  if (!attrs || (node.name === "panel" && attrs.panelType === undefined)) return undefined;
  return { type: node.name, ...(Object.keys(attrs).length > 0 ? { attrs } : {}), content: blocksFromMdast(node.children, ctx) };
}

function directiveBlock(node: LeafDirective | ContainerDirective, ctx: Context): AdfNode[] {
  if (node.type === "containerDirective" && node.name === "marks") {
    const marks = parseJson(node.attributes?.adf);
    if (Array.isArray(marks)) return blocksFromMdast(node.children, ctx).map((child) => ({ ...child, marks: [...(child.marks ?? []), ...marks] }));
  }
  const known =
    node.type === "containerDirective"
      ? (tableDirective(node, ctx) ?? containerDirective(node, ctx) ?? mediaGroupDirective(node, ctx))
      : node.name === "media" ? mediaFromDirective(node, "mediaSingle", ctx) : undefined;
  if (known) return [known];
  const dedicated = dedicatedNode(node, ctx);
  if (dedicated) return [dedicated];
  const spec = directiveSpec(node);
  if (!spec) {
    unknownDirective(node, ctx);
    return [{ type: "paragraph", content: textNode(sourceOf(node, ctx), []) }];
  }
  if (node.type === "leafDirective") {
    if (node.children.length > 0) spec.content = inlineFromMdast(node.children, [], ctx);
  } else if (node.attributes && "inline" in node.attributes) {
    spec.content = node.children.flatMap((child) => (child.type === "paragraph" ? inlineFromMdast(child.children, [], ctx) : []));
  } else {
    spec.content = blocksFromMdast(node.children, ctx);
  }
  return [finish(spec, ctx)];
}

function blockFromMdast(node: RootContent, ctx: Context): AdfNode[] {
  switch (node.type) {
    case "paragraph":
      return paragraphFromMdast(node, ctx);
    case "heading":
      return [{ type: "heading", attrs: { level: node.depth }, content: inlineFromMdast(node.children, [], ctx) }];
    case "list":
      return listFromMdast(node, ctx);
    case "code":
      return [codeFromMdast(node.lang, node.meta, node.value)];
    case "blockquote":
      return [{ type: "blockquote", content: coerce(blocksFromMdast(node.children, ctx), QUOTE_CHILDREN, ctx) }];
    case "thematicBreak":
      return [{ type: "rule" }];
    case "table":
      return [tableFromMdast(node, ctx)];
    case "leafDirective":
    case "containerDirective":
      return directiveBlock(node, ctx);
    default:
      ctx.warnings.push(`line ${node.position?.start.line}: unsupported ${node.type} kept as text`);
      return [{ type: "paragraph", content: textNode(sourceOf(node, ctx), []) }];
  }
}

function blocksFromMdast(nodes: RootContent[], ctx: Context): AdfNode[] {
  return nodes.flatMap((node) => {
    try {
      return blockFromMdast(node, ctx);
    } catch (error) {
      ctx.warnings.push(`line ${node.position?.start.line}: ${error instanceof Error ? error.message : error}; kept as text`);
      return [{ type: "paragraph", content: textNode(sourceOf(node, ctx), []) }];
    }
  });
}

/** Never throws: what cannot be mapped becomes a paragraph of its source text, with a warning. */
export function parseMarkdown(markdown: string): ParseResult {
  const ctx: Context = { source: markdown, warnings: [], ids: 0 };
  let content: AdfNode[];
  try {
    content = blocksFromMdast(fromMarkdown(markdown, readOptions).children, ctx);
  } catch (error) {
    ctx.warnings.push(`unparseable markdown kept as text: ${error instanceof Error ? error.message : error}`);
    content = [{ type: "paragraph", content: textNode(markdown, []) }];
  }
  return { doc: { type: "doc", version: 1, content } as AdfNode, warnings: ctx.warnings };
}

export const markdownToAdf = (markdown: string): AdfNode => parseMarkdown(markdown).doc;
