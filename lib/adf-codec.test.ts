import { describe, expect, test } from "bun:test";
import { adfToEditMarkdown, markdownToAdf, parseMarkdown } from "./adf-codec";
import { equivalent } from "./adf-reconcile";
import { encodePlaceholder, type AdfNode } from "./markdown";

const doc = (...content: AdfNode[]): AdfNode => ({ type: "doc", version: 1, content } as AdfNode);
const p = (...content: AdfNode[]): AdfNode => ({ type: "paragraph", content });
const t = (text: string, ...marks: AdfNode["marks"] & object): AdfNode => ({ type: "text", text, ...(marks.length ? { marks } : {}) });
const li = (...content: AdfNode[]): AdfNode => ({ type: "listItem", content });
const mark = (type: string, attrs?: Record<string, unknown>) => ({ type, ...(attrs ? { attrs } : {}) });

const cell = (type: string, attrs: Record<string, unknown> | undefined, ...content: AdfNode[]): AdfNode => ({ type, ...(attrs ? { attrs } : {}), content });
const table = (attrs: Record<string, unknown> | undefined, ...rows: AdfNode[][]): AdfNode => ({
  type: "table",
  ...(attrs ? { attrs } : {}),
  content: rows.map((content) => ({ type: "tableRow", content })),
});

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
    "inline atoms",
    doc(
      p(
        t("see "),
        { type: "inlineCard", attrs: { url: "https://x.y/a_b?q=1&r=2" } },
        t(" "),
        t("https://x.y", mark("link", { href: "https://x.y" })),
        t(" "),
        { type: "emoji", attrs: { shortName: ":cross_mark:", id: "atlassian-cross_mark", text: ":cross_mark:" } },
        t(" "),
        { type: "mention", attrs: { id: "557058:ab", text: "@Jane Doe" } },
        t(" "),
        { type: "status", attrs: { text: "IN QA", color: "blue", style: "bold" } },
        t(" "),
        { type: "date", attrs: { timestamp: "1793664000000" } },
        t(" "),
        { type: "date", attrs: { timestamp: "1793664000001" } }
      )
    ),
    "see <https://x.y/a_b?q=1&r=2> [https://x.y](https://x.y) :emoji[:cross_mark:]{_id=atlassian-cross_mark text=:cross_mark:} " +
      ":mention[@Jane Doe]{_id=557058:ab} :status[IN QA]{color=blue style=bold} :date[2026-11-03] :date[2026-11-03]{timestamp=1793664000001}",
  ],
  [
    "color, underline and background spans",
    doc(p(t("red", mark("textColor", { color: "#ff5630" }), mark("underline"), mark("backgroundColor", { color: "#fdd0ec" })))),
    ":span[red]{color=#ff5630 underline bg=#fdd0ec}",
  ],
  [
    "block and embed cards",
    doc(
      { type: "blockCard", attrs: { url: "https://a.b/c", layout: "center" } },
      { type: "embedCard", attrs: { url: "https://a.b/d", layout: "center", width: 100, originalWidth: 853.344 } }
    ),
    "::card[https://a.b/c]{appearance=block layout=center}\n\n::card[https://a.b/d]{appearance=embed layout=center width=100 originalWidth=853.344}",
  ],
  [
    "generic node, mark and block mark",
    doc(
      { type: "panel", attrs: { panelType: "info" }, content: [p(t("hi "), { type: "futureNode", attrs: { n: 1 } })] },
      p(t("sub", mark("subsup", { type: "sub" }))),
      { type: "paragraph", marks: [mark("alignment", { align: "center" })], content: [t("mid")] }
    ),
    [
      ":::panel{adf='{\"panelType\":\"info\"}'}",
      "hi :futureNode{adf='{\"n\":1}'}",
      ":::",
      "",
      ":span[sub]{marks='[{\"type\":\"subsup\",\"attrs\":{\"type\":\"sub\"}}]'}",
      "",
      ":::marks{adf='[{\"type\":\"alignment\",\"attrs\":{\"align\":\"center\"}}]'}",
      "mid",
      ":::",
    ].join("\n"),
  ],
  [
    "table with attributes and column widths",
    doc(
      table(
        { layout: "wide", width: 760, isNumberColumnEnabled: true },
        [cell("tableHeader", { colwidth: [120] }, p(t("a | b"))), cell("tableHeader", { colwidth: [300] }, p(t("c")))],
        [cell("tableCell", { colwidth: [120] }, p(t("1"))), cell("tableCell", { colwidth: [300] }, p())]
      ),
      table(undefined, [cell("tableHeader", undefined, p(t("a")))], [cell("tableCell", undefined, p(t("b")))])
    ),
    ":::table{layout=wide width=760 numbered colwidths=120,300}\n| a \\| b | c |\n| - | - |\n| 1 | |\n:::\n\n| a |\n| - |\n| b |",
  ],
  [
    "table with spans, background, blocks and a hard break",
    doc(
      table(
        undefined,
        [cell("tableCell", undefined, p(t("a"))), cell("tableHeader", undefined, p(t("b")))],
        [cell("tableCell", { colspan: 2, background: "#e3fcef" }, p(t("x"), { type: "hardBreak" }, t("y")), { type: "bulletList", content: [li(p(t("i")))] })]
      )
    ),
    [":::::table", "::::row", ":::cell", "a", ":::", "", ":::cell{header}", "b", ":::", "::::", "", "::::row", ":::cell{colspan=2 bg=#e3fcef}", "x\\", "y", "", "- i", ":::", "::::", ":::::"].join("\n"),
  ],
  [
    "a table with an unknown attribute uses the generic rule",
    doc(table({ extra: 1 }, [cell("tableCell", { colspan: 2 }, p(t("c")))])),
    [":::::table{adf='{\"extra\":1}'}", "::::tableRow", ":::tableCell{adf='{\"colspan\":2}'}", "c", ":::", "::::", ":::::"].join("\n"),
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

  test("an edited date label wins over a stale timestamp", () => {
    expect(markdownToAdf(":date[2026-11-04]{timestamp=1793664000000}").content).toEqual([p({ type: "date", attrs: { timestamp: "1793750400000" } })]);
  });

  test("prose that only resembles a dedicated directive stays text", () => {
    const { doc: result, warnings } = parseMarkdown(":mention :date[soon] :status[x]{size=1}");
    expect(result.content).toEqual([p(t(":mention :date[soon] :status[x]{size=1}"))]);
    expect(warnings).toHaveLength(3);
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
  const pieces = ["**", "_", "|", "- ", "1. ", "> ", "# ", "`", "```", "[", "](", "]", ":", ":::", "::", "{", "}", "\\", "\n", "\n\n", "  \n", "~~", "![", "<", "&", " ", "- [ ] ", "---", "a", ":x[", "adf='", "<http://x>", ":date[2026-01-01]", ":emoji[:a:]{_id=1}", "::card[http://x]{appearance=block}", ":span[a]{bg=#fff underline}", ":::table{numbered colwidths=1,x}", "::::row", ":::cell{header colspan=2}", "| a | b |\n| - | - |\n"];
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
