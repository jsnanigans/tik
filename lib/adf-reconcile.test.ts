import { describe, expect, test } from "bun:test";
import { adfToEditMarkdown, markdownToAdf } from "./adf-codec";
import { lostConstructs, reconcile, replaceInText } from "./adf-reconcile";
import type { AdfNode } from "./markdown";

const text = (value: string, marks?: AdfNode["marks"]): AdfNode => ({ type: "text", text: value, ...(marks ? { marks } : {}) });
const p = (...content: AdfNode[]): AdfNode => ({ type: "paragraph", content });
const doc = (...content: AdfNode[]): AdfNode => ({ type: "doc", version: 1, content } as AdfNode);
const panel = (...content: AdfNode[]): AdfNode => ({ type: "panel", attrs: { panelType: "info" }, content });
const task = (localId: string, value: string): AdfNode => ({ type: "taskItem", attrs: { localId, state: "TODO" }, content: [text(value)] });

const original = doc(
  p(text("one")),
  panel(p(text("keep"))),
  { type: "taskList", attrs: { localId: "list-1" }, content: [task("a", "first"), task("b", "second")] },
  p(text("last")),
  p()
);
const edit = (change: (md: string) => string) => reconcile(original, markdownToAdf(change(adfToEditMarkdown(original))));

describe("reconcile", () => {
  test("no-op returns the original", () => {
    expect(edit((md) => md).doc).toBe(original);
  });

  test("an edit keeps every other node, localIds included", () => {
    const { doc: result } = edit((md) => md.replace("second", "2nd"));
    expect(result.content![0]).toBe(original.content![0]);
    expect(result.content![1]).toBe(original.content![1]);
    expect(result.content![2].content![0]).toBe(original.content![2].content![0]);
    expect(result.content![2].attrs).toEqual({ localId: "list-1" });
    expect(result.content![2].content![1]).toEqual(task("b", "2nd"));
    expect(result.content![4]).toBe(original.content![4]);
  });

  test("a deleted block is removed and the rest stays", () => {
    const { doc: result } = edit((md) => md.replace("one\n\n", ""));
    expect(result.content![0]).toBe(original.content![1]);
  });
});

describe("reconcile in tables", () => {
  const cellOf = (type: string, localId: string, value: string): AdfNode => ({
    type, attrs: { colwidth: [100], localId }, content: [p(text(value))],
  });
  const grid = doc({
    type: "table",
    attrs: { layout: "default", isNumberColumnEnabled: false, localId: "t" },
    content: [
      { type: "tableRow", attrs: { localId: "r1" }, content: [cellOf("tableHeader", "h", "head")] },
      { type: "tableRow", attrs: { localId: "r2" }, content: [cellOf("tableCell", "c", "cell")] },
    ],
  });

  test("editing a cell keeps the table, row and cell attributes", () => {
    const md = adfToEditMarkdown(grid);
    expect(md).toContain("colwidths=100");
    const { doc: result, changes } = reconcile(grid, markdownToAdf(md.replace("| cell |", "| edited |")));
    expect(changes).toEqual(["1.2.1.1 paragraph changed"]);
    expect(result.content![0].attrs).toEqual(grid.content![0].attrs);
    expect(result.content![0].content![0]).toBe(grid.content![0].content![0]);
    expect(result.content![0].content![1].attrs).toEqual({ localId: "r2" });
    expect(result.content![0].content![1].content![0]).toEqual(cellOf("tableCell", "c", "edited"));
  });
});

describe("reconcile in macros", () => {
  const macro = doc({
    type: "bodiedExtension",
    attrs: { extensionType: "com.x", extensionKey: "details", localId: "m" },
    content: [{ ...p(text("one")), attrs: { localId: "p1" } }, p(text("two"))],
  });

  test("editing inside a macro keeps the macro and its other children", () => {
    const { doc: result } = reconcile(macro, markdownToAdf(adfToEditMarkdown(macro).replace("two", "2")));
    expect(result.content![0].attrs).toBe(macro.content![0].attrs);
    expect(result.content![0].content![0]).toBe(macro.content![0].content![0]);
    expect(result.content![0].content![1]).toEqual(p(text("2")));
  });
});

describe("lostConstructs", () => {
  test("names the panel when it is dropped, nothing when it is kept", () => {
    expect(lostConstructs(original, doc(p(text("one"))))).toContain("panel");
    expect(lostConstructs(original, edit((md) => md.replace("one", "uno")).doc)).toEqual([]);
  });
});

describe("replaceInText", () => {
  test("replaces inside one run", () => {
    const { doc: result, count } = replaceInText(doc(p(text("a FEWEB-1 b"))), "FEWEB-1", "FEWEB-2");
    expect(count).toBe(1);
    expect(result.content![0].content![0].text).toBe("a FEWEB-2 b");
  });

  test("reports a match split across marks", () => {
    const split = doc(p(text("foo "), text("bar", [{ type: "strong" }])));
    expect(replaceInText(split, "foo bar", "x")).toMatchObject({ count: 0, crossing: 1 });
  });
});
