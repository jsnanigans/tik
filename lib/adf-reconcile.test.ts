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
