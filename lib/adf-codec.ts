import { fromMarkdown } from "mdast-util-from-markdown";
import { toMarkdown, type Options as ToMarkdownOptions } from "mdast-util-to-markdown";
import { gfm } from "micromark-extension-gfm";
import { gfmFromMarkdown, gfmToMarkdown } from "mdast-util-gfm";
import { directive } from "micromark-extension-directive";
import { directiveFromMarkdown, directiveToMarkdown } from "mdast-util-directive";
import type { ContainerDirective, LeafDirective, TextDirective } from "mdast-util-directive";
import type { List, ListItem, Paragraph, PhrasingContent, Root, RootContent, Table } from "mdast";
import { mergeText } from "./adf-reconcile";
import { decodeMediaPlaceholder, encodePlaceholder, type AdfNode } from "./markdown";

type Mark = NonNullable<AdfNode["marks"]>[number];
type Attrs = Record<string, unknown>;
type Directive = LeafDirective | ContainerDirective | TextDirective;
type Context = { source: string; warnings: string[] };
type Wrapper = { key: string; make: (children: PhrasingContent[]) => PhrasingContent };

export type ParseResult = { doc: AdfNode; warnings: string[] };

/** Node types that can have no attributes: only these are written, and read, as a directive without `adf`. */
const ATTRLESS_NODES = new Set(
  ("paragraph hardBreak table tableRow tableCell tableHeader mediaGroup layoutSection extensionFrame caption taskList " +
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

/** A custom mdast node written verbatim, so a placeholder keeps the `![label](tikmedia:…)` form that `makeMediaPlaceholder` produces. */
const placeholderOf = (node: AdfNode) => ({ type: "placeholder", value: encodePlaceholder(node) }) as unknown as PhrasingContent;
const writePlaceholder = Object.assign((node: { value: string }) => node.value, { peek: () => "!" });

function blocksToMdast(nodes: AdfNode[] = []): RootContent[] {
  return nodes.map(blockToMdast);
}

function blockToMdast(node: AdfNode): RootContent {
  if (MEDIA_NODES.has(node.type)) return { type: "paragraph", children: [placeholderOf(node)] };
  if (node.marks?.length) {
    return {
      type: "containerDirective",
      name: "marks",
      attributes: { adf: encodeJson(node.marks) },
      children: [blockToMdast({ ...node, marks: undefined })] as ContainerDirective["children"],
    };
  }
  return nativeBlock(node) ?? genericBlock(node);
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
      return valid && children.length ? { type: "heading", depth: level as 1, children: inlineToMdast(children, true) } : undefined;
    }
    case "bulletList":
    case "orderedList":
      return listToMdast(node);
    case "codeBlock":
      return codeToMdast(node);
    case "blockquote":
      return noAttrs(node) && children.length ? { type: "blockquote", children: blocksToMdast(children) as never } : undefined;
    case "rule":
      return noAttrs(node) && !children.length ? { type: "thematicBreak" } : undefined;
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
  if (marks.length > 0) {
    const encoded = encodeJson(marks);
    chain.push({ key: `span ${encoded}`, make: (children) => ({ type: "textDirective", name: "span", attributes: { marks: encoded }, children }) });
  }
  return { chain, code: Boolean(code) };
}

/** A hard break at the end of a block or inside a heading has no markdown form, so it is written as `:hardBreak`. */
function leafToMdast(node: AdfNode, asDirective: boolean, code: boolean): PhrasingContent {
  if (node.type === "text") return code ? { type: "inlineCode", value: node.text ?? "" } : { type: "text", value: node.text ?? "" };
  if (node.type === "mediaInline") return placeholderOf(node);
  if (node.type === "hardBreak" && noAttrs(node) && !asDirective) return { type: "break" };
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
  extensions: [...gfmWriter, directiveToMarkdown({ quote: "'" })],
  handlers: { placeholder: writePlaceholder } as ToMarkdownOptions["handlers"],
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

function finish(node: AdfNode): AdfNode {
  if (LOCAL_ID_NODES.has(node.type)) node.attrs = { localId: crypto.randomUUID(), ...node.attrs };
  return node;
}

function placeholderNode(url: string): AdfNode | null {
  const match = url.match(/^(?:tikmedia|tikadf):([A-Za-z0-9+/=]+)$/);
  return match ? decodeMediaPlaceholder(match[1]) : null;
}

function unknownDirective(node: Directive, ctx: Context): void {
  ctx.warnings.push(`line ${node.position?.start.line}: unknown directive "${node.name}" kept as text`);
}

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

function inlineDirective(node: TextDirective, marks: Mark[], ctx: Context): AdfNode[] {
  if (node.name === "span") {
    const spanMarks = parseJson(node.attributes?.marks);
    if (Array.isArray(spanMarks)) {
      const valid = spanMarks.filter((mark): mark is Mark => typeof mark?.type === "string");
      return inlineFromMdast(node.children, valid.reduce(withMark, marks), ctx);
    }
  } else {
    const spec = directiveSpec(node);
    if (spec) {
      if (node.children.length > 0) spec.content = inlineFromMdast(node.children, [], ctx);
      if (marks.length > 0) spec.marks = marks;
      return [finish(spec)];
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
    if (tasks.length > 0) out.push(finish({ type: "taskList", content: tasks }));
    tasks = [];
  };
  for (const item of items) {
    const [first, ...rest] = item.children;
    const label = first?.type === "paragraph" ? first : undefined;
    const content = label ? inlineFromMdast(label.children, [], ctx) : [];
    tasks.push(finish({ type: "taskItem", attrs: { state: item.checked ? "DONE" : "TODO" }, content }));
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

function directiveBlock(node: LeafDirective | ContainerDirective, ctx: Context): AdfNode[] {
  if (node.type === "containerDirective" && node.name === "marks") {
    const marks = parseJson(node.attributes?.adf);
    if (Array.isArray(marks)) return blocksFromMdast(node.children, ctx).map((child) => ({ ...child, marks: [...(child.marks ?? []), ...marks] }));
  }
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
  return [finish(spec)];
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
  const ctx: Context = { source: markdown, warnings: [] };
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
