import type { AdfNode } from "./markdown";

type Mark = NonNullable<AdfNode["marks"]>[number];

const MARK_ORDER = ["link", "strong", "em", "strike", "underline", "textColor", "backgroundColor", "subsup", "code"];

const DEFAULT_ATTRS: Record<string, Record<string, unknown>> = {
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

function mergeText(nodes: AdfNode[]): AdfNode[] {
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
