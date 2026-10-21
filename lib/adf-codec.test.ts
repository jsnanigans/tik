import { describe, expect, test } from "bun:test";
import { adfToEditMarkdown, markdownToAdf, parseMarkdown } from "./adf-codec";
import { equivalent } from "./adf-reconcile";
import { encodePlaceholder, type AdfNode } from "./markdown";

const doc = (...content: AdfNode[]): AdfNode => ({ type: "doc", version: 1, content } as AdfNode);
const p = (...content: AdfNode[]): AdfNode => ({ type: "paragraph", content });
const t = (text: string, ...marks: AdfNode["marks"] & object): AdfNode => ({ type: "text", text, ...(marks.length ? { marks } : {}) });
const li = (...content: AdfNode[]): AdfNode => ({ type: "listItem", content });
const mark = (type: string, attrs?: Record<string, unknown>) => ({ type, ...(attrs ? { attrs } : {}) });

const media: AdfNode = {
  type: "mediaSingle",
  attrs: { layout: "center" },
  content: [{ type: "media", attrs: { id: "1", type: "file", collection: "c" } }],
};

const dialect: [string, AdfNode, string][] = [
  ["heading and paragraph", doc({ type: "heading", attrs: { level: 2 }, content: [t("Title")] }, p(t("text"))), "## Title\n\ntext"],
  [
    "nested marks",
    doc(p(t("a "), t("b", mark("strong")), t(" "), t("c", mark("strong"), mark("em")), t(" "), t("d", mark("link", { href: "https://x.y", title: "T" }), mark("strong")), t(" "), t("e", mark("strike")), t(" "), t("f", mark("code")))),
    'a **b** **_c_** [**d**](https://x.y "T") ~~e~~ `f`',
  ],
  ["hard break, also trailing", doc(p(t("a"), { type: "hardBreak" }, t("b"), { type: "hardBreak" })), "a\\\nb:hardBreak[]"],
  [
    "lists",
    doc(
      { type: "bulletList", content: [li(p(t("a")), { type: "bulletList", content: [li(p(t("b")))] }), li(p(t("c")), p(t("d")))] },
      { type: "orderedList", attrs: { order: 3 }, content: [li(p(t("x"))), li(p(t("y")))] }
    ),
    "- a\n  - b\n\n- c\n\n  d\n\n3. x\n4. y",
  ],
  [
    "code blocks",
    doc({ type: "codeBlock", attrs: { language: "ts", wrap: true }, content: [t("a\n```")] }, { type: "codeBlock", content: [] }),
    '````ts {"wrap":true}\na\n```\n````\n\n```\n```',
  ],
  ["quote and rule", doc({ type: "blockquote", content: [p(t("q1")), p(t("q2"))] }, { type: "rule" }), "> q1\n>\n> q2\n\n---"],
  ["empty paragraph", doc(p(t("a")), p(), p(t("b"))), "a\n\n::paragraph\n\nb"],
  ["literal markup", doc(p(t("- not a list *nor em* :foo[x] | `c` [a](b)"))), "\\- not a list \\*nor em\\* \\:foo\\[x] | \\`c\\` \\[a]\\(b)"],
  ["media placeholder", doc(media), encodePlaceholder(media)],
  [
    "generic node, mark and block mark",
    doc(
      { type: "panel", attrs: { panelType: "info" }, content: [p(t("hi "), { type: "mention", attrs: { id: "5", text: "@Jane" } })] },
      p(t("red", mark("textColor", { color: "#f00" }))),
      { type: "paragraph", marks: [mark("alignment", { align: "center" })], content: [t("mid")] }
    ),
    [
      ":::panel{adf='{\"panelType\":\"info\"}'}",
      "hi :mention{adf='{\"id\":\"5\",\"text\":\"@Jane\"}'}",
      ":::",
      "",
      ":span[red]{marks='[{\"type\":\"textColor\",\"attrs\":{\"color\":\"#f00\"}}]'}",
      "",
      ":::marks{adf='[{\"type\":\"alignment\",\"attrs\":{\"align\":\"center\"}}]'}",
      "mid",
      ":::",
    ].join("\n"),
  ],
  [
    "nested generic nodes",
    doc({ type: "table", content: [{ type: "tableRow", content: [{ type: "tableCell", attrs: { colspan: 2 }, content: [p(t("c"))] }] }] }),
    [":::::table", "::::tableRow", ":::tableCell{adf='{\"colspan\":2}'}", "c", ":::", "::::", ":::::"].join("\n"),
  ],
];

describe("dialect", () => {
  test.each(dialect)("%s", (_name, adf, markdown) => {
    expect(adfToEditMarkdown(adf)).toBe(markdown);
    expect(equivalent(parseMarkdown(markdown).doc, adf)).toBe(true);
  });
});

describe("reader", () => {
  test("unknown directives become text with a warning", () => {
    const { doc: result, warnings } = parseMarkdown(":D\n\n:::note\nx\n:::");
    expect(result.content?.map((block) => block.content?.[0].text)).toEqual([":D", ":::note\nx\n:::"]);
    expect(warnings).toHaveLength(2);
  });

  test("a heading in a list item is flattened to a paragraph", () => {
    const { doc: result, warnings } = parseMarkdown("- # a\n- `**x**`");
    expect(result.content?.[0].content?.[0].content?.[0]).toEqual(p(t("a")));
    expect(warnings).toHaveLength(1);
  });

  test("code with a mark ADF forbids next to it keeps only code", () => {
    expect(markdownToAdf("**`x`**").content).toEqual([p(t("x", mark("code")))]);
  });
});

const goldenFiles = ["ticket-pmp-1838", "agents-examples", "edge-cases"];

describe.each(goldenFiles)("golden %s", (file) => {
  const cases: { name: string; markdown: string; adf: AdfNode }[] = require(`./fixtures/${file}.json`);
  test.each(cases.map((c) => [c.name, c] as const))("%s", (_name, { markdown, adf }) => {
    expect(equivalent(markdownToAdf(markdown), adf)).toBe(true);
  });
});

describe("fuzz", () => {
  const pieces = ["**", "_", "|", "- ", "1. ", "> ", "# ", "`", "```", "[", "](", "]", ":", ":::", "::", "{", "}", "\\", "\n", "\n\n", "  \n", "~~", "![", "<", "&", " ", "- [ ] ", "---", "a", ":x[", "adf='"];
  const inputs: string[] = pieces.flatMap((a) => pieces.map((b) => a + b));
  let seed = 7;
  const next = (n: number) => (seed = (seed * 48271) % 2147483647) % n;
  for (let i = 0; i < 1500; i++) inputs.push(Array.from({ length: 6 }, () => pieces[next(pieces.length)]).join(""));

  test("never throws and a second round trip is stable", () => {
    for (const input of inputs) {
      const once = parseMarkdown(input).doc;
      const twice = markdownToAdf(adfToEditMarkdown(once));
      if (!equivalent(once, twice)) throw new Error(`unstable: ${JSON.stringify(input)}`);
    }
  });
});
