import type { AdfNode } from "./markdown";

type Mark = NonNullable<AdfNode["marks"]>[number];

const MARK_ORDER = ["link", "strong", "em", "strike", "underline", "textColor", "backgroundColor", "subsup", "code"];

export const DEFAULT_ATTRS: Record<string, Record<string, unknown>> = {
  orderedList: { order: 1 },
  table: { isNumberColumnEnabled: false, layout: "default" },
  tableCell: { colspan: 1, rowspan: 1 },
  tableHeader: { colspan: 1, rowspan: 1 },
  mention: { accessLevel: "" },
};

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => [k, sortKeys(v)])
    );
  }
  return value;
}

function canonicalAttrs(type: string, attrs: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!attrs) return undefined;
  const defaults = DEFAULT_ATTRS[type] ?? {};
  const kept = Object.entries(attrs).filter(
    ([name, value]) => name !== "localId" && value !== undefined && defaults[name] !== value
  );
  return kept.length > 0 ? (sortKeys(Object.fromEntries(kept)) as Record<string, unknown>) : undefined;
}

function markRank(mark: Mark): number {
  const rank = MARK_ORDER.indexOf(mark.type);
  return rank === -1 ? MARK_ORDER.length : rank;
}

function canonicalMarks(marks: AdfNode["marks"]): AdfNode["marks"] {
  if (!marks?.length) return undefined;
  return marks
    .map((mark) => {
      const attrs = canonicalAttrs(mark.type, mark.attrs);
      return attrs ? { type: mark.type, attrs } : { type: mark.type };
    })
    .sort((a, b) => markRank(a) - markRank(b) || (a.type < b.type ? -1 : a.type > b.type ? 1 : 0));
}

export function mergeText(nodes: AdfNode[]): AdfNode[] {
  const merged: AdfNode[] = [];
  for (const node of nodes) {
    const prev = merged[merged.length - 1];
    if (prev?.type === "text" && node.type === "text" && JSON.stringify(prev.marks) === JSON.stringify(node.marks)) {
      prev.text = `${prev.text}${node.text}`;
    } else {
      merged.push(node);
    }
  }
  return merged;
}

function isEmptyParagraph(node: AdfNode): boolean {
  return node.type === "paragraph" && !node.content?.length;
}

/** Normal form for comparing two ADF trees; see requirements.md section 5. */
export function canonicalize(node: AdfNode): AdfNode {
  const out: AdfNode = { type: node.type };
  const attrs = canonicalAttrs(node.type, node.attrs);
  if (attrs) out.attrs = attrs;
  if (node.text !== undefined) out.text = node.text;
  const marks = canonicalMarks(node.marks);
  if (marks) out.marks = marks;
  let content = mergeText((node.content ?? []).filter((child) => child.text !== "").map(canonicalize));
  if (node.type === "doc") {
    while (content.length > 0 && isEmptyParagraph(content[content.length - 1])) content = content.slice(0, -1);
  }
  if (content.length > 0) out.content = content;
  return out;
}

export function equivalent(a: AdfNode, b: AdfNode): boolean {
  return JSON.stringify(canonicalize(a)) === JSON.stringify(canonicalize(b));
}

/** Counts of node types, mark types and attributes in a document, keyed by name. */
export function constructs(adf: AdfNode): Map<string, number> {
  const counts = new Map<string, number>();
  const add = (key: string, n = 1) => counts.set(key, (counts.get(key) ?? 0) + n);
  const walk = (node: AdfNode) => {
    if (node.text !== undefined) add("text chars", node.text.length);
    else add(node.type);
    for (const name of Object.keys(node.attrs ?? {})) add(`${node.type}.${name}`);
    for (const mark of node.marks ?? []) add(`mark:${mark.type}`);
    node.content?.forEach(walk);
  };
  walk(canonicalize(adf));
  return counts;
}

/** Node types, mark types and attributes present in the original and absent from the result. */
export function lostConstructs(original: AdfNode, result: AdfNode): string[] {
  const kept = constructs(result);
  return [...constructs(original).keys()].filter((key) => key !== "text chars" && !kept.has(key));
}

const CONTAINERS = new Set([
  "bulletList", "orderedList", "listItem", "blockquote", "panel", "expand", "nestedExpand", "table", "tableRow",
  "tableCell", "tableHeader", "taskList", "decisionList", "layoutSection", "layoutColumn",
]);

function trailingEmpty(doc: AdfNode): number {
  const content = doc.content ?? [];
  let count = 0;
  while (count < content.length && isEmptyParagraph(content[content.length - 1 - count])) count++;
  return count;
}

const keyOf = (node: AdfNode) => JSON.stringify(canonicalize(node));

function commonPairs(a: string[], b: string[]): [number, number][] {
  const length = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      length[i][j] = a[i] === b[j] ? length[i + 1][j + 1] + 1 : Math.max(length[i + 1][j], length[i][j + 1]);
    }
  }
  const pairs: [number, number][] = [];
  for (let i = 0, j = 0; i < a.length && j < b.length; ) {
    if (a[i] === b[j]) pairs.push([i++, j++]);
    else if (length[i + 1][j] >= length[i][j + 1]) i++;
    else j++;
  }
  return pairs;
}

function keepLocalId(original: AdfNode, edited: AdfNode): AdfNode {
  const localId = original.attrs?.localId;
  return localId !== undefined && edited.attrs ? { ...edited, attrs: { ...edited.attrs, localId } } : edited;
}

function pairNodes(original: AdfNode, edited: AdfNode, path: string, changes: string[]): AdfNode {
  if (original.type !== edited.type) {
    changes.push(`${path} ${original.type} -> ${edited.type}`);
    return edited;
  }
  const node = keepLocalId(original, edited);
  if (!CONTAINERS.has(edited.type)) {
    changes.push(`${path} ${edited.type} changed`);
    return node;
  }
  const content = align(original.content ?? [], edited.content ?? [], `${path}.`, changes);
  return content.length > 0 ? { ...node, content } : { ...node, content: undefined };
}

/** Result blocks reuse the original node wherever an equivalent one exists, so ids and attributes survive. */
function align(original: AdfNode[], edited: AdfNode[], path: string, changes: string[]): AdfNode[] {
  const result: AdfNode[] = [];
  let i = 0;
  let j = 0;
  const anchors = [...commonPairs(original.map(keyOf), edited.map(keyOf)), [original.length, edited.length]];
  for (const [anchorOriginal, anchorEdited] of anchors) {
    const gap = Math.max(anchorOriginal - i, anchorEdited - j);
    for (let k = 0; k < gap; k++) {
      const [before, after] = [original[i + k], edited[j + k]];
      if (i + k < anchorOriginal && j + k < anchorEdited) {
        result.push(pairNodes(before, after, `${path}${result.length + 1}`, changes));
      } else if (j + k < anchorEdited) {
        changes.push(`${path}${result.length + 1} ${after.type} added`);
        result.push(after);
      } else {
        changes.push(`${path}${i + k + 1} ${before.type} removed (original position)`);
      }
    }
    if (anchorOriginal < original.length) result.push(original[anchorOriginal]);
    i = anchorOriginal + 1;
    j = anchorEdited + 1;
  }
  return result;
}

/** Aligns the edited document with the original and returns the original nodes for everything that did not change, trailing empty paragraphs included. */
export function reconcile(original: AdfNode, edited: AdfNode): { doc: AdfNode; changes: string[] } {
  if (equivalent(original, edited)) return { doc: original, changes: [] };
  const changes: string[] = [];
  const blocks = (doc: AdfNode) => (doc.content ?? []).slice(0, (doc.content ?? []).length - trailingEmpty(doc));
  const tail = (original.content ?? []).slice(blocks(original).length);
  const content = [...align(blocks(original), blocks(edited), "", changes), ...tail];
  return { doc: { ...original, content }, changes };
}

/** Replaces `search` inside single text runs only. `crossing` counts matches that span several runs. */
export function replaceInText(adf: AdfNode, search: string, replacement: string) {
  let count = 0;
  let crossing = 0;
  const occurrences = (text: string) => text.split(search).length - 1;
  const walk = (node: AdfNode): AdfNode => {
    if (node.text !== undefined) {
      const found = occurrences(node.text);
      count += found;
      return found > 0 ? { ...node, text: node.text.split(search).join(replacement) } : node;
    }
    if (!node.content) return node;
    const runs = node.content.filter((child) => child.text !== undefined);
    const joined = node.content.map((child) => child.text ?? "\0").join("");
    crossing += occurrences(joined) - runs.reduce((sum, run) => sum + occurrences(run.text!), 0);
    return { ...node, content: node.content.map(walk).filter((child) => child.text !== "") };
  };
  const doc = walk(adf);
  return { doc, count, crossing };
}
